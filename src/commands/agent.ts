import { InvalidArgumentError, type Command } from "commander";
import type {
  Agent,
  AgentDoctorRun,
  AgentFileLink,
  AgentRuntime,
  AgentScheduledTaskRun,
  AgentSpendLimitCaps,
  AgentSpendLimits,
  AgentUsage,
  DeviceLoginPrompt,
  ExecResponse,
} from "@qoren/sdk";
import {
  requireContext,
  run,
  type Context,
  type GlobalOptions,
} from "../context.js";
import { parseDuration } from "../duration.js";
import { slugify } from "../slug.js";
import {
  DELIVER_TO_HELP,
  DELIVERY_HELP,
  describeDelivery,
  resolveDelivery,
} from "../taskDelivery.js";
import {
  CONTEXT_FROM_HELP,
  collectContextFrom,
  describeChain,
  resolveContextFrom,
} from "../taskChain.js";
import { followJob } from "../jobProgress.js";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { basename } from "node:path";
import { applyPlan } from "../migrate/apply.js";
import { parseBundle, planImport } from "../migrate/bundle.js";
import { readTar } from "../migrate/tar.js";
import {
  CUSTOM_CREATE_REFUSAL,
  HOSTED_RUNTIMES,
  RUNTIMES,
  isCustomAgent,
  isHostedRuntime,
} from "../runtimes.js";
import { customAgentCommands } from "./customAgent.js";
import { parseOnOff } from "../args.js";
import {
  age,
  bold,
  details,
  dim,
  emit,
  note,
  statusColor,
  table,
  warn,
} from "../output.js";

// Agents.

export { parseOnOff };

/** One line saying where approval mode stands, for `agent approval-mode`. */
export function approvalModeLine(name: string | null, enabled: boolean): string {
  const who = name ? bold(name) : "the agent";
  return enabled
    ? `Approval mode is on: ${who} proposes changes for you to approve instead of making them.`
    : `Approval mode is off: ${who} acts on its own.`;
}

// Scheduled-task health states that need no attention.
const HEALTHY_TASK_STATES = new Set(["healthy", "pending", "native"]);

function formatRunDuration(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** One short line on why a run looks the way it does: its error, an inferred outcome, or the first
 * failed delivery. Full text is in --json. */
function runNote(r: AgentScheduledTaskRun): string {
  const oneLine = (text: string) => {
    const line = text.split("\n")[0]?.trim() ?? "";
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  };
  if (r.status === "unknown" && r.outcomeSource === "control-plane")
    return dim("no result recorded");
  if (r.status === "coalesced") return dim("missed slots folded into one run");
  if (r.error) return oneLine(r.error);
  const failed = r.deliveries.find((d) => d.error);
  return failed?.error ? oneLine(`${failed.destination}: ${failed.error}`) : "";
}

// For historical reasons an agent carries its id as `_id` and its timestamps as
// epoch millis, unlike every other resource. The table converts rather than
// assuming the shape the others use.
function agentTable(rows: Agent[]): void {
  table(rows, [
    { header: "id", value: (a) => a._id },
    { header: "name", value: (a) => a.name },
    { header: "slug", value: (a) => a.slug },
    { header: "status", value: (a) => statusColor(a.status) },
    { header: "runtime", value: (a) => a.runtime ?? "" },
    { header: "model", value: (a) => a.model },
    { header: "age", value: (a) => age(new Date(a.createdAt).toISOString()) },
  ]);
}

function doctorTable(rows: AgentDoctorRun[]): void {
  table(rows, [
    {
      header: "started",
      value: (r) => age(new Date(r.startedAt).toISOString()),
    },
    { header: "trigger", value: (r) => r.trigger },
    { header: "status", value: (r) => statusColor(r.status) },
    {
      header: "found",
      value: (r) => (r.issuesFound == null ? "" : String(r.issuesFound)),
    },
    {
      header: "left",
      value: (r) =>
        r.issuesRemaining == null ? "" : String(r.issuesRemaining),
    },
    { header: "summary", value: (r) => r.summary },
  ]);
}

function printDoctorRun(r: AgentDoctorRun): void {
  note(`${bold(statusColor(r.status))} ${r.summary}`);
  const detail = r.checkOutput?.trim();
  if (detail) {
    process.stdout.write(`${detail}\n`);
  }
  if (r.repairAttempted && r.repairOutput?.trim()) {
    note(bold("\nRepair output"));
    process.stdout.write(`${r.repairOutput.trim()}\n`);
  }
}

/** Poll the checkup history until the run we started leaves `running`. */
async function waitForDoctor(
  ctx: Context,
  agentId: string,
  runId: string,
): Promise<AgentDoctorRun> {
  const deadline = Date.now() + 20 * 60 * 1000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const runs = await ctx.qoren.agents.doctorRuns(agentId, 5);
    const mine = runs.find((r) => r.id === runId) ?? runs[0];
    if (mine && mine.status !== "running") return mine;
    if (Date.now() > deadline) {
      warn("Gave up waiting; check back with --history.");
      return mine ?? runs[0]!;
    }
  }
}

/** Print an exec/message result the way a shell would: stdout to stdout,
 * stderr to stderr, and the exit code carried through to ours. */
function printExec(result: ExecResponse): void {
  if (result.stdOut) process.stdout.write(result.stdOut);
  if (result.stdErr) process.stderr.write(result.stdErr);
  if (result.exitCode !== 0) process.exitCode = 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a device sign-in job to publish the one-time code, or to end.
 *
 * The code arrives as the job's partial result, not as a step or a log line, so
 * `jobs.await` is the wrong tool: it resolves only once the operator has already
 * approved. Poll instead, on a cadence a person can watch without it feeling
 * stuck. Null means the job reached a terminal state without ever printing a
 * code, which `followJob` then reports properly.
 */
async function awaitDeviceCode(
  ctx: Context,
  jobId: string,
): Promise<DeviceLoginPrompt | null> {
  for (;;) {
    const job = await ctx.qoren.jobs.get(jobId);
    const result = job.result as Partial<DeviceLoginPrompt> | null;
    if (result?.userCode && result.verificationUrl) {
      return {
        awaitingApproval: true,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
        expiresAt: result.expiresAt ?? "",
      };
    }
    if (job.status !== "Queued" && job.status !== "Running") return null;
    await sleep(1_500);
  }
}

// Spend limits: daily, weekly and monthly credit caps on an agent's own model key.

/** The largest cap the control plane accepts, in credits. */
export const MAX_SPEND_CAP = 100_000_000;

/** A `--daily`/`--weekly`/`--monthly` value: a whole number of credits, or
 * `off` (or `none`) to remove the cap. "off" rather than null because
 * commander turns a parser's null into an empty string. */
export function parseSpendCap(input: string): number | "off" {
  const v = input.trim().toLowerCase();
  if (v === "off" || v === "none") return "off";
  const digits = v.replace(/[,_]/g, "");
  if (!/^\d+$/.test(digits)) {
    throw new InvalidArgumentError(
      `Expected a whole number of credits or "off", got "${input}".`,
    );
  }
  const credits = Number(digits);
  if (credits < 1 || credits > MAX_SPEND_CAP) {
    throw new InvalidArgumentError(
      `A cap must be from 1 to ${MAX_SPEND_CAP.toLocaleString("en-US")} credits, or "off".`,
    );
  }
  return credits;
}

export type SpendCapFlags = {
  daily?: number | "off";
  weekly?: number | "off";
  monthly?: number | "off";
};

/** The caps to send: the current ones with only the given flags changed,
 * since the endpoint replaces all three. Null when no flag was given. */
export function mergeSpendCaps(
  current: AgentSpendLimitCaps,
  flags: SpendCapFlags,
): AgentSpendLimitCaps | null {
  if (
    flags.daily === undefined &&
    flags.weekly === undefined &&
    flags.monthly === undefined
  ) {
    return null;
  }
  const pick = (flag: number | "off" | undefined, cap: number | null) =>
    flag === undefined ? cap : flag === "off" ? null : flag;
  return {
    dailyCredits: pick(flags.daily, current.dailyCredits),
    weeklyCredits: pick(flags.weekly, current.weeklyCredits),
    monthlyCredits: pick(flags.monthly, current.monthlyCredits),
  };
}

/** One line saying whether the caps bite, from the agent's key state. */
export function spendKeyLine(limits: AgentSpendLimits): string {
  switch (limits.key) {
    case "agent":
      return limits.enforced
        ? "Enforced on the agent's own key: model calls stop once a cap is reached and resume after the window resets."
        : "Set on the agent's own key, but not enforced right now.";
    case "pending":
      return "The agent's own key is being issued (within a few minutes). The caps apply once it lands.";
    case "own":
      return "This agent runs on your own model key, so Qoren does not bill or cap its spend.";
    case "none":
      return "This agent has no Qoren model key, so there is nothing to cap.";
  }
}

const SPEND_WINDOWS = [
  { label: "daily", key: "dailyCredits", resets: "midnight UTC" },
  { label: "weekly", key: "weeklyCredits", resets: "Monday, midnight UTC" },
  { label: "monthly", key: "monthlyCredits", resets: "the 1st, midnight UTC" },
] as const;

/** The windows a cap is already at or under this window's spend. */
export function capsAlreadyReached(limits: AgentSpendLimits): string[] {
  const spent = limits.spent;
  if (!spent) return [];
  return SPEND_WINDOWS.filter(({ key }) => {
    const cap = limits[key];
    return cap !== null && spent[key] >= cap;
  }).map(({ label }) => label);
}

function printSpendLimits(limits: AgentSpendLimits): void {
  const n = (value: number) => Math.round(value).toLocaleString("en-US");
  table([...SPEND_WINDOWS], [
    { header: "window", value: (w) => w.label },
    {
      header: "cap",
      value: (w) => {
        const cap = limits[w.key];
        return cap === null ? dim("none") : `${n(cap)} credits`;
      },
    },
    {
      header: "spent",
      value: (w) => (limits.spent ? `${n(limits.spent[w.key])} credits` : dim("unavailable")),
    },
    { header: "resets", value: (w) => w.resets },
  ]);
  note(dim(`\n${spendKeyLine(limits)}`));
  if (!limits.canEdit) {
    note(dim("Only the organization owner can change these caps."));
  }
}

export function agentCommands(program: Command, global: () => GlobalOptions) {
  const agent = program
    .command("agent")
    .alias("agents")
    .description("Manage agents");

  agent
    .command("ls")
    .alias("list")
    .description("List your agents")
    .option("--env <id>", "only agents on this environment")
    .option("--runtime <runtime>", `only agents of this runtime: ${RUNTIMES.join(", ")}`)
    .action((options: { env?: string; runtime?: string }) =>
      run(async () => {
        if (
          options.runtime !== undefined &&
          !RUNTIMES.includes(options.runtime as AgentRuntime)
        ) {
          throw new Error(
            `Unknown runtime "${options.runtime}". Choose one of: ${RUNTIMES.join(", ")}.`,
          );
        }
        const ctx = requireContext(global());
        const agents = await ctx.qoren.agents.list({
          ...(options.env ? { environmentId: options.env } : {}),
          ...(options.runtime ? { runtime: options.runtime as AgentRuntime } : {}),
        });
        emit(agents, () => agentTable(agents));
      })(),
    );

  agent
    .command("get <id>")
    .description("Show one agent")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const a = await ctx.qoren.agents.get(id);
        emit(a, () => {
          details([
            ["Id", a._id],
            ["Name", a.name],
            ["Slug", a.slug],
            ["Status", statusColor(a.status)],
            ["Runtime", a.runtime ?? ""],
            ["Model", a.model],
            ["Template", a.presetName ?? ""],
            ["Environment", a.machineId ?? dim("none (Custom agent)")],
            ["Secrets", (a.clientSecretNames ?? []).join(", ")],
            ["Messaging", (a.gateways ?? []).map((g) => g.type).join(", ")],
            ["Approval mode", a.approvalModeEnabled ? "on" : "off"],
            ["Created", new Date(a.createdAt).toISOString()],
          ]);
          if (isCustomAgent(a)) {
            note(dim(`\nA Custom agent. Its design and inputs: qoren designer show ${a._id}`));
          }
        });
      })(),
    );

  agent
    .command("create")
    .description("Deploy a new agent onto an environment")
    .requiredOption("--env <id>", "environment to deploy onto")
    .requiredOption("--template <slug>", "template to build from")
    .requiredOption("--name <name>", "display name")
    .option("--slug <slug>", "machine identity (defaults to the name)")
    .option("--model <model>", "model id")
    .option(
      "--runtime <runtime>",
      `one of: ${HOSTED_RUNTIMES.join(", ")}`,
      // Refused while parsing, so the pointer to the Designer comes before any
      // complaint about the flags a Custom agent would never need.
      (value: string) => {
        if (value === "custom") throw new InvalidArgumentError(CUSTOM_CREATE_REFUSAL);
        return value;
      },
      "hermes",
    )
    .option("--secret <name...>", "vault secret to inject; repeatable")
    .option("--no-wait", "print the job id and exit instead of following it")
    .action(
      (options: {
        env: string;
        template: string;
        name: string;
        slug?: string;
        model?: string;
        runtime: string;
        secret?: string[];
        wait: boolean;
      }) =>
        run(async () => {
          if (options.runtime === "custom") throw new Error(CUSTOM_CREATE_REFUSAL);
          if (!isHostedRuntime(options.runtime)) {
            throw new Error(
              `Unknown runtime "${options.runtime}". Choose one of: ${HOSTED_RUNTIMES.join(", ")}.`,
            );
          }
          const runtime = options.runtime;
          const ctx = requireContext(global());
          // The slug is the agent's permanent identity (its Unix user), so it
          // has to be a safe token. Derive a sane one from the name rather than
          // making everyone pass both.
          const slug = options.slug ?? slugify(options.name);
          if (!slug) {
            throw new Error(
              "Could not derive a slug from that name. Pass --slug explicitly.",
            );
          }

          // Fall back to the server's own default for this org, so a first
          // deploy does not require knowing a model id.
          const model =
            options.model ?? (await ctx.qoren.account.options()).defaultModel;
          if (!model) {
            throw new Error("No model available. Pass --model explicitly.");
          }

          const result = await ctx.qoren.agents.create({
            machineId: options.env,
            slug,
            name: options.name,
            runtime,
            model,
            presetName: options.template,
            ...(options.secret?.length
              ? { clientSecretNames: options.secret }
              : {}),
          });

          for (const finding of result.safetyWarnings ?? []) {
            warn(
              `${finding.severity}: ${finding.title} — ${finding.suggestion}`,
            );
          }

          if (!options.wait) {
            emit(result, () => note(`Job ${bold(result.jobId)} started.`));
            return;
          }
          await followJob(
            ctx,
            result.jobId,
            `Deploying ${bold(options.name)}…`,
          );
          emit({ ...result, ok: true, slug }, () =>
            note(`Agent ${bold(options.name)} is running.`),
          );
        })(),
    );

  agent
    .command("rm <id>")
    .alias("destroy")
    .description("Remove an agent (a final snapshot is taken first)")
    .option("--no-wait", "print the job id and exit instead of following it")
    .action((id: string, options: { wait: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.agents.destroy(id);
        if (!options.wait) {
          emit(result, () => note(`Job ${bold(result.jobId)} started.`));
          return;
        }
        await followJob(ctx, result.jobId, `Removing ${bold(id)}…`);
        emit({ ...result, ok: true }, () =>
          note("Agent removed. It can be restored from its final snapshot."),
        );
      })(),
    );

  agent
    .command("rename <id> <name>")
    .description("Rename an agent")
    .action((id: string, name: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.agents.rename(id, name);
        emit(result, () => {
          note(`Renamed to ${bold(result.name)}.`);
          if (!result.memorySynced) {
            // The rename stands either way; saying nothing here would leave
            // someone wondering why the agent still calls itself the old name.
            warn(
              "The agent could not be reached, so it still answers to its old name. It will learn the new one next time it is rebuilt.",
            );
          }
        });
      })(),
    );

  agent
    .command("approval-mode <id> [state]")
    .description(
      "Show approval mode, or turn it on or off (the agent proposes changes for you to approve instead of making them)",
    )
    .action((id: string, state: string | undefined) =>
      run(async () => {
        const ctx = requireContext(global());
        if (state === undefined) {
          const a = await ctx.qoren.agents.get(id);
          const enabled = a.approvalModeEnabled ?? false;
          emit({ approvalModeEnabled: enabled }, () =>
            note(approvalModeLine(a.name, enabled)),
          );
          return;
        }
        const enabled = parseOnOff(state);
        if (enabled === null) {
          throw new Error(`Expected on or off, got "${state}".`);
        }
        const result = await ctx.qoren.agents.setApprovalMode(id, enabled);
        emit(result, () => {
          note(approvalModeLine(null, result.approvalModeEnabled));
          if (result.approvalModeEnabled) {
            note(
              dim(
                "Its next turn proposes instead of acting. See what it asks with: qoren approvals",
              ),
            );
          }
        });
      })(),
    );

  agent
    .command("message <id> <message>")
    .description("Send an agent a message and wait for its reply")
    .option("--resume <sessionId>", "continue a previous conversation")
    .option("--no-wait", "print the job id and exit instead of waiting")
    .action(
      (
        id: string,
        message: string,
        options: { resume?: string; wait: boolean },
      ) =>
        run(async () => {
          const ctx = requireContext(global());
          const result = await ctx.qoren.agents.message(
            id,
            message,
            options.resume ?? null,
          );
          if (!options.wait) {
            emit(result, () => note(`Job ${bold(result.jobId)} started.`));
            return;
          }
          // A turn can take minutes: the harness runs one-shot per message.
          const job = await followJob(ctx, result.jobId, dim("Thinking…"));
          const reply = job.result as ExecResponse | undefined;
          emit(reply ?? {}, () => {
            if (reply) printExec(reply);
          });
        })(),
    );

  agent
    .command("exec <id> <command>")
    .description("Run a shell command as the agent's user")
    .action((id: string, command: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.agents.exec(id, command);
        emit(result, () => printExec(result));
      })(),
    );

  agent
    .command("logs <id>")
    .description("Show an agent's recent log")
    .option("--limit <n>", "how many lines", "200")
    .action((id: string, options: { limit: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const lines = await ctx.qoren.agents.logs(
          id,
          Number.parseInt(options.limit, 10) || 200,
        );
        emit(lines, () => {
          for (const line of lines) {
            process.stdout.write(
              `${dim(line.ts)} ${dim(line.source)} ${line.message}\n`,
            );
          }
        });
      })(),
    );

  agent
    .command("tasks <id>")
    .description("List an agent's scheduled tasks and how healthy each one is")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const tasks = await ctx.qoren.agents.listScheduledTasks(id);
        emit(tasks, () => {
          table(tasks, [
            { header: "id", value: (t) => t.id },
            { header: "name", value: (t) => t.name },
            { header: "cron", value: (t) => t.schedule },
            { header: "timezone", value: (t) => t.timezone },
            { header: "delivery", value: describeDelivery },
            { header: "reads", value: (t) => describeChain(t, tasks) },
            { header: "source", value: (t) => (t.source as string | undefined) ?? "" },
            { header: "state", value: (t) => statusColor(t.schedulerState) },
            { header: "health", value: (t) => statusColor(t.healthState) },
            {
              header: "failures",
              value: (t) =>
                t.consecutiveFailures > 0 ? String(t.consecutiveFailures) : "",
            },
            { header: "next", value: (t) => t.nextExpectedAt ?? "" },
            { header: "enabled", value: (t) => (t.enabled ? "yes" : "no") },
          ]);
          // The table has no room for prose: say why each unhealthy task is unhealthy underneath it.
          for (const t of tasks) {
            const why = t.healthDetail ?? t.schedulerError;
            if (why && !HEALTHY_TASK_STATES.has(t.healthState))
              warn(`${bold(t.name)}: ${why}`);
          }
        });
      })(),
    );

  agent
    .command("task-runs <id> <task-id>")
    .description("Show a scheduled task's recent runs and delivery results")
    .option("--limit <count>", "number of runs, up to 100", "25")
    .action((id: string, taskId: string, options: { limit: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const count = Number.parseInt(options.limit, 10);
        if (!Number.isInteger(count) || count < 1 || count > 100)
          throw new Error("--limit must be between 1 and 100.");
        const runs = await ctx.qoren.agents.listScheduledTaskRuns(id, taskId, count);
        emit(runs, () => table(runs, [
          { header: "run", value: (r) => r.runId },
          { header: "started", value: (r) => r.startedAt ?? "" },
          {
            header: "status",
            value: (r) =>
              r.reason ? `${statusColor(r.status)} ${dim(`(${r.reason})`)}` : statusColor(r.status),
          },
          { header: "duration", value: (r) => formatRunDuration(r.durationMs) },
          { header: "exit", value: (r) => (r.exitCode == null ? "" : String(r.exitCode)) },
          {
            header: "delivery",
            value: (r) =>
              r.deliveries.map((d) => `${d.destination}:${statusColor(d.status)}`).join(", "),
          },
          { header: "note", value: runNote },
        ]));
      })(),
    );

  agent
    .command("task-add <id> <name> <cron> <prompt>")
    .description("Create a scheduled task")
    .option("--timezone <zone>", "IANA timezone", "UTC")
    .option("--delivery <policy>", DELIVERY_HELP)
    .option("--deliver-to <target>", DELIVER_TO_HELP)
    .option("--context-from <task>", CONTEXT_FROM_HELP, collectContextFrom)
    .action((id: string, name: string, cron: string, prompt: string,
      options: { timezone: string; delivery?: string; deliverTo?: string; contextFrom?: string[] }) =>
      run(async () => {
        const delivery = resolveDelivery(options);
        const contextFrom = resolveContextFrom(options.contextFrom);
        const ctx = requireContext(global());
        const task = await ctx.qoren.agents.createScheduledTask(id, {
          name, schedule: cron, prompt, timezone: options.timezone,
          ...delivery,
          ...(contextFrom && { contextFrom }),
        });
        emit(task, () => note(`Task ${bold(task.name)} queued for installation (${task.id}).`));
      })(),
    );

  agent
    .command("task-set <id> <task-id> <name> <cron> <prompt>")
    .description("Replace a scheduled task")
    .option("--timezone <zone>", "IANA timezone")
    .option("--delivery <policy>", `${DELIVERY_HELP}; unchanged when omitted`)
    .option("--deliver-to <target>", DELIVER_TO_HELP)
    .option("--disable", "keep the task without firing it")
    .option("--enable", "resume a disabled task")
    .option("--context-from <task>", `${CONTEXT_FROM_HELP}; replaces the current list, unchanged when omitted`, collectContextFrom)
    .option("--no-context-from", "stop reading other tasks' output")
    .action((id: string, taskId: string, name: string, cron: string, prompt: string,
      options: {
        timezone?: string; delivery?: string; deliverTo?: string; disable?: boolean; enable?: boolean;
        contextFrom?: string[] | false;
      }) =>
      run(async () => {
        if (options.enable && options.disable) throw new Error("Choose --enable or --disable.");
        const contextFrom = resolveContextFrom(options.contextFrom);
        // Check the flags on their own before a round trip; the existing task only matters for
        // "--delivery chat" without a new target, which keeps the chat it already had.
        if (options.delivery !== "chat") resolveDelivery(options);
        const ctx = requireContext(global());
        const existing = (await ctx.qoren.agents.listScheduledTasks(id)).find(t => t.id === taskId);
        if (!existing) throw new Error(`Scheduled task ${taskId} was not found.`);
        const task = await ctx.qoren.agents.replaceScheduledTask(id, taskId, {
          name, schedule: cron, prompt,
          timezone: options.timezone ?? existing.timezone,
          enabled: options.enable ? true : options.disable ? false : existing.enabled,
          ...resolveDelivery(options, existing),
          priority: existing.priority,
          reservationBufferSec: existing.reservationBufferSec,
          freezePeers: existing.freezePeers,
          // Omitted keeps the chain the task has; an empty list clears it.
          ...(contextFrom && { contextFrom }),
        });
        emit(task, () => note(`Task ${bold(task.name)} queued for update.`));
      })(),
    );

  agent
    .command("task-rm <id> <task-id>")
    .description("Delete a scheduled task")
    .action((id: string, taskId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        await ctx.qoren.agents.deleteScheduledTask(id, taskId);
        emit({ accepted: true }, () => note("Task deletion queued."));
      })(),
    );

  agent
    .command("keys <id>")
    .description("List the keys an agent carries, and revoke the ones you set")
    .option(
      "--revoke <name...>",
      "take these keys off the agent (repeatable); only keys you set can go",
    )
    .option("--no-wait", "print the job id and exit instead of following it")
    .action((id: string, options: { revoke?: string[]; wait: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        // Names only, always: the API cuts each .env line at its "=" on the
        // host, so nothing here can print a secret even by accident.
        if (!options.revoke?.length) {
          const keys = await ctx.qoren.agents.envKeys(id);
          emit(keys, () => {
            if (keys.length === 0) {
              note(dim("This agent carries no keys."));
              return;
            }
            table(keys, [
              { header: "name", value: (k) => k.name },
              { header: "source", value: (k) => k.source },
              { header: "revocable", value: (k) => (k.revocable ? "yes" : "") },
            ]);
          });
          return;
        }
        const result = await ctx.qoren.agents.configure(id, {
          removeEnvNames: options.revoke,
        });
        if (!options.wait) {
          emit(result, () => note(`Job ${bold(result.jobId)} started.`));
          return;
        }
        await followJob(ctx, result.jobId, `Revoking on ${bold(id)}…`);
        emit({ ...result, ok: true, revoked: options.revoke }, () =>
          note(`Revoked ${bold(options.revoke!.join(", "))}.`),
        );
      })(),
    );

  agent
    .command("status <id>")
    .description("Probe an agent and report what is wrong, if anything")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        // Two calls because they answer different questions: the probe is live,
        // the diagnostics are the recent failure history.
        const [health, diagnostics] = await Promise.all([
          ctx.qoren.agents.healthcheck(id),
          ctx.qoren.agents.diagnostics(id),
        ]);
        emit({ health, diagnostics }, () => {
          process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
          if (diagnostics.groups.length === 0) {
            note(dim("\nNo recent failures."));
            return;
          }
          note(bold("\nRecent failures"));
          table(diagnostics.groups, [
            { header: "category", value: (g) => g.category },
            { header: "tool", value: (g) => g.tool ?? "" },
            { header: "count", value: (g) => String(g.count) },
            { header: "sample", value: (g) => g.sample },
          ]);
        });
      })(),
    );

  agent
    .command("doctor <id>")
    .description(
      "Run the runtime's own doctor and let it repair what it finds; --history shows past checkups",
    )
    .option("--no-repair", "report only, do not let the runtime repair itself")
    .option("--no-wait", "return as soon as the checkup is underway")
    .option("--history", "list recent checkups instead of running one")
    .option("--limit <n>", "checkups to list with --history", "10")
    .action(
      (
        id: string,
        options: {
          repair: boolean;
          wait: boolean;
          history?: boolean;
          limit: string;
        },
      ) =>
        run(async () => {
          const ctx = requireContext(global());
          if (options.history) {
            const runs = await ctx.qoren.agents.doctorRuns(
              id,
              Number(options.limit),
            );
            emit(runs, () => doctorTable(runs));
            return;
          }
          let current = await ctx.qoren.agents.runDoctor(id, {
            repair: options.repair,
          });
          if (options.wait && current.status === "running") {
            note(dim("Checkup underway; a repair can take a few minutes."));
            current = await waitForDoctor(ctx, id, current.id);
          }
          emit(current, () => printDoctorRun(current));
          if (
            current.status === "needs_attention" ||
            current.status === "failed"
          ) {
            process.exitCode = 1;
          }
        })(),
    );

  agent
    .command("health")
    .description("Show the latest health check of every agent")
    .action(() =>
      run(async () => {
        const ctx = requireContext(global());
        const [readings, agents] = await Promise.all([
          ctx.qoren.agents.health(),
          ctx.qoren.agents.list(),
        ]);
        const names = new Map(agents.map((a) => [a._id, a.name]));
        emit(readings, () =>
          table(readings, [
            { header: "agent", value: (r) => names.get(r.agentId) ?? r.agentId },
            { header: "status", value: (r) => r.status },
            { header: "detail", value: (r) => r.detail ?? "" },
            { header: "checked", value: (r) => age(new Date(r.checkedAt).toISOString()) },
          ]),
        );
      })(),
    );

  agent
    .command("telemetry <id>")
    .description("Show an agent's model spend")
    .option("--days <n>", "window in days")
    .action((id: string, options: { days?: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const data = await ctx.qoren.agents.telemetry(
          id,
          options.days ? Number.parseInt(options.days, 10) : undefined,
        );
        emit(data, () =>
          process.stdout.write(`${JSON.stringify(data, null, 2)}\n`),
        );
      })(),
    );

  agent
    .command("usage <id>")
    .description(
      "Show what an agent spent: credits charged, and its sessions on either key",
    )
    .option("--days <n>", "window in days (1 to 90)", "30")
    .action((id: string, options: { days: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const data = await ctx.qoren.agents.usage(
          id,
          Number.parseInt(options.days, 10),
        );
        emit(data, () => printUsage(data));
      })(),
    );

  agent
    .command("limits <id>")
    .description(
      "Show an agent's daily, weekly and monthly spend caps in credits, or change them",
    )
    .option("--daily <credits>", 'cap per UTC day, or "off" to remove it', parseSpendCap)
    .option("--weekly <credits>", 'cap per UTC week (Monday to Sunday), or "off"', parseSpendCap)
    .option("--monthly <credits>", 'cap per UTC month, or "off"', parseSpendCap)
    .action((id: string, options: SpendCapFlags) =>
      run(async () => {
        const ctx = requireContext(global());
        const current = await ctx.qoren.agents.getSpendLimits(id);
        const caps = mergeSpendCaps(current, options);
        if (caps === null) {
          emit(current, () => printSpendLimits(current));
          return;
        }
        const updated = await ctx.qoren.agents.setSpendLimits(id, caps);
        note("Spend limits saved.");
        emit(updated, () => printSpendLimits(updated));
        const reached = capsAlreadyReached(updated);
        if (updated.key === "agent" && reached.length > 0) {
          warn(
            reached.length === 1
              ? `The ${reached[0]} cap is already reached, so the agent's model calls stop until that window resets.`
              : `The ${reached.join(" and ")} caps are already reached, so the agent's model calls stop until those windows reset.`,
          );
        }
      })(),
    );

  agent
    .command("chatgpt-login <id>")
    .description("Sign an agent into your ChatGPT account with a one-time code")
    .option("--no-wait", "print the job id and exit instead of following it")
    .action((id: string, options: { wait: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        const started = await ctx.qoren.agents.startDeviceLogin(id);
        if (!options.wait) {
          emit(started, () => note(`Job ${bold(started.jobId)} started.`));
          return;
        }

        // Half of this flow happens in a browser, so the code has to be on
        // screen before anything else is said.
        const prompt = await awaitDeviceCode(ctx, started.jobId);
        if (prompt) {
          emit({ jobId: started.jobId, ...prompt }, () => {
            note(`\nOpen ${bold(prompt.verificationUrl)} and enter this code:`);
            note(`\n  ${bold(prompt.userCode)}\n`);
            note(
              dim(
                "The code is good for about 15 minutes. This command waits until you approve.",
              ),
            );
          });
        }

        const job = await followJob(
          ctx,
          started.jobId,
          prompt ? dim("Waiting for your approval…") : dim("Signing in…"),
        );
        const authMode =
          (job.result as { authMode?: string } | null)?.authMode ?? "chatgpt";
        emit({ jobId: started.jobId, ok: true, authMode }, () =>
          note(
            "Signed in. This agent's turns now run on your ChatGPT plan credits instead of the platform inference key.",
          ),
        );
      })(),
    );

  agent
    .command("chatgpt-logout <id>")
    .description("Sign an agent out of ChatGPT and back onto the platform key")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.agents.deviceLogout(id);
        // The credential lives on the environment, so this takes effect on the
        // agent's next turn rather than on one already running.
        emit(result, () =>
          note(
            `Signed out. From its next turn the agent runs on the platform inference key (${result.mode}).`,
          ),
        );
      })(),
    );

  // --- public file links ---------------------------------------------------
  //
  // The same links an agent mints for itself with files_share. A link is a URL
  // with no sign-in behind it, so the create response is the only place its
  // token ever appears: `share` writes the URL to stdout and nothing else, which
  // is also what makes it pipeable into a message. The URL is a page on the
  // console that renders the file; the recipient downloads from there if they
  // want the file itself.

  agent
    .command("share <id> <path>")
    .description("Publish a workspace file as an expiring public URL")
    .option(
      "--expires <duration>",
      "how long the link works, e.g. 30m, 2h, 3d",
      "7d",
    )
    .option("--label <text>", "a short note so you can tell links apart")
    .option(
      "--max-downloads <n>",
      "stop serving after this many opens or downloads",
    )
    .action(
      (
        id: string,
        path: string,
        options: { expires: string; label?: string; maxDownloads?: string },
      ) =>
        run(async () => {
          const ctx = requireContext(global());
          const expiresInSeconds = parseDuration(options.expires);
          if (expiresInSeconds === null) {
            throw new Error(
              `Could not read "${options.expires}" as a duration. Use a number and a unit, like 30m, 2h or 3d.`,
            );
          }
          let maxDownloads: number | undefined;
          if (options.maxDownloads !== undefined) {
            maxDownloads = Number.parseInt(options.maxDownloads, 10);
            if (!Number.isFinite(maxDownloads) || maxDownloads < 1) {
              throw new Error(
                "--max-downloads must be a whole number of 1 or more.",
              );
            }
          }

          const link = await ctx.qoren.agents.createFileLink(id, {
            path,
            expiresInSeconds,
            ...(options.label ? { label: options.label } : {}),
            ...(maxDownloads !== undefined ? { maxDownloads } : {}),
          });

          emit(link, () => {
            // The URL is the whole point of the command, so it is the only thing
            // on stdout. Everything explaining it goes to stderr.
            if (link.url) process.stdout.write(`${link.url}\n`);
            note(
              dim(
                `Anyone with this URL can open ${link.path} in a browser, and download it from there, until ${new Date(link.expiresAt).toISOString()}, with no sign-in.`,
              ),
            );
            warn(
              "This URL is shown once. Revoke it with qoren agent unshare once it has been collected.",
            );
          });
        })(),
    );

  agent
    .command("links <id>")
    .description("List the files this agent has published as public links")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const links = await ctx.qoren.agents.listFileLinks(id);
        emit(links, () => {
          if (links.length === 0) {
            note(dim("This agent has published nothing."));
            return;
          }
          // No url column: a listing cannot read a token back, so printing an
          // empty one would only look like something had gone missing.
          table(links, [
            { header: "linkId", value: (l: AgentFileLink) => l.linkId },
            { header: "path", value: (l: AgentFileLink) => l.path },
            { header: "label", value: (l: AgentFileLink) => l.label ?? "" },
            {
              header: "status",
              value: (l: AgentFileLink) => statusColor(l.status),
            },
            {
              header: "expires",
              value: (l: AgentFileLink) => new Date(l.expiresAt).toISOString(),
            },
            {
              // Opening the link counts here too: the viewer fetches the file to show it.
              header: "opened",
              value: (l: AgentFileLink) =>
                l.maxDownloads == null
                  ? String(l.downloadCount)
                  : `${l.downloadCount}/${l.maxDownloads}`,
            },
          ]);
        });
      })(),
    );

  agent
    .command("unshare <id> <linkId>")
    .description("Switch off a public link (see qoren agent links)")
    .action((id: string, linkId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const link = await ctx.qoren.agents.revokeFileLink(id, linkId);
        emit(link, () =>
          note(
            `Revoked. The URL for ${bold(link.path)} no longer works for anyone holding it.`,
          ),
        );
      })(),
    );

  agent
    .command("import <bundle>")
    .description(
      "Deploy an agent from an export made with `curl -fsSL https://qoren.sh/migrate.sh | sh`",
    )
    .option(
      "--env <id>",
      "environment to deploy onto (required unless --dry-run)",
    )
    .option(
      "--name <name>",
      "display name (defaults to the bundle's file name)",
    )
    .option("--slug <slug>", "machine identity (defaults to the name)")
    .option(
      "--model <model>",
      "model id (defaults to what the export used, then your account default)",
    )
    .option(
      "--template <name>",
      "name for the saved template (defaults to the agent name)",
    )
    .option(
      "--import-secrets",
      "store the secret values carried by a --with-secrets export in the vault and attach them",
    )
    .option(
      "--dry-run",
      "print what would be sent and stop before any API call",
    )
    .option("--no-wait", "print the job id and exit instead of following it")
    .action(
      (
        bundlePath: string,
        options: {
          env?: string;
          name?: string;
          slug?: string;
          model?: string;
          template?: string;
          importSecrets?: boolean;
          dryRun?: boolean;
          wait: boolean;
        },
      ) =>
        run(async () => {
          const bundle = parseBundle(
            readTar(gunzipSync(readFileSync(bundlePath))),
          );
          const plan = planImport(bundle);

          const name =
            options.name ??
            basename(bundlePath)
              .replace(/\.tar\.gz$|\.tgz$/i, "")
              .replace(/^qoren-export-/, "")
              .replace(/-\d{8}-\d{6}$/, "");
          const slug = options.slug ?? slugify(name);
          if (!slug) {
            throw new Error(
              "Could not derive a slug from that name. Pass --slug explicitly.",
            );
          }
          const templateName = options.template ?? name;

          if (options.dryRun) {
            const preview = {
              ...plan,
              name,
              slug,
              templateName,
              // Values never belong in a preview; names say what would be set.
              secrets: Object.keys(plan.secrets),
              workspaceFiles: plan.workspaceFiles.map((f) => f.path),
              runtimeFiles: plan.runtimeFiles.map((f) => f.path),
            };
            emit(preview, () => {
              details([
                ["runtime", plan.runtime],
                ["model", plan.model ?? dim("(account default)")],
                ["name", `${name} (${slug})`],
                ["persona", `${plan.soulMd.length} chars`],
                [
                  "operating manual",
                  plan.agentsMd ? `${plan.agentsMd.length} chars` : dim("none"),
                ],
                [
                  "mcp servers",
                  plan.mcpServers.map((m) => m.name).join(", ") || dim("none"),
                ],
                [
                  "scheduled tasks",
                  plan.scheduledTasks.map((t) => t.name).join(", ") ||
                    dim("none"),
                ],
                ["seed files", String(plan.workspaceFiles.length)],
                ["runtime files", String(plan.runtimeFiles.length)],
                ["env keys", plan.envNames.join(", ") || dim("none")],
                [
                  "secret values",
                  Object.keys(plan.secrets).join(", ") || dim("none"),
                ],
              ]);
              for (const line of plan.notes) warn(line);
            });
            return;
          }

          if (!options.env) {
            throw new Error(
              "Pass --env <environment-id> (see qoren env ls), or --dry-run to preview.",
            );
          }
          const ctx = requireContext(global());
          for (const line of plan.notes) warn(line);

          const model =
            options.model ??
            plan.model ??
            (await ctx.qoren.account.options()).defaultModel;
          if (!model) {
            throw new Error("No model available. Pass --model explicitly.");
          }

          const result = await applyPlan(ctx, plan, {
            environmentId: options.env,
            name,
            slug,
            runtime: plan.runtime,
            model,
            templateName,
            importSecrets: options.importSecrets === true,
            wait: options.wait,
          });
          emit(result, () => {
            if (!result.ok) {
              note(
                `Job ${bold(result.jobId)} started. Template saved as ${bold(result.templateSlug)}.`,
              );
              return;
            }
            note(`Agent ${bold(name)} is running on Qoren.`);
            if (result.runtimeFilesCopied > 0) {
              note(
                `  ${dim("·")} ${result.runtimeFilesCopied} memory/skill file(s) copied into the runtime home`,
              );
            }
            if (plan.envNames.some((n) => !result.secretsSet.includes(n))) {
              note(
                `  ${dim("·")} attach the remaining keys from the console's Secrets tab`,
              );
            }
          });
        })(),
    );

  customAgentCommands(agent, global);
}

// The usage summary for a terminal: the settled credits first (what the
// account paid), then the session ledger grouped by source (what the agent
// did, whichever key paid for it).
function printUsage(data: AgentUsage): void {
  const n = (value: number) => Math.round(value).toLocaleString("en-US");
  const c = data.charges;
  details([
    ["Window", `${new Date(data.from).toLocaleDateString()} to now`],
    ["Key", data.billingMode === "byok" ? "your own key" : data.billingMode],
    ["Model credits", n(c.llmCredits)],
    ["Web search", `${n(c.webSearchCredits)} credits, ${n(c.webSearches)} searches`],
    [
      "Environment",
      `${n(c.environmentCredits)} credits, shared by ${c.environmentAgents} agents`,
    ],
    ["Unsettled", c.pendingSettlements > 0 ? `${c.pendingSettlements} charges` : ""],
  ]);

  const ledger = data.ledger;
  if (ledger.status !== "ok") {
    note(dim(ledger.detail ?? `Session ledger: ${ledger.status}.`));
    return;
  }
  const bySource = new Map<
    string,
    { source: string; sessions: number; tokens: number; costUsd: number }
  >();
  for (const b of ledger.buckets) {
    const source = ledger.sources[b[1] ?? 0] ?? "unknown";
    const row = bySource.get(source) ?? { source, sessions: 0, tokens: 0, costUsd: 0 };
    row.sessions += b[3] ?? 0;
    row.tokens += (b[4] ?? 0) + (b[5] ?? 0) + (b[6] ?? 0) + (b[7] ?? 0) + (b[8] ?? 0);
    row.costUsd += b[9] ?? 0;
    bySource.set(source, row);
  }
  process.stdout.write("\n");
  table(
    [...bySource.values()].sort((a, b) => b.costUsd - a.costUsd),
    [
      { header: "Source", value: (r) => r.source },
      { header: "Sessions", value: (r) => n(r.sessions) },
      { header: "Tokens", value: (r) => n(r.tokens) },
      { header: "Provider cost", value: (r) => `$${r.costUsd.toFixed(4)}` },
    ],
  );
}
