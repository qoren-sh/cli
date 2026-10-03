import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { readableDate } from "../model.js";
import { useUi } from "../overlay.js";
import { useResource, useSession } from "../store.js";
import { ACCENT, Details, Hints, StatusLine, Table, navigate } from "../ui.js";

// The account: what the plan allows, and what is being spent against it.
//
// Read only. Credits, budgets and plan changes are decided in a browser, and a
// console that pretended otherwise would be offering something it cannot
// deliver. What it can do is answer "why did my agents stop" without anyone
// having to go and look.

type Section = "usage" | "spending" | "options" | "templates";
const SECTIONS: Section[] = ["usage", "spending", "options", "templates"];

export function AccountPane({
  height,
  focused,
}: {
  height: number;
  focused: boolean;
}) {
  const { qoren } = useSession();
  const ui = useUi();
  const [section, setSection] = useState<Section>("usage");
  const [selected, setSelected] = useState(0);

  const active = focused && !ui.busy;

  // Each section fetches only when it is the one on screen. Spending in
  // particular is an expensive read upstream, and paying for it because someone
  // glanced at their credit balance would be rude.
  const usage = useResource("account:usage", () => qoren.account.usage(), {
    active: active && section === "usage",
    interval: () => 60_000,
  });
  const spending = useResource(
    "account:spending",
    () => qoren.account.spending(30),
    { active: active && section === "spending" },
  );
  const options = useResource("account:options", () => qoren.account.options(), {
    active: active && section === "options",
  });
  const templates = useResource("account:templates", () => qoren.templates.list(), {
    active: active && section === "templates",
  });

  const rowCount =
    section === "spending"
      ? (spending.data?.machines.length ?? 0)
      : section === "options"
        ? (options.data?.models.length ?? 0)
        : section === "templates"
          ? (templates.data?.length ?? 0)
          : 0;

  useInput(
    (input, key) => {
      const index = SECTIONS.indexOf(section);
      if (key.rightArrow || input === "l") {
        setSection(SECTIONS[Math.min(SECTIONS.length - 1, index + 1)] ?? section);
        setSelected(0);
        return;
      }
      if (key.leftArrow || input === "h") {
        setSection(SECTIONS[Math.max(0, index - 1)] ?? section);
        setSelected(0);
        return;
      }
      const next = navigate(rowCount, selected, input, key);
      if (next !== null) setSelected(next);
    },
    { isActive: active },
  );

  const current =
    section === "usage"
      ? usage
      : section === "spending"
        ? spending
        : section === "options"
          ? options
          : templates;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        {SECTIONS.map((name) => (
          <Text
            key={name}
            color={name === section ? ACCENT : undefined}
            bold={name === section}
            dimColor={name !== section}
          >
            {`${name}  `}
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingTop={1}>
        {section === "usage" ? (
          usage.data ? (
            <Box flexDirection="column">
              <Details
                pairs={[
                  [
                    "credits used",
                    usage.data.unlimitedCredits
                      ? "unlimited plan"
                      : String(usage.data.creditsUsed),
                  ],
                  [
                    "credits left",
                    usage.data.unlimitedCredits
                      ? ""
                      : String(usage.data.creditsRemaining),
                  ],
                  ["balance", `$${usage.data.creditBalanceUsd.toFixed(2)}`],
                  ["model spend", `$${usage.data.managedLlmUsd.toFixed(2)}`],
                  ["web operations", String(usage.data.webSearchesUsed)],
                  ["state", usage.data.alertState],
                  ["period ends", readableDate(usage.data.periodEnd)],
                ]}
              />
              {/* These stop agents from working, so they are the point of the
                  section when they are true, not a footnote. */}
              {usage.data.blocked ? (
                <Text color="red">
                  Out of credits: agents are stopped until you top up.
                </Text>
              ) : null}
              {usage.data.budgetPaused ? (
                <Text color="red">
                  The monthly budget has been reached: agents are stopped until
                  it is raised or cleared.
                </Text>
              ) : null}
            </Box>
          ) : (
            <Text dimColor>Loading...</Text>
          )
        ) : null}

        {section === "spending" ? (
          <Table
            rows={spending.data?.machines ?? []}
            selected={selected}
            height={height - 3}
            focused={focused}
            empty={spending.loading ? "Loading..." : "Nothing spent yet."}
            columns={[
              { header: "environment", width: 24, value: (m) => m.machineName },
              {
                header: "model spend",
                width: 12,
                value: (m) => `$${m.openRouterTotalUsd.toFixed(2)}`,
              },
              // "actual" vs "estimated" matters: an environment without the
              // metrics agent reports a guess, and showing that as a measured
              // figure would be misleading.
              { header: "basis", width: 10, value: (m) => m.costStatus },
              { header: "note", value: (m) => m.error ?? "" },
            ]}
          />
        ) : null}

        {section === "options" ? (
          options.data ? (
            <Box flexDirection="column">
              <Text dimColor>
                {`sizes: ${options.data.sizes.map((s) => s.slug).join(", ")}`}
              </Text>
              <Text dimColor>
                {`regions: ${options.data.regions.map((r) => r.slug).join(", ")}`}
              </Text>
              <Box paddingTop={1} flexDirection="column">
                <Table
                  rows={options.data.models}
                  selected={selected}
                  height={height - 6}
                  focused={focused}
                  empty="No models available."
                  columns={[
                    { header: "model", width: 44, value: (m) => m },
                    {
                      header: "note",
                      value: (m) =>
                        m === options.data?.defaultModel
                          ? "default"
                          : options.data?.recommendedModels.includes(m)
                            ? "recommended"
                            : "",
                    },
                  ]}
                />
              </Box>
            </Box>
          ) : (
            <Text dimColor>Loading...</Text>
          )
        ) : null}

        {section === "templates" ? (
          <Table
            rows={templates.data ?? []}
            selected={selected}
            height={height - 3}
            focused={focused}
            empty={templates.loading ? "Loading..." : "No templates available."}
            columns={[
              { header: "template", width: 26, value: (t) => t.name },
              { header: "source", width: 8, value: (t) => t.source ?? "" },
              { header: "description", value: (t) => t.description },
            ]}
          />
        ) : null}
      </Box>

      <Box>
        <StatusLine error={current.error} refreshing={current.refreshing}>
          <Hints
            keys={[
              ["left/right", "section"],
              ["up/down", "move"],
            ]}
          />
        </StatusLine>
      </Box>
    </Box>
  );
}
