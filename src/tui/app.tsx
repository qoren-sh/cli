import { useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { Agent } from "@qoren/sdk";
import { UiProvider, useUi } from "./overlay.js";
import { SessionProvider, useSession } from "./store.js";
import { AccountPane } from "./panes/account.js";
import { AgentsPane } from "./panes/agents.js";
import { ChatPane } from "./panes/chat.js";
import { EnvironmentsPane } from "./panes/environments.js";
import { JobsPane } from "./panes/jobs.js";
import { ACCENT } from "./ui.js";
import type { Context } from "../context.js";

// The shell: tabs across the top, one pane, one line of hints at the bottom.
//
// The keyboard is arbitrated in exactly one place, here, on a rule simple
// enough to say in a sentence: whoever is deepest has it. An open overlay beats
// the pane, the chat's message field beats the shell, and everything else falls
// through to the tab keys. Panes ask for the keyboard by gating their own
// handlers on the flags this passes down, so there is no hidden precedence to
// go looking for when a keystroke lands somewhere surprising.

const TABS = ["environments", "agents", "jobs", "chat", "account"] as const;
type Tab = (typeof TABS)[number];

const HELP = `Getting around

  tab / shift+tab   next / previous section
  1 to 5            jump straight to a section
  up down j k       move within a list
  page up/down      a screen at a time
  g / G             first / last
  enter             open what is selected
  r                 refresh now
  ?                 this help
  q or ctrl+c       quit

Environments
  n new    R rename    s resize    c collaboration    d destroy    a its agents

Agents
  n deploy    m message    R rename    x run a command    l logs    d remove
  f show only one environment's agents    enter probe and diagnose

Jobs
  enter steps    w watch it run    c cancel

Chat
  a choose an agent    enter send    esc release the keyboard    c clear

Everything here goes through the same control plane as the commands, with the
same credential and the same plan limits. Anything this cannot do yet, the
commands still can: quit and run "qoren --help".`;

function Shell() {
  const { profile, profileName } = useSession();
  const ui = useUi();
  const { exit } = useApp();
  const size = useWindowSize();

  const [tab, setTab] = useState<Tab>("environments");
  const [environmentFilter, setEnvironmentFilter] = useState("");
  const [chatAgent, setChatAgent] = useState<Agent | null>(null);
  const [chatTyping, setChatTyping] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  // The chat field swallows letters while someone is writing, so the shell's
  // own single-letter keys stand down until escape releases it.
  const captured = tab === "chat" && chatAgent !== null && chatTyping;
  const shellActive = !ui.busy && !captured;

  useInput(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) {
        exit();
        return;
      }
      if (input === "?") {
        void ui.show("qoren", HELP);
        return;
      }
      if (input === "r") {
        // Remounting the pane is the honest way to refresh everything it
        // holds, including any list it fetched for a picker.
        setReloadKey((n) => n + 1);
        return;
      }
      const index = TABS.indexOf(tab);
      if (key.tab) {
        const step = key.shift ? -1 : 1;
        setTab(TABS[(index + step + TABS.length) % TABS.length] ?? tab);
        return;
      }
      const digit = Number.parseInt(input, 10);
      if (digit >= 1 && digit <= TABS.length) {
        setTab(TABS[digit - 1] ?? tab);
      }
    },
    { isActive: shellActive },
  );

  // Ctrl+C has to work even while the chat field has the keyboard: it is the
  // one key nobody should have to press escape first to reach.
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") exit();
    },
    { isActive: !shellActive },
  );

  // Two rows of chrome above (title, tabs) and two below (hints, notice), plus
  // the panel's own border and padding.
  const paneHeight = Math.max(4, size.rows - 11);
  const paneWidth = Math.max(40, size.columns - 4);

  const pane = () => {
    switch (tab) {
      case "environments":
        return (
          <EnvironmentsPane
            key={`env-${reloadKey}`}
            height={paneHeight}
            focused={!ui.busy}
            onOpenAgents={(id) => {
              setEnvironmentFilter(id);
              setTab("agents");
            }}
          />
        );
      case "agents":
        return (
          <AgentsPane
            key={`agents-${reloadKey}`}
            height={paneHeight}
            focused={!ui.busy}
            environmentFilter={environmentFilter}
            onFilterChange={setEnvironmentFilter}
            onChat={(agent) => {
              setChatAgent(agent);
              setChatTyping(true);
              setTab("chat");
            }}
          />
        );
      case "jobs":
        return (
          <JobsPane
            key={`jobs-${reloadKey}`}
            height={paneHeight}
            focused={!ui.busy}
          />
        );
      case "chat":
        return (
          <ChatPane
            height={paneHeight}
            width={paneWidth}
            focused={!ui.busy}
            agent={chatAgent}
            onPickAgent={(agent) => {
              setChatAgent(agent);
              setChatTyping(true);
            }}
            typing={chatTyping}
            onTyping={setChatTyping}
          />
        );
      case "account":
        return (
          <AccountPane
            key={`account-${reloadKey}`}
            height={paneHeight}
            focused={!ui.busy}
          />
        );
    }
  };

  return (
    <Box flexDirection="column" width={size.columns}>
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold color={ACCENT}>
          qoren
        </Text>
        <Text dimColor>
          {`${profile.email ?? profileName}  ${profile.baseUrl}`}
        </Text>
      </Box>

      <Box paddingX={1}>
        {TABS.map((name, i) => (
          <Text
            key={name}
            color={name === tab ? ACCENT : undefined}
            bold={name === tab}
            dimColor={name !== tab}
          >
            {`${i + 1} ${name}   `}
          </Text>
        ))}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={ui.busy ? "gray" : ACCENT}
        paddingX={1}
        minHeight={paneHeight + 4}
      >
        {ui.overlay ?? pane()}
      </Box>

      <Box paddingX={1}>
        {ui.notice ? (
          <Text color={ui.notice.tone === "bad" ? "red" : "green"} wrap="truncate-end">
            {ui.notice.message}
          </Text>
        ) : (
          <Text dimColor>
            {captured
              ? "esc  release the keyboard"
              : "tab  section    r  refresh    ?  help    q  quit"}
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function App({ session }: { session: Context }) {
  return (
    <SessionProvider value={session}>
      <UiProvider>
        <Shell />
      </UiProvider>
    </SessionProvider>
  );
}
