import type { Command } from "commander";
import type {
  ApprovalDecisionInput,
  ApprovalRequest,
  ApprovalSource,
} from "@qoren/sdk";
import { requireContext, run, type GlobalOptions } from "../context.js";
import { age, bold, dim, emit, note, statusColor, table } from "../output.js";

// Approval requests: what your agents want to do that waits for you.
//
//   qoren approvals            what is waiting, across every agent
//   qoren approvals approve <id>
//   qoren approvals deny <id> --note "Send it to the shared inbox instead"
//
// Three things land here: a command an agent in approval mode proposed, what a
// trigger set to Propose only would have done, and the platform tools that can
// do lasting damage (destroying, resizing, moving or rebuilding). A request
// nobody decides expires after 24 hours. A Custom agent's approval is one-shot:
// once the approved action has run it shows as executed.

const SOURCE_LABELS: Record<ApprovalSource, string> = {
  chat: "chat",
  trigger: "trigger",
  platform_tool: "platform tool",
  repair: "self-repair",
};

function sourceText(a: ApprovalRequest): string {
  const base = SOURCE_LABELS[a.source] ?? a.source;
  return a.sourceLabel ? `${base}: ${a.sourceLabel}` : base;
}

/** Time left before an undecided request expires, e.g. "5h 12m". */
function remaining(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** What the request would do, on one line for the table. A file approval
 * names its exact change and a short hash of the content it is bound to. */
export function wantsTo(a: ApprovalRequest): string {
  if (a.fileOp) {
    return `${a.fileOp.op} ${a.fileOp.path} (sha256 ${a.fileOp.contentSha256.slice(0, 12)})`;
  }
  return a.displayCommand.replace(/\s*\n\s*/g, " ").trim();
}

/** Requests whose command spans lines: the table shows them flattened, so the
 * exact text follows the table in full. */
export function multiLine(rows: ApprovalRequest[]): ApprovalRequest[] {
  return rows.filter((a) => !a.fileOp && a.displayCommand.includes("\n"));
}

function approvalTable(rows: ApprovalRequest[], decided: boolean): void {
  table(rows, [
    { header: "id", value: (a) => a.id },
    { header: "agent", value: (a) => a.agentName ?? a.agentId },
    { header: "wants to", value: wantsTo },
    { header: "from", value: (a) => sourceText(a) },
    { header: "risk", value: (a) => a.risk },
    decided
      ? { header: "status", value: (a) => statusColor(a.status) }
      : { header: "expires in", value: (a) => remaining(a.expiresAt) },
    { header: "asked", value: (a) => age(a.createdAt) },
  ]);
  for (const a of multiLine(rows)) {
    note(`\n${bold(a.id)} wants to run, in full:\n${a.displayCommand}`);
  }
}

/** Decide the given request ids. Each is looked up among the pending requests
 * first, because the decision is addressed to the agent that asked; ids from
 * the same agent go in one call, so a turn with several proposals resumes the
 * agent once. */
async function decide(
  global: () => GlobalOptions,
  ids: string[],
  approve: boolean,
  noteText: string | undefined,
): Promise<void> {
  const ctx = requireContext(global());
  const pending = await ctx.qoren.approvals.list({
    status: "pending",
    limit: 200,
  });
  const byId = new Map(pending.map((a) => [a.id, a]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Not waiting for a decision: ${missing.join(", ")}. It may have been decided already or expired. See qoren approvals ls --all.`,
    );
  }
  const byAgent = new Map<string, ApprovalDecisionInput[]>();
  for (const id of ids) {
    const agentId = byId.get(id)!.agentId;
    const list = byAgent.get(agentId) ?? [];
    list.push({
      approvalId: id,
      approve,
      ...(noteText && !approve ? { note: noteText } : {}),
    });
    byAgent.set(agentId, list);
  }
  const jobIds: string[] = [];
  for (const [agentId, decisions] of byAgent) {
    const res = await ctx.qoren.approvals.decide(agentId, decisions);
    jobIds.push(...res.jobIds);
  }
  emit({ decided: ids, approve, jobIds }, () => {
    note(
      `${approve ? "Approved" : "Denied"} ${ids.length} request${ids.length === 1 ? "" : "s"}.`,
    );
    if (approve && jobIds.length > 0) {
      note(dim(`Follow along: qoren jobs get ${jobIds[0]}`));
    }
  });
}

export function approvalCommands(
  program: Command,
  global: () => GlobalOptions,
) {
  const approvals = program
    .command("approvals")
    .alias("approval")
    .description("Approve or deny what your agents asked to do");

  approvals
    .command("ls", { isDefault: true })
    .alias("list")
    .description("Requests waiting for a decision, across every agent")
    .option("--decided", "show approved, denied, expired and executed requests instead")
    .option("--all", "show waiting and decided requests together")
    .option("--limit <n>", "how many to show (1 to 200)", "50")
    .action((options: { decided?: boolean; all?: boolean; limit: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const status = options.all
          ? "all"
          : options.decided
            ? "decided"
            : "pending";
        const rows = await ctx.qoren.approvals.list({
          status,
          limit: Number(options.limit) || 50,
        });
        emit(rows, () =>
          rows.length
            ? approvalTable(rows, status !== "pending")
            : note(
                status === "pending"
                  ? "Nothing is waiting for you."
                  : "No decided requests yet.",
              ),
        );
      })(),
    );

  approvals
    .command("approve <id...>")
    .description("Approve requests; approved actions go ahead")
    .action((ids: string[]) =>
      run(() => decide(global, ids, true, undefined))(),
    );

  approvals
    .command("deny <id...>")
    .description("Deny requests; nothing runs")
    .option("--note <text>", "tell the agent why, and what to do instead")
    .action((ids: string[], options: { note?: string }) =>
      run(() => decide(global, ids, false, options.note))(),
    );
}
