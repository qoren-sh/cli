import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Agent } from "@qoren/sdk";
import { emptyLine, readChatTurn, wrapText, type LineState } from "../model.js";
import { useUi } from "../overlay.js";
import { describeError, useResource, useSession } from "../store.js";
import { ACCENT, Field, Hints, Spinner, StatusLine } from "../ui.js";

// Talking to an agent.
//
// A turn is a job, not a request: the harness runs one-shot per message and can
// take minutes. The control plane writes the reply into that job as it arrives,
// so this polls and renders what has landed so far — an agent thinking out loud,
// with the tool it is currently running named underneath. Waiting two minutes
// at a spinner and then being handed a wall of text is a much worse way to
// spend the same two minutes.
//
// The conversation continues across turns through the session id the harness
// hands back. A turn that fell back to the SSH path returns none, in which case
// the next message starts fresh; that is the harness's behaviour, not something
// worth hiding.

type Entry = {
  id: number;
  role: "you" | "agent";
  text: string;
  tool?: string | null;
  pending?: boolean;
  failed?: boolean;
};

export function ChatPane({
  height,
  width,
  focused,
  agent,
  onPickAgent,
  typing,
  onTyping,
}: {
  height: number;
  width: number;
  focused: boolean;
  agent: Agent | null;
  onPickAgent: (agent: Agent) => void;
  /** Whether the message field has the keyboard. Owned by the shell, because
   * the shell has to stand down from reading single letters as commands while
   * someone is mid-sentence. */
  typing: boolean;
  onTyping: (typing: boolean) => void;
}) {
  const { qoren } = useSession();
  const ui = useUi();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [line, setLine] = useState<LineState>(() => emptyLine());
  const [sending, setSending] = useState(false);
  const [scrollBack, setScrollBack] = useState(0);
  const sessionId = useRef<string | null>(null);
  const nextId = useRef(0);

  // Only used to offer a picker when no agent has been chosen yet.
  const agents = useResource("agents:chat", () => qoren.agents.list(), {
    active: !ui.busy,
    interval: () => 60_000,
  });

  // A different agent is a different conversation. Starting a new one silently
  // on top of the old transcript would make the reply look like a non sequitur.
  useEffect(() => {
    setEntries([]);
    setScrollBack(0);
    sessionId.current = null;
  }, [agent?._id]);

  const pick = async () => {
    const rows = agents.data ?? [];
    if (rows.length === 0) {
      ui.toast("No agents to talk to yet.", "bad");
      return;
    }
    const chosen = await ui.select({
      title: "Talk to",
      choices: rows.map((a) => ({
        item: a,
        label: a.name,
        detail: `${a.runtime ?? "?"}  ${a.status}`,
      })),
    });
    if (chosen) onPickAgent(chosen);
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || !agent || sending) return;

    setLine(emptyLine());
    setScrollBack(0);
    const replyId = nextId.current + 1;
    nextId.current += 2;
    setEntries((prior) => [
      ...prior,
      { id: replyId - 1, role: "you", text: message },
      { id: replyId, role: "agent", text: "", pending: true },
    ]);
    setSending(true);

    const patch = (change: Partial<Entry>) => {
      setEntries((prior) =>
        prior.map((e) => (e.id === replyId ? { ...e, ...change } : e)),
      );
    };

    try {
      const { jobId } = await qoren.agents.message(
        agent._id,
        message,
        sessionId.current,
      );
      const job = await qoren.jobs.await(jobId, (snapshot) => {
        if (!snapshot) return;
        const turn = readChatTurn(snapshot.result);
        if (turn.text || turn.tool) {
          patch({ text: turn.text, tool: turn.tool });
        }
      });
      const turn = readChatTurn(job.result);
      // Only replace the session when the harness gave one: the warm path
      // returns a conversation id, the SSH fallback does not, and overwriting a
      // good id with null would silently end the conversation.
      if (turn.sessionId) sessionId.current = turn.sessionId;
      patch({
        text: turn.text || turn.stdErr || "(the agent said nothing)",
        tool: null,
        pending: false,
        ...(turn.exitCode !== null && turn.exitCode !== 0
          ? { failed: true }
          : {}),
      });
    } catch (err) {
      patch({
        text: describeError(err),
        tool: null,
        pending: false,
        failed: true,
      });
    } finally {
      setSending(false);
    }
  };

  // Pane keys, which apply once the input has been released with escape — and
  // always before an agent has been chosen, when there is no field to type into
  // and "a" is the only thing there is to do.
  useInput(
    (input, key) => {
      if (input === "a") {
        void pick();
        return;
      }
      if (input === "c") {
        setEntries([]);
        sessionId.current = null;
        setScrollBack(0);
        return;
      }
      if (input === "i" || key.return) onTyping(true);
    },
    { isActive: focused && !ui.busy && (!typing || agent === null) },
  );

  // Scrolling works whether or not the input has the keyboard: page keys are
  // not something anyone types into a message.
  useInput(
    (_input, key) => {
      if (key.pageUp) setScrollBack((s) => s + 5);
      if (key.pageDown) setScrollBack((s) => Math.max(0, s - 5));
    },
    { isActive: focused && !ui.busy },
  );

  if (!agent) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexGrow={1} paddingTop={1}>
          <Text dimColor>
            {agents.loading
              ? "Loading agents..."
              : "Pick an agent to talk to. Press a."}
          </Text>
        </Box>
        <Hints keys={[["a", "choose an agent"]]} />
      </Box>
    );
  }

  // Lay the transcript out as concrete lines so the tail that fits on screen is
  // exact rather than estimated.
  const bodyWidth = Math.max(20, width - 8);
  const lines: { text: string; role: Entry["role"]; failed?: boolean }[] = [];
  for (const entry of entries) {
    const label = entry.role === "you" ? "you " : `${agent.slug} `;
    const rendered = wrapText(entry.text || " ", bodyWidth);
    rendered.forEach((text, i) => {
      lines.push({
        text: `${i === 0 ? label.padEnd(8) : " ".repeat(8)}${text}`,
        role: entry.role,
        ...(entry.failed ? { failed: true } : {}),
      });
    });
    if (entry.pending) {
      lines.push({
        text: `${" ".repeat(8)}${entry.tool ? `running ${entry.tool}...` : "thinking..."}`,
        role: "agent",
      });
    }
    lines.push({ text: "", role: entry.role });
  }

  const viewport = Math.max(1, height - 2);
  const end = Math.max(0, lines.length - scrollBack);
  const visible = lines.slice(Math.max(0, end - viewport), end);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color={ACCENT}>
          {agent.name}
        </Text>
        <Text dimColor>
          {`  ${agent.runtime ?? "?"}  ${agent.model}`}
          {sessionId.current ? "  continuing" : "  new conversation"}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {visible.length === 0 ? (
          <Text dimColor>Say something.</Text>
        ) : (
          visible.map((row, i) => (
            <Text
              key={i}
              color={row.failed ? "red" : undefined}
              dimColor={row.role === "you"}
              wrap="truncate-end"
            >
              {row.text || " "}
            </Text>
          ))
        )}
      </Box>

      <Box>
        <Text color={typing ? ACCENT : "gray"}>{"> "}</Text>
        {sending ? (
          <Spinner label="waiting for the agent" />
        ) : (
          <Field
            value={line}
            onChange={setLine}
            onSubmit={(value) => void send(value)}
            onCancel={() => {
              onTyping(false);
            }}
            placeholder="write a message"
            focused={focused && typing && !ui.busy}
          />
        )}
      </Box>

      <Box>
        <StatusLine error={agents.error}>
          <Hints
            keys={
              typing
                ? [
                    ["enter", "send"],
                    ["esc", "release the keyboard"],
                    ["pgup/pgdn", "scroll"],
                  ]
                : [
                    ["i", "write"],
                    ["a", "another agent"],
                    ["c", "clear"],
                  ]
            }
          />
        </StatusLine>
      </Box>
    </Box>
  );
}
