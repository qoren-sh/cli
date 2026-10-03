import type { Job } from "@qoren/sdk";
import { statusTone, type Tone } from "../output.js";

// The console's logic, with no React and no terminal in it.
//
// Everything here is a pure function over plain values: where a selection
// moves, which slice of a long list is on screen, what a keystroke does to a
// text field, what a half-finished chat turn currently says. Keeping it
// separate is what makes the console testable at all — a React tree wired to a
// live control plane is not something a unit test can hold, but these are.

/** Ink colour for a lifecycle word. The vocabulary itself lives in output.ts,
 * so the console and the plain tables agree on what "provisioning" means. */
export function toneColor(tone: Tone): string {
  switch (tone) {
    case "good":
      return "green";
    case "bad":
      return "red";
    case "busy":
      return "yellow";
    default:
      return "gray";
  }
}

export const statusColorName = (status: string): string =>
  toneColor(statusTone(status));

/**
 * Move a selection by `delta`, clamped to the list.
 *
 * Clamped rather than wrapping: in a list of thirty environments, holding the
 * down arrow and silently landing back on the first one is disorienting, and
 * there is no way to tell it apart from not having moved at all.
 */
export function moveSelection(
  count: number,
  current: number,
  delta: number,
): number {
  if (count === 0) return 0;
  return Math.min(count - 1, Math.max(0, current + delta));
}

/**
 * The slice of a list to draw, given how many rows the pane has.
 *
 * The window only moves when the selection would leave it, so paging through a
 * long list scrolls a line at a time instead of jumping by a screenful and
 * losing the reader's place.
 */
export function scrollWindow(
  count: number,
  selected: number,
  height: number,
  previousStart = 0,
): { start: number; end: number } {
  if (height <= 0 || count === 0) return { start: 0, end: 0 };
  const maxStart = Math.max(0, count - height);
  let start = Math.min(previousStart, maxStart);
  if (selected < start) start = selected;
  if (selected >= start + height) start = selected - height + 1;
  return { start, end: Math.min(count, start + height) };
}

// ---- text field ----------------------------------------------------------

export type LineState = { value: string; cursor: number };

export const emptyLine = (value = ""): LineState => ({
  value,
  cursor: value.length,
});

/** The subset of Ink's Key that a text field cares about. */
export type EditKey = {
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
  home?: boolean;
  end?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

// Control characters, which a paste can carry and which have no business in a
// name, a command or a message body: invisible on screen and unfixable once in.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;

/**
 * Apply one keystroke to a text field.
 *
 * Written as a reducer so the editing rules — including the readline habits
 * people's fingers already know (ctrl+a/e/u/k/w) — can be tested without a
 * terminal. Returns the state unchanged when the keystroke means nothing here.
 *
 * Note on backspace: some terminals report the backspace key as `delete` with
 * no `backspace` flag, so a `delete` at the end of the line rubs out to the
 * left rather than doing nothing at all.
 */
export function editLine(
  state: LineState,
  input: string,
  key: EditKey,
): LineState {
  const { value, cursor } = state;

  if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow)
    return { value, cursor: Math.min(value.length, cursor + 1) };
  if (key.home) return { value, cursor: 0 };
  if (key.end) return { value, cursor: value.length };

  if (key.backspace) {
    if (cursor === 0) return state;
    return {
      value: value.slice(0, cursor - 1) + value.slice(cursor),
      cursor: cursor - 1,
    };
  }
  if (key.delete) {
    // Forward delete when there is something ahead of the cursor; otherwise
    // treat it as the backspace this terminal meant it to be.
    if (cursor < value.length) {
      return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
    }
    if (cursor === 0) return state;
    return { value: value.slice(0, cursor - 1), cursor: cursor - 1 };
  }

  if (key.ctrl) {
    switch (input) {
      case "a":
        return { value, cursor: 0 };
      case "e":
        return { value, cursor: value.length };
      case "u":
        // Kill to the start of the line.
        return { value: value.slice(cursor), cursor: 0 };
      case "k":
        // Kill to the end of the line.
        return { value: value.slice(0, cursor), cursor };
      case "w": {
        // Kill the word behind the cursor, trailing whitespace included.
        const head = value.slice(0, cursor).replace(/\S*\s*$/, "");
        return { value: head + value.slice(cursor), cursor: head.length };
      }
      default:
        return state;
    }
  }

  // A paste arrives as one multi-character input, so insert whatever came in
  // rather than assuming a single keypress.
  const text = input.replace(CONTROL, "");
  if (!text || key.meta) return state;
  return {
    value: value.slice(0, cursor) + text + value.slice(cursor),
    cursor: cursor + text.length,
  };
}

// ---- chat turns ----------------------------------------------------------

export type ChatTurn = {
  /** What the agent has said so far. Grows while the turn streams. */
  text: string;
  /** Still arriving, so the console should keep showing it as in progress. */
  streaming: boolean;
  /** The tool the agent is running right now, when it is running one. */
  tool: string | null;
  /** The conversation to resume next message, when the harness gave one. */
  sessionId: string | null;
  stdErr: string;
  exitCode: number | null;
};

const EMPTY_TURN: ChatTurn = {
  text: "",
  streaming: false,
  tool: null,
  sessionId: null,
  stdErr: "",
  exitCode: null,
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Read a message job's result.
 *
 * The control plane writes the reply into the job's result as it arrives — a
 * partial snapshot flagged `streaming` a few times a second, then the final
 * one — so polling the job is how the console shows an agent thinking out loud
 * instead of staring at a spinner for two minutes.
 *
 * Read defensively: this is a `Record<string, unknown>` on the wire, and a turn
 * that fell back to the SSH path carries no session id at all.
 */
export function readChatTurn(result: unknown): ChatTurn {
  if (!result || typeof result !== "object") return EMPTY_TURN;
  const row = result as Record<string, unknown>;
  return {
    text: str(row.stdOut),
    streaming: row.streaming === true,
    tool: typeof row.tool === "string" && row.tool ? row.tool : null,
    sessionId:
      typeof row.sessionId === "string" && row.sessionId ? row.sessionId : null,
    stdErr: str(row.stdErr),
    exitCode: typeof row.exitCode === "number" ? row.exitCode : null,
  };
}

// ---- refresh cadence -----------------------------------------------------

const SETTLED = ["active", "off", "archive", "succeeded", "failed", "cancelled"];

/**
 * How long to wait before refreshing a pane, in milliseconds.
 *
 * A fleet at rest changes on the scale of minutes and every poll is a real
 * request against someone's control plane, so the idle cadence is deliberately
 * slow. Anything mid-flight — provisioning, deploying, a running job — is worth
 * watching closely, and only then does the console poll hard.
 */
export function refreshDelay(
  statuses: string[],
  idleMs = 20_000,
  activeMs = 3_000,
): number {
  const moving = statuses.some(
    (status) => !SETTLED.includes(status.toLowerCase()),
  );
  return moving ? activeMs : idleMs;
}

/** Step completion for a job row, e.g. "9/12". Mirrors jobProgress.jobSummary. */
export function jobProgressText(job: Job): string {
  if (job.steps.length === 0) return "";
  const done = job.steps.filter((s) => s.status === "Succeeded").length;
  return `${done}/${job.steps.length}`;
}

/** The step a job is on right now, for a one-line summary. */
export function currentStep(job: Job): string {
  const running = job.steps.find((s) => s.status === "Running");
  if (running) return running.label || running.key;
  const last = [...job.steps].reverse().find((s) => s.status !== "Pending");
  return last ? last.label || last.key : "";
}

/**
 * Break text into lines that fit `width`, keeping the newlines it already has.
 *
 * The chat transcript needs to know how many lines a reply actually occupies
 * before it can decide how much of the conversation still fits on screen, and
 * asking the renderer after the fact is too late. Words longer than the width
 * (a URL, a stack frame) are split rather than allowed to overflow.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      let piece = word;
      // A single word wider than the column is cut into full-width chunks.
      while (piece.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(piece.slice(0, width));
        piece = piece.slice(width);
      }
      if (!line) {
        line = piece;
      } else if (line.length + 1 + piece.length <= width) {
        line += ` ${piece}`;
      } else {
        out.push(line);
        line = piece;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * A date someone can read, from whatever the wire sent.
 *
 * Timestamps arrive as ISO strings in some places and epoch millis in others
 * (the usage governor's period bounds among them), and "1786150711602" is not
 * an answer to "when does my billing period end".
 */
export function readableDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(typeof value === "number" ? value : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/** Fit text to a column, with an ellipsis when it does not. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
