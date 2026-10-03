import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Box, Text, useInput } from "ink";
import type { Job } from "@qoren/sdk";
import { currentStep, emptyLine, type LineState } from "./model.js";
import { describeError, useSession } from "./store.js";
import {
  ACCENT,
  Choices,
  Field,
  Hints,
  Spinner,
  navigate,
} from "./ui.js";

// Asking a question in a console.
//
// A pane should be able to say "get me a name, then a size, then follow this
// job" as five lines of straight-line async code, the way the commands do. The
// alternative — every pane hand-rolling its own modal state machine — is where
// TUIs go to become unmaintainable. So each ask returns a promise, the overlay
// it opens is rendered in place of the pane body, and every keystroke goes to
// the overlay while it is open.
//
// Cancelling always resolves rather than rejecting: a person pressing escape
// has not caused an error, and making every call site wrap a try/catch to
// discover that would be backwards.

export type Choice<T> = {
  item: T;
  label: string;
  detail?: string;
  hint?: string;
};

export type JobOutcome =
  | { status: "done"; job: Job }
  | { status: "failed"; message: string }
  /** The reader stopped watching. The job itself is untouched and still
   * running; `jobs watch` or the Jobs pane picks it back up. */
  | { status: "detached" };

type Ask = {
  prompt: (spec: {
    title: string;
    label?: string;
    initial?: string;
    placeholder?: string;
    /** Return a sentence to refuse the value, or null to accept it. */
    validate?: (value: string) => string | null;
  }) => Promise<string | null>;
  confirm: (spec: {
    title: string;
    body?: string;
    danger?: boolean;
    /** Make it deliberate: the reader must type this exactly. For destroying
     * an environment, which takes its agents with it. */
    requireText?: string;
  }) => Promise<boolean>;
  select: <T>(spec: {
    title: string;
    choices: Choice<T>[];
    initial?: number;
  }) => Promise<T | null>;
  /** Follow a job to its end, drawing each step as it starts. */
  job: (jobId: string, title: string) => Promise<JobOutcome>;
  /** Show a block of text — a log, command output, a diagnosis. */
  show: (title: string, body: string) => Promise<void>;
  /** A one-line result in the status bar. Clears itself. */
  toast: (message: string, tone?: "good" | "bad") => void;
};

type Ui = Ask & {
  /** What to draw instead of the pane body, or null when nothing is being
   * asked. */
  overlay: ReactNode | null;
  /** True while an overlay owns the keyboard, so panes stand down. */
  busy: boolean;
  notice: { message: string; tone: "good" | "bad" } | null;
};

const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("useUi outside a UiProvider");
  return ui;
}

type Pending = {
  render: (done: (value: unknown) => void) => ReactNode;
  resolve: (value: unknown) => void;
};

export function UiProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<Ui["notice"]>(null);
  const noticeTimer = useRef<NodeJS.Timeout | undefined>(undefined);

  const open = useCallback(
    <R,>(render: (done: (value: R) => void) => ReactNode): Promise<R> =>
      new Promise<R>((resolve) => {
        setPending({
          render: render as Pending["render"],
          resolve: resolve as Pending["resolve"],
        });
      }),
    [],
  );

  const toast = useCallback((message: string, tone: "good" | "bad" = "good") => {
    setNotice({ message, tone });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      setNotice(null);
    }, 6_000);
  }, []);

  useEffect(
    () => () => {
      clearTimeout(noticeTimer.current);
    },
    [],
  );

  const api = useMemo<Ask>(
    () => ({
      prompt: (spec) =>
        open<string | null>((done) => <PromptBox spec={spec} done={done} />),
      confirm: (spec) =>
        open<boolean>((done) => <ConfirmBox spec={spec} done={done} />),
      select: <T,>(spec: {
        title: string;
        choices: Choice<T>[];
        initial?: number;
      }) => open<T | null>((done) => <SelectBox spec={spec} done={done} />),
      job: (jobId, title) =>
        open<JobOutcome>((done) => (
          <JobBox jobId={jobId} title={title} done={done} />
        )),
      show: (title, body) =>
        open<void>((done) => <ShowBox title={title} body={body} done={done} />),
      toast,
    }),
    [open, toast],
  );

  const done = useCallback(
    (value: unknown) => {
      const current = pending;
      setPending(null);
      current?.resolve(value);
    },
    [pending],
  );

  const value: Ui = {
    ...api,
    overlay: pending ? pending.render(done) : null,
    busy: pending !== null,
    notice,
  };

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

// ---- the boxes -----------------------------------------------------------

function Frame({
  title,
  danger,
  children,
  hints,
}: {
  title: string;
  danger?: boolean;
  children: ReactNode;
  hints: [string, string][];
}) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={danger ? "red" : ACCENT}
      paddingX={1}
    >
      <Text bold color={danger ? "red" : ACCENT}>
        {title}
      </Text>
      <Box flexDirection="column" flexGrow={1} paddingTop={1}>
        {children}
      </Box>
      <Hints keys={hints} />
    </Box>
  );
}

function PromptBox({
  spec,
  done,
}: {
  spec: {
    title: string;
    label?: string;
    initial?: string;
    placeholder?: string;
    validate?: (value: string) => string | null;
  };
  done: (value: string | null) => void;
}) {
  const [line, setLine] = useState<LineState>(() => emptyLine(spec.initial));
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <Frame
      title={spec.title}
      hints={[
        ["enter", "confirm"],
        ["esc", "cancel"],
      ]}
    >
      <Box>
        {spec.label ? <Text dimColor>{`${spec.label}  `}</Text> : null}
        <Field
          value={line}
          onChange={(next) => {
            setProblem(null);
            setLine(next);
          }}
          placeholder={spec.placeholder ?? ""}
          onSubmit={(value) => {
            const trimmed = value.trim();
            const refusal = spec.validate?.(trimmed) ?? null;
            if (refusal) {
              setProblem(refusal);
              return;
            }
            done(trimmed);
          }}
          onCancel={() => {
            done(null);
          }}
        />
      </Box>
      {problem ? <Text color="red">{problem}</Text> : null}
    </Frame>
  );
}

function ConfirmBox({
  spec,
  done,
}: {
  spec: {
    title: string;
    body?: string;
    danger?: boolean;
    requireText?: string;
  };
  done: (value: boolean) => void;
}) {
  const [line, setLine] = useState<LineState>(() => emptyLine());

  // A plain yes/no needs no field, so it answers to a single keystroke. The
  // default is always no: an accidental return should never destroy anything.
  useInput(
    (input, key) => {
      if (input === "y" || input === "Y") {
        done(true);
        return;
      }
      // Escape, "n", and a bare return all mean no.
      if (key.escape || key.return || input === "n" || input === "N") {
        done(false);
      }
    },
    { isActive: !spec.requireText },
  );

  return (
    <Frame
      title={spec.title}
      danger={spec.danger}
      hints={
        spec.requireText
          ? [
              ["enter", "confirm"],
              ["esc", "cancel"],
            ]
          : [
              ["y", "yes"],
              ["n", "no"],
              ["esc", "cancel"],
            ]
      }
    >
      {spec.body ? <Text>{spec.body}</Text> : null}
      {spec.requireText ? (
        <Box paddingTop={1}>
          <Text dimColor>{`Type ${spec.requireText} to confirm  `}</Text>
          <Field
            value={line}
            onChange={setLine}
            onSubmit={(value) => {
              done(value.trim() === spec.requireText);
            }}
            onCancel={() => {
              done(false);
            }}
          />
        </Box>
      ) : (
        <Box paddingTop={1}>
          <Text dimColor>y / n</Text>
        </Box>
      )}
    </Frame>
  );
}

function SelectBox<T>({
  spec,
  done,
}: {
  spec: { title: string; choices: Choice<T>[]; initial?: number };
  done: (value: T | null) => void;
}) {
  const [selected, setSelected] = useState(spec.initial ?? 0);

  useInput((input, key) => {
    if (key.escape) {
      done(null);
      return;
    }
    if (key.return) {
      const choice = spec.choices[selected];
      done(choice ? choice.item : null);
      return;
    }
    const next = navigate(spec.choices.length, selected, input, key);
    if (next !== null) setSelected(next);
  });

  return (
    <Frame
      title={spec.title}
      hints={[
        ["up/down", "move"],
        ["enter", "choose"],
        ["esc", "cancel"],
      ]}
    >
      <Choices
        items={spec.choices}
        selected={selected}
        height={12}
        render={(choice) => ({
          label: choice.label,
          ...(choice.detail !== undefined ? { detail: choice.detail } : {}),
        })}
        hint={(choice) => choice.hint}
      />
    </Frame>
  );
}

/**
 * Follow a job.
 *
 * The same shape as `followJob` in the command line: one line per step, printed
 * when the step starts, because a redrawn progress bar tells you less than a
 * list of what has actually been done. Escape detaches without cancelling —
 * a twelve-step deploy is durable, and someone who stops watching has not
 * changed their mind about wanting it.
 */
function JobBox({
  jobId,
  title,
  done,
}: {
  jobId: string;
  title: string;
  done: (value: JobOutcome) => void;
}) {
  const { qoren } = useSession();
  const [steps, setSteps] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const doneRef = useRef(done);
  doneRef.current = done;

  useInput((_input, key) => {
    if (key.escape) doneRef.current({ status: "detached" });
  });

  useEffect(() => {
    const controller = new AbortController();
    const announced = new Set<string>();

    void qoren.jobs
      .await(
        jobId,
        (snapshot) => {
          if (!snapshot) {
            setReconnecting(true);
            return;
          }
          setReconnecting(false);
          setJob(snapshot);
          const fresh = snapshot.steps
            .filter((s) => s.status !== "Pending" && !announced.has(s.key))
            .map((s) => {
              announced.add(s.key);
              return s.label || s.key;
            });
          if (fresh.length > 0) setSteps((prior) => [...prior, ...fresh]);
        },
        controller.signal,
      )
      .then(
        (finished) => {
          doneRef.current({ status: "done", job: finished });
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          doneRef.current({ status: "failed", message: describeError(err) });
        },
      );

    return () => {
      controller.abort();
    };
  }, [jobId, qoren]);

  const phase = job ? currentStep(job) : "";

  return (
    <Frame title={title} hints={[["esc", "stop watching (the job keeps going)"]]}>
      <Box flexDirection="column">
        {steps.map((step, i) => (
          <Text key={`${step}-${i}`} dimColor>
            {`  . ${step}`}
          </Text>
        ))}
        <Box paddingTop={1}>
          {reconnecting ? (
            <Text color="yellow">  reconnecting...</Text>
          ) : (
            <Spinner label={phase || "starting"} />
          )}
        </Box>
        <Text dimColor>{`  job ${jobId}`}</Text>
      </Box>
    </Frame>
  );
}

function ShowBox({
  title,
  body,
  done,
}: {
  title: string;
  body: string;
  done: (value: undefined) => void;
}) {
  const lines = useMemo(() => body.replace(/\s+$/, "").split("\n"), [body]);
  const [top, setTop] = useState(0);
  const height = 18;

  useInput((input, key) => {
    if (key.escape || key.return || input === "q") {
      done(undefined);
      return;
    }
    const max = Math.max(0, lines.length - height);
    if (key.downArrow || input === "j") setTop((t) => Math.min(max, t + 1));
    if (key.upArrow || input === "k") setTop((t) => Math.max(0, t - 1));
    if (key.pageDown) setTop((t) => Math.min(max, t + height));
    if (key.pageUp) setTop((t) => Math.max(0, t - height));
    if (input === "g") setTop(0);
    if (input === "G") setTop(max);
  });

  return (
    <Frame
      title={title}
      hints={[
        ["up/down", "scroll"],
        ["esc", "close"],
      ]}
    >
      <Box flexDirection="column">
        {lines.slice(top, top + height).map((line, i) => (
          <Text key={top + i} wrap="truncate-end">
            {line || " "}
          </Text>
        ))}
        {lines.length > height ? (
          <Text dimColor>
            {`${top + 1}-${Math.min(lines.length, top + height)} of ${lines.length}`}
          </Text>
        ) : null}
      </Box>
    </Frame>
  );
}
