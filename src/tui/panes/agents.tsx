import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Agent, Machine } from "@qoren/sdk";
import { age } from "../../output.js";
import { HOSTED_RUNTIMES, isCustomAgent } from "../../runtimes.js";
import { slugify } from "../../slug.js";
import { statusColorName } from "../model.js";
import { useUi } from "../overlay.js";
import { describeError, statusPaced, useResource, useSession } from "../store.js";
import { Details, Hints, StatusLine, Table, navigate } from "../ui.js";

// Agents: the thing the platform exists to run.
//
// The filter is the pane's own state rather than a global: someone narrowing
// this list to one environment has not said anything about what the Jobs pane
// should show, and a filter that leaks across panes is the kind of thing people
// spend ten minutes being confused by.

/** Everything, as a filter. Not an environment id, so it cannot collide. */
const ALL = "";

export function AgentsPane({
  height,
  focused,
  environmentFilter,
  onFilterChange,
  onChat,
}: {
  height: number;
  focused: boolean;
  environmentFilter: string;
  onFilterChange: (environmentId: string) => void;
  onChat: (agent: Agent) => void;
}) {
  const { qoren } = useSession();
  const ui = useUi();
  const [selected, setSelected] = useState(0);

  const agents = useResource(
    `agents:${environmentFilter}`,
    () => qoren.agents.list(environmentFilter || undefined),
    {
      active: !ui.busy,
      interval: statusPaced((rows: Agent[]) => rows.map((a) => a.status)),
    },
  );

  // Only for naming the filter and the deploy target; a slow fleet read here
  // would hold up the list people actually came for, so it polls at rest.
  const environments = useResource(
    "environments:for-agents",
    () => qoren.environments.list(),
    { active: !ui.busy, interval: () => 60_000 },
  );

  const rows = agents.data ?? [];
  const machines = environments.data ?? [];
  const current = rows[Math.min(selected, rows.length - 1)];
  const environmentName = (id: string | null) =>
    id === null ? "none" : (machines.find((m) => m.id === id)?.name ?? id);

  const pickEnvironment = async (title: string): Promise<Machine | null> => {
    if (machines.length === 0) {
      ui.toast("No environments to deploy onto. Make one first.", "bad");
      return null;
    }
    return ui.select({
      title,
      choices: machines.map((m) => ({
        item: m,
        label: m.name,
        detail: `${m.size}  ${m.region}`,
      })),
    });
  };

  const filter = async () => {
    const choice = await ui.select({
      title: "Show agents on",
      choices: [
        { item: ALL, label: "every environment" },
        ...machines.map((m) => ({
          item: m.id,
          label: m.name,
          detail: `${m.size}  ${m.region}`,
        })),
      ],
    });
    if (choice === null) return;
    setSelected(0);
    onFilterChange(choice);
  };

  const deploy = async () => {
    const machine = await pickEnvironment("Deploy onto");
    if (!machine) return;

    let templates;
    let options;
    try {
      [templates, options] = await Promise.all([
        qoren.templates.list(),
        qoren.account.options(),
      ]);
    } catch (err) {
      ui.toast(describeError(err), "bad");
      return;
    }

    const template = await ui.select({
      title: "Template",
      choices: templates.map((t) => ({
        item: t,
        label: t.name,
        detail: t.description,
        ...(t.source === "org" ? { hint: "custom" } : {}),
      })),
    });
    if (!template) return;

    const name = await ui.prompt({
      title: `Deploy a ${template.name}`,
      label: "Name",
      validate: (value) => {
        if (!value) return "Give it a name.";
        // The slug becomes the agent's Unix user and cannot be derived from a
        // name with nothing alphanumeric in it. Say so now rather than after
        // three more questions.
        return slugify(value)
          ? null
          : "That name has no letters or digits to build an identity from.";
      },
    });
    if (!name) return;

    // A template may declare which harnesses it supports; only offer those.
    const allowed = template.runtimes?.length ? template.runtimes : HOSTED_RUNTIMES;
    const runtime =
      allowed.length === 1
        ? allowed[0]
        : await ui.select({
            title: "Runtime",
            choices: allowed.map((r) => ({ item: r, label: r })),
          });
    if (!runtime) return;

    const recommended = new Set(options.recommendedModels);
    const model = await ui.select({
      title: "Model",
      choices: options.models.map((m) => ({
        item: m,
        label: m,
        ...(m === options.defaultModel
          ? { hint: "default" }
          : recommended.has(m)
            ? { hint: "recommended" }
            : {}),
      })),
      initial: Math.max(
        0,
        options.models.indexOf(options.defaultModel),
      ),
    });
    if (!model) return;

    try {
      const result = await qoren.agents.create({
        machineId: machine.id,
        slug: slugify(name),
        name,
        runtime,
        model,
        presetName: template.name,
      });
      // The pre-deploy review's advisories. They did not stop the deploy, but
      // they are the reason someone might want to stop it themselves.
      const warnings = result.safetyWarnings ?? [];
      if (warnings.length > 0) {
        await ui.show(
          "Before this deploys",
          warnings
            .map((f) => `${f.severity}: ${f.title}\n  ${f.suggestion}`)
            .join("\n\n"),
        );
      }
      const outcome = await ui.job(result.jobId, `Deploying ${name}`);
      ui.toast(
        outcome.status === "done"
          ? `${name} is running.`
          : outcome.status === "failed"
            ? outcome.message
            : `${name} is still deploying.`,
        outcome.status === "failed" ? "bad" : "good",
      );
    } catch (err) {
      // A 422 carries the safety review's findings, which are the whole reason
      // the deploy was refused. Showing the summary alone would hide them.
      ui.toast(describeError(err), "bad");
      const findings = safetyFindings(err);
      if (findings.length > 0) {
        await ui.show(
          "Why this was refused",
          findings
            .map((f) => `${f.severity}: ${f.title}\n  ${f.suggestion}`)
            .join("\n\n"),
        );
      }
    }
    agents.reload();
  };

  const rename = async (agent: Agent) => {
    const name = await ui.prompt({
      title: `Rename ${agent.name}`,
      label: "Name",
      initial: agent.name,
      validate: (value) => (value ? null : "Give it a name."),
    });
    if (!name || name === agent.name) return;
    try {
      const result = await qoren.agents.rename(agent._id, name);
      ui.toast(
        result.memorySynced
          ? `Renamed to ${result.name}.`
          : `Renamed to ${result.name}, but the agent could not be reached, so it still answers to its old name.`,
        result.memorySynced ? "good" : "bad",
      );
    } catch (err) {
      ui.toast(describeError(err), "bad");
    }
    agents.reload();
  };

  const remove = async (agent: Agent) => {
    const ok = await ui.confirm({
      title: `Remove ${agent.name}?`,
      body: "A final snapshot is taken first, so it can be restored for as long as that snapshot is kept.",
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await qoren.agents.destroy(agent._id);
      const outcome = await ui.job(result.jobId, `Removing ${agent.name}`);
      ui.toast(
        outcome.status === "failed" ? outcome.message : "Agent removed.",
        outcome.status === "failed" ? "bad" : "good",
      );
    } catch (err) {
      ui.toast(describeError(err), "bad");
    }
    setSelected(0);
    agents.reload();
  };

  const exec = async (agent: Agent) => {
    const command = await ui.prompt({
      title: `Run as ${agent.slug}`,
      label: "$",
      placeholder: "ls -la",
      validate: (value) => (value ? null : "Nothing to run."),
    });
    if (!command) return;
    try {
      const result = await qoren.agents.exec(agent._id, command);
      const body = [result.stdOut, result.stdErr].filter(Boolean).join("\n");
      await ui.show(
        `${agent.slug}: exit ${result.exitCode}`,
        body || "(no output)",
      );
    } catch (err) {
      ui.toast(describeError(err), "bad");
    }
  };

  const logs = async (agent: Agent) => {
    try {
      const lines = await qoren.agents.logs(agent._id, 400);
      await ui.show(
        `${agent.name} log`,
        lines.length === 0
          ? "(nothing logged yet)"
          : lines.map((l) => `${l.ts}  ${l.source}  ${l.message}`).join("\n"),
      );
    } catch (err) {
      ui.toast(describeError(err), "bad");
    }
  };

  const status = async (agent: Agent) => {
    try {
      // Two calls because they answer different questions: the probe is live,
      // the diagnostics are the recent failure history.
      const [health, diagnostics] = await Promise.all([
        qoren.agents.healthcheck(agent._id),
        qoren.agents.diagnostics(agent._id),
      ]);
      const failures =
        diagnostics.groups.length === 0
          ? "No recent failures."
          : diagnostics.groups
              .map(
                (g) =>
                  `${g.category}${g.tool ? ` (${g.tool})` : ""}  x${g.count}\n  ${g.sample}`,
              )
              .join("\n");
      await ui.show(
        `${agent.name} status`,
        `${JSON.stringify(health, null, 2)}\n\nRecent failures\n${failures}`,
      );
    } catch (err) {
      ui.toast(describeError(err), "bad");
    }
  };

  useInput(
    (input, key) => {
      const next = navigate(rows.length, selected, input, key);
      if (next !== null) {
        setSelected(next);
        return;
      }
      if (input === "n") {
        void deploy();
        return;
      }
      if (input === "f") {
        void filter();
        return;
      }
      if (!current) return;
      // A Custom agent has no environment: nothing to probe, shell into or
      // read logs from. Say where its runs are instead of failing on a 409.
      if (isCustomAgent(current) && (key.return || input === "x" || input === "l")) {
        ui.toast(
          `${current.name} is a Custom agent with no environment. See its runs with: qoren agent runs ${current._id}`,
          "bad",
        );
        return;
      }
      if (key.return) void status(current);
      else if (input === "m") onChat(current);
      else if (input === "R") void rename(current);
      else if (input === "d") void remove(current);
      else if (input === "x") void exec(current);
      else if (input === "l") void logs(current);
    },
    { isActive: focused && !ui.busy },
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      {environmentFilter ? (
        <Text dimColor>
          {`on ${environmentName(environmentFilter)} — press f to widen`}
        </Text>
      ) : null}
      <Box flexDirection="column" flexGrow={1}>
        <Table
          rows={rows}
          selected={selected}
          height={height - (environmentFilter ? 1 : 0)}
          focused={focused}
          empty={
            agents.loading
              ? "Loading..."
              : "No agents here yet. Press n to deploy one."
          }
          columns={[
            { header: "name", width: 20, value: (a) => a.name },
            {
              header: "status",
              width: 12,
              value: (a) => a.status,
              color: (a) => statusColorName(a.status),
            },
            { header: "runtime", width: 9, value: (a) => a.runtime ?? "" },
            { header: "environment", width: 18, value: (a) => environmentName(a.machineId) },
            { header: "model", width: 28, value: (a) => a.model },
            {
              header: "age",
              value: (a) => age(new Date(a.createdAt).toISOString()),
            },
          ]}
        />
      </Box>
      {current ? (
        <Box paddingTop={1}>
          <Details
            pairs={[
              ["slug", current.slug],
              ["template", current.presetName ?? ""],
              [
                "secrets",
                (current.clientSecretNames ?? []).join(", "),
              ],
            ]}
          />
        </Box>
      ) : null}
      <Box>
        <StatusLine error={agents.error} refreshing={agents.refreshing}>
          <Hints
            keys={[
              ["enter", "status"],
              ["m", "message"],
              ["n", "deploy"],
              ["R", "rename"],
              ["x", "exec"],
              ["l", "logs"],
              ["d", "remove"],
              ["f", "filter"],
            ]}
          />
        </StatusLine>
      </Box>
    </Box>
  );
}

type Finding = { severity: string; title: string; suggestion: string };

/** The safety review's findings on a refused deploy. Mirrors context.ts, which
 * does the same for the command line. */
function safetyFindings(err: unknown): Finding[] {
  const body = (err as { body?: unknown }).body;
  if (
    body &&
    typeof body === "object" &&
    "safetyFindings" in body &&
    Array.isArray(body.safetyFindings)
  ) {
    return body.safetyFindings as Finding[];
  }
  return [];
}
