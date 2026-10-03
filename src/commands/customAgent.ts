import type { Command } from "commander";
import {
  TERMINAL_RUN_STATUSES,
  type AddChannelInput,
  type DesignChatResult,
  type DesignerChannelKind,
  type DesignRun,
  type DesignRunStatus,
} from "@qoren/sdk";
import { requireContext, run, type GlobalOptions } from "../context.js";
import { parseDuration } from "../duration.js";
import { followJob } from "../jobProgress.js";
import { age, bold, details, dim, emit, note, statusColor, table, warn } from "../output.js";
import { gated, matchEnvironment, resolveClient } from "./clients.js";
import { readJsonArg } from "../args.js";

// Operating a Custom agent: the verbs under `qoren agent` that only make sense
// for an agent built in the Agent Designer. Runs, chat and threads read from the
// Designer; channels and attached environments wire the agent to the world.
// A hosted agent answers these with a 409, and `qoren agent message` still
// works for both kinds.

const RUN_STATUSES: DesignRunStatus[] = [
  "queued",
  "running",
  "waiting",
  "parked_credits",
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "budget_exceeded",
];

const CHANNEL_KINDS: DesignerChannelKind[] = ["slack", "telegram", "discord"];

const ago = (value: number | null | undefined): string =>
  value ? age(new Date(value).toISOString()) : "";

export function isTerminalRun(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** How long a run took, or has been going. */
export function runDuration(r: Pick<DesignRun, "startedAt" | "endedAt">, now = Date.now()): string {
  const ms = (r.endedAt ?? now) - r.startedAt;
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** A run's status with what it waits on, e.g. "waiting (approval)". */
export function runStatus(r: Pick<DesignRun, "status" | "waitingOn">): string {
  return r.waitingOn && !isTerminalRun(r.status)
    ? `${statusColor(r.status)} ${dim(`(${r.waitingOn})`)}`
    : statusColor(r.status);
}

function oneLine(text: string | null | undefined, max = 80): string {
  const line = (text ?? "").split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function runTable(runs: DesignRun[]): void {
  table(runs, [
    { header: "run", value: (r) => r.runId },
    { header: "status", value: runStatus },
    { header: "trigger", value: (r) => r.trigger.kind },
    { header: "started", value: (r) => ago(r.startedAt) },
    { header: "took", value: (r) => runDuration(r) },
    { header: "credits", value: (r) => String(Math.round(r.spentCredits)) },
    { header: "note", value: (r) => oneLine(r.error ?? r.trigger.summary) },
  ]);
}

function printResult(result: unknown): void {
  if (result === null || result === undefined) return;
  process.stdout.write(
    typeof result === "string" ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`,
  );
}

export function printRun(r: DesignRun): void {
  details([
    ["Run", r.runId],
    ["Status", runStatus(r)],
    ["Trigger", [r.trigger.kind, r.trigger.nodeId, r.trigger.summary].filter(Boolean).join(" · ")],
    ["Version", r.version == null ? "" : `v${r.version}`],
    ["Thread", r.threadId ?? ""],
    ["Credits", String(Math.round(r.spentCredits))],
    ["Started", new Date(r.startedAt).toISOString()],
    ["Took", runDuration(r)],
    ["Error", r.error ?? ""],
  ]);
  if (r.steps?.length) {
    note(bold("\nSteps"));
    table(r.steps, [
      { header: "#", value: (s) => String(s.seq) },
      { header: "node", value: (s) => s.nodeId },
      { header: "kind", value: (s) => s.kind },
      { header: "status", value: (s) => statusColor(s.status) },
      { header: "credits", value: (s) => (s.credits ? String(Math.round(s.credits)) : "") },
      { header: "note", value: (s) => oneLine(s.error ?? s.outputPreview, 60) },
    ]);
  }
  if (r.result !== null && r.result !== undefined) {
    note(bold("\nResult"));
    printResult(r.result);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a run until it finishes or the time is up. Says once what a waiting run
 * waits on, because an approval can take hours and silence looks like a hang.
 * `read` fetches the run: an agent's run or a design's test run.
 */
export async function waitForRun(
  read: () => Promise<DesignRun>,
  timeoutSeconds: number,
): Promise<{ run: DesignRun; finished: boolean }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let said = "";
  for (;;) {
    const current = await read();
    if (isTerminalRun(current.status)) return { run: current, finished: true };
    const state = `${current.status}${current.waitingOn ? `:${current.waitingOn}` : ""}`;
    if (state !== said) {
      said = state;
      note(dim(current.waitingOn ? `  waiting on ${current.waitingOn}…` : `  ${current.status}…`));
    }
    if (Date.now() > deadline) return { run: current, finished: false };
    await sleep(2000);
  }
}

/** Read `--timeout` for a `--wait`. */
export function parseWaitTimeout(value: string): number {
  const timeout = parseDuration(value);
  if (timeout === null) {
    throw new Error(`Could not read "${value}" as a duration. Use one like 30m or 2h.`);
  }
  return timeout;
}

/** The end of a waited-for run, for a person: outcome, cost, result. Sets the
 * exit code when it did not succeed or is still going. */
export function reportWaitedRun(
  { run: r, finished }: { run: DesignRun; finished: boolean },
  timeoutText: string,
  checkBack: string,
  options: { trace?: boolean } = {},
): void {
  emit(r, () => {
    if (!finished) {
      warn(`Still ${r.status} after ${timeoutText}. Check back with ${checkBack}`);
      return;
    }
    if (options.trace) {
      printRun(r);
      return;
    }
    note(`${runStatus(r)} ${dim(`in ${runDuration(r)}, ${Math.round(r.spentCredits)} credits`)}`);
    if (r.error) warn(r.error);
    printResult(r.result);
  });
  if (!finished || r.status !== "succeeded") process.exitCode = 1;
}

function parseLimit(value: string | undefined, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`--limit must be between 1 and ${max}.`);
  }
  return n;
}

export type ChannelAddOptions = {
  botToken?: string;
  signingSecret?: string;
  guild?: string;
  botName?: string;
  allMessages?: boolean;
};

/** The connect request for `channel add`, refusing what the control plane
 * would refuse before anything is sent: an unknown kind, no bot token, a Slack
 * app without its signing secret, or a Discord bot without its server id
 * (the bot only ignores other servers when it is bound to one). */
export function channelInput(kind: string, options: ChannelAddOptions): AddChannelInput {
  if (!CHANNEL_KINDS.includes(kind as DesignerChannelKind)) {
    throw new Error(`Unknown channel "${kind}". Choose one of: ${CHANNEL_KINDS.join(", ")}.`);
  }
  const botToken = options.botToken?.trim();
  if (!botToken) throw new Error("Pass --bot-token, or set QOREN_BOT_TOKEN.");
  switch (kind as DesignerChannelKind) {
    case "slack": {
      const signingSecret = options.signingSecret?.trim();
      if (!signingSecret) {
        throw new Error("Slack needs your app's signing secret: pass --signing-secret, or set QOREN_SIGNING_SECRET.");
      }
      return {
        kind: "slack",
        credentials: { botToken, signingSecret },
        ...(options.botName ? { botName: options.botName } : {}),
      };
    }
    case "discord": {
      const guildId = options.guild?.trim();
      if (!guildId) {
        throw new Error(
          "Discord needs the server (guild) id the bot answers in: pass --guild <id>. In Discord, turn on Developer Mode (User Settings, Advanced), then right-click the server and choose Copy Server ID.",
        );
      }
      return {
        kind: "discord",
        credentials: { botToken, guildId },
        ...(options.allMessages ? { mentionsOnly: false } : {}),
      };
    }
    default:
      return { kind: "telegram", credentials: { botToken } };
  }
}

export function customAgentCommands(agent: Command, global: () => GlobalOptions) {
  agent
    .command("run <id>")
    .description("Start a manual run of a Custom agent")
    .option("--input <json>", "the run's input, inline or as @file.json")
    .option("--key <idempotencyKey>", "the same key twice returns the first run instead of starting another")
    .option("--wait", "wait for the run to finish and print its result")
    .option("--timeout <duration>", "with --wait: give up after this long, e.g. 10m", "30m")
    .action(
      (id: string, options: { input?: string; key?: string; wait?: boolean; timeout: string }) =>
        run(async () => {
          const input = options.input !== undefined ? readJsonArg(options.input, "--input") : undefined;
          const timeout = parseWaitTimeout(options.timeout);
          const ctx = requireContext(global());
          const started = await ctx.qoren.agents.run(id, {
            ...(input !== undefined ? { input } : {}),
            ...(options.key ? { idempotencyKey: options.key } : {}),
          });
          if (!options.wait) {
            emit(started, () =>
              note(
                started.existing
                  ? `Run ${bold(started.runId)} already exists for that key (${started.status}).`
                  : `Run ${bold(started.runId)} started. Check it with: qoren agent run-get ${id} ${started.runId}`,
              ),
            );
            return;
          }
          note(dim(`Run ${started.runId} started.`));
          reportWaitedRun(
            await waitForRun(() => ctx.qoren.agents.getRun(id, started.runId), timeout),
            options.timeout,
            `qoren agent run-get ${id} ${started.runId}`,
          );
        })(),
    );

  agent
    .command("runs <id>")
    .description("List a Custom agent's recent runs")
    .option("--status <status>", `only runs in this state: ${RUN_STATUSES.join(", ")}`)
    .option("--limit <n>", "how many, up to 100", "25")
    .option("--cursor <cursor>", "the next page, from a previous --json answer")
    .action((id: string, options: { status?: string; limit?: string; cursor?: string }) =>
      run(async () => {
        if (options.status && !RUN_STATUSES.includes(options.status as DesignRunStatus)) {
          throw new Error(`Unknown status "${options.status}". Choose one of: ${RUN_STATUSES.join(", ")}.`);
        }
        const limit = parseLimit(options.limit, 100);
        const ctx = requireContext(global());
        const page = await ctx.qoren.agents.runs(id, {
          ...(options.status ? { status: options.status as DesignRunStatus } : {}),
          ...(limit ? { limit } : {}),
          ...(options.cursor ? { cursor: options.cursor } : {}),
        });
        emit(page, () => {
          runTable(page.runs);
          if (page.cursor) note(dim(`More: qoren agent runs ${id} --cursor ${page.cursor}`));
        });
      })(),
    );

  agent
    .command("run-get <id> <runId>")
    .description("Show one run: status, steps and result")
    .action((id: string, runId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const r = await ctx.qoren.agents.getRun(id, runId);
        emit(r, () => printRun(r));
      })(),
    );

  agent
    .command("run-cancel <id> <runId>")
    .description("Stop a run")
    .action((id: string, runId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.agents.cancelRun(id, runId);
        emit(result, () =>
          note(result.cancelled ? `Run ${bold(runId)} cancelled.` : `Run ${bold(runId)} had already finished.`),
        );
      })(),
    );

  agent
    .command("chat <id> <message>")
    .description("Chat with a Custom agent and wait for its reply")
    .option("--thread <threadId>", "continue a conversation (see qoren agent threads)")
    .option("--no-wait", "print the job id and exit instead of waiting")
    .action((id: string, message: string, options: { thread?: string; wait: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        const started = await ctx.qoren.agents.chat(id, message, options.thread ?? null);
        if (!options.wait) {
          emit(started, () => note(`Job ${bold(started.jobId)} started in thread ${started.threadId}.`));
          return;
        }
        const job = await followJob(ctx, started.jobId, dim("Thinking…"));
        const reply = (job.result ?? null) as DesignChatResult | null;
        emit({ ...started, reply: reply?.stdOut ?? null, output: reply?.output ?? null }, () => {
          if (reply?.stdOut) process.stdout.write(`${reply.stdOut.replace(/\n?$/, "\n")}`);
          note(dim(`Continue with: qoren agent chat ${id} --thread ${started.threadId} "..."`));
        });
        if (reply && reply.exitCode !== 0) process.exitCode = 1;
      })(),
    );

  agent
    .command("threads <id> [threadId]")
    .description("List a Custom agent's conversations, or show one conversation's messages")
    .option("--limit <n>", "how many, up to 100")
    .option("--cursor <cursor>", "the next page, from a previous --json answer")
    .action(
      (id: string, threadId: string | undefined, options: { limit?: string; cursor?: string }) =>
        run(async () => {
          const limit = parseLimit(options.limit, 100);
          const page = {
            ...(limit ? { limit } : {}),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          };
          const ctx = requireContext(global());
          if (!threadId) {
            const threads = await ctx.qoren.agents.threads(id, page);
            emit(threads, () => {
              table(threads.threads, [
                { header: "thread", value: (t) => t.threadId },
                { header: "channel", value: (t) => t.channel },
                { header: "title", value: (t) => oneLine(t.title, 50) },
                { header: "last message", value: (t) => ago(t.lastMessageAt) },
                { header: "active run", value: (t) => t.activeRunId ?? "" },
              ]);
              if (threads.cursor) note(dim(`More: qoren agent threads ${id} --cursor ${threads.cursor}`));
            });
            return;
          }
          const messages = await ctx.qoren.agents.threadMessages(id, threadId, page);
          emit(messages, () => {
            for (const m of messages.messages) {
              const who = m.role === "user" ? bold("you") : m.role === "assistant" ? bold("agent") : dim(m.role);
              process.stdout.write(`${dim(new Date(m.createdAt).toISOString())} ${who}\n${m.text}\n\n`);
            }
            if (messages.cursor) {
              note(dim(`Older: qoren agent threads ${id} ${threadId} --cursor ${messages.cursor}`));
            }
          });
        })(),
    );

  agent
    .command("client <id> <client>")
    .description('Assign a Custom agent to an agency client, by id or name, or "none" to clear it')
    .action((id: string, ref: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const clear = ref.toLowerCase() === "none";
        const client = clear ? null : await resolveClient(ctx, ref);
        const result = await gated(ctx.qoren.agents.setClient(id, client?.id ?? null));
        emit(result, () =>
          note(
            client
              ? `${bold(result.agent.name)} now works for ${bold(client.name)}. Its cost from now on is theirs.`
              : `${bold(result.agent.name)} no longer has a client.`,
          ),
        );
      })(),
    );

  // --- channels ---------------------------------------------------------------

  const channel = agent
    .command("channel")
    .alias("channels")
    .description("Connect a Custom agent to Slack, Telegram or Discord");

  channel
    .command("ls <id>")
    .alias("list")
    .description("List a Custom agent's channels")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const channels = await ctx.qoren.agents.channels.list(id);
        emit(channels, () =>
          table(channels, [
            { header: "id", value: (c) => c.id },
            { header: "kind", value: (c) => c.kind },
            { header: "bot", value: (c) => c.bot ?? c.address ?? "" },
            { header: "status", value: (c) => statusColor(c.status) },
            { header: "last event", value: (c) => ago(c.lastEventAt) },
            { header: "error", value: (c) => oneLine(c.lastError, 60) },
          ]),
        );
      })(),
    );

  channel
    .command("add <id> <kind>")
    .description(
      `Connect a bot (${CHANNEL_KINDS.join(", ")}). Slack is your own app: pass its signing secret too. Discord needs --guild`,
    )
    .option("--bot-token <token>", "the bot token (or set QOREN_BOT_TOKEN to keep it out of shell history)")
    .option("--signing-secret <secret>", "Slack only: the app's signing secret (or set QOREN_SIGNING_SECRET)")
    .option(
      "--guild <id>",
      "Discord only, required: the server id the bot answers in (Developer Mode on, then right-click the server, Copy Server ID)",
    )
    .option("--bot-name <name>", "Slack only: the bot's name in the generated app manifest")
    .option("--all-messages", "Discord only: answer every message in a channel, not only mentions")
    .action(
      (
        id: string,
        kind: string,
        options: ChannelAddOptions,
      ) =>
        run(async () => {
          const input = channelInput(kind, {
            ...options,
            botToken: options.botToken ?? process.env.QOREN_BOT_TOKEN,
            signingSecret: options.signingSecret ?? process.env.QOREN_SIGNING_SECRET,
          });
          const ctx = requireContext(global());
          const result = await ctx.qoren.agents.channels.add(id, input);
          emit(result, () => {
            const bot = result.channel.bot ? ` as ${bold(result.channel.bot)}` : "";
            note(`Connected ${kind}${bot}: channel ${bold(result.channel.id)} (${result.channel.status}).`);
            if (result.requestUrl) {
              note(`Paste this request URL into your Slack app's Event Subscriptions:\n  ${bold(result.requestUrl)}`);
            }
            for (const step of result.instructions ?? []) note(`  ${dim("·")} ${step}`);
            if (result.manifest) {
              note(dim("Your Slack app manifest follows on stdout; paste it into the app's settings."));
              printResult(result.manifest);
            }
          });
        })(),
    );

  channel
    .command("rm <id> <channelId>")
    .alias("remove")
    .description("Disconnect a channel")
    .action((id: string, channelId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        await ctx.qoren.agents.channels.remove(id, channelId);
        emit({ ok: true, channelId }, () => note(`Channel ${bold(channelId)} disconnected.`));
      })(),
    );

  channel
    .command("test <id> <channelId>")
    .description("Check a channel still works with its provider")
    .action((id: string, channelId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.agents.channels.test(id, channelId);
        emit(result, () =>
          result.ok
            ? note(`Channel ${bold(channelId)} works (${result.status}).${result.detail ? ` ${result.detail}` : ""}`)
            : warn(`Channel ${channelId} is not working (${result.status}). ${result.detail ?? ""}`.trim()),
        );
        if (!result.ok) process.exitCode = 1;
      })(),
    );

  // --- attached environments ------------------------------------------------

  agent
    .command("attach <id> <environment>")
    .description("Let a Custom agent use an environment for shell and files, as its own confined user")
    .option("--approve", "ask a person to approve each command (runs unattended by default)")
    .option("--no-wait", "print the job id and exit instead of following the setup")
    .action((id: string, ref: string, options: { approve?: boolean; wait: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        const environment = matchEnvironment(await ctx.qoren.environments.list(), ref);
        const result = await ctx.qoren.agents.attachedEnvironments.attach(id, {
          machineId: environment.id,
          autonomy: options.approve ? "approve" : "auto",
        });
        if (!options.wait) {
          emit(result, () =>
            note(`Setting up ${bold(environment.name)} (${result.grant.id}) in job ${bold(result.jobId)}.`),
          );
          return;
        }
        await followJob(ctx, result.jobId, `Setting up access on ${bold(environment.name)}…`);
        emit({ ...result, grant: { ...result.grant, status: "ready" } }, () =>
          note(
            `Attached ${bold(environment.name)} (${result.grant.id}) as ${result.grant.unixUser}. ` +
              (options.approve ? "Each command waits for approval." : "Commands run unattended."),
          ),
        );
      })(),
    );

  agent
    .command("detach <id> <attachmentId>")
    .description("Take an environment away from a Custom agent and remove its user there")
    .option("--no-wait", "print the job id and exit instead of following the removal")
    .action((id: string, grantId: string, options: { wait: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.agents.attachedEnvironments.detach(id, grantId);
        if (!options.wait) {
          emit(result, () => note(`Removing ${bold(grantId)} in job ${bold(result.jobId)}.`));
          return;
        }
        await followJob(ctx, result.jobId, `Removing ${bold(grantId)}…`);
        emit(result, () => note(`Detached ${bold(grantId)}.`));
      })(),
    );

  agent
    .command("attached <id>")
    .description("List the environments a Custom agent may use")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const grants = await ctx.qoren.agents.attachedEnvironments.list(id);
        emit(grants, () =>
          table(grants, [
            { header: "id", value: (g) => g.id },
            { header: "environment", value: (g) => g.machineName ?? g.machineId },
            { header: "user", value: (g) => g.unixUser },
            { header: "autonomy", value: (g) => g.autonomy },
            { header: "status", value: (g) => statusColor(g.status) },
          ]),
        );
      })(),
    );
}
