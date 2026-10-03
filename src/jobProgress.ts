import type { Job, JobStep } from "@qoren/sdk";
import type { Context } from "./context.js";
import { dim, isJsonMode, note, statusColor } from "./output.js";

// Following a job in a terminal.
//
// Deploying an agent is twelve steps over SSH and takes minutes. Printing
// nothing for that long looks like a hang, and redrawing a live table breaks
// the moment output is piped to a file. So: one line per step, printed once,
// when that step starts. It reads as a log, works in CI, and never lies about
// where the job has got to.

function stepLabel(step: JobStep): string {
  return step.label || step.key;
}

/**
 * Await a job, printing each step as it begins. Returns the finished job.
 *
 * Silent in --json mode: the caller emits the result as data, and progress
 * chatter on stdout would corrupt it (see output.ts).
 */
export async function followJob(
  ctx: Context,
  jobId: string,
  headline?: string,
): Promise<Job> {
  if (isJsonMode()) return ctx.qoren.jobs.await(jobId);

  if (headline) note(headline);
  const announced = new Set<string>();
  let disconnected = false;

  const job = await ctx.qoren.jobs.await(jobId, (snapshot) => {
    if (!snapshot) {
      // A retryable outage swallowed the poll. Say so once rather than every
      // 2.5 seconds, and say it as "reconnecting" — the job itself is durable
      // and still there.
      if (!disconnected) {
        disconnected = true;
        note(dim("  reconnecting…"));
      }
      return;
    }
    disconnected = false;
    for (const step of snapshot.steps) {
      if (announced.has(step.key)) continue;
      // Only announce a step once it has actually started; a queued step is
      // not progress.
      if (step.status === "Pending") continue;
      announced.add(step.key);
      note(`  ${dim("·")} ${stepLabel(step)}`);
    }
  });

  note(`  ${statusColor("Succeeded")} ${dim(`(job ${jobId})`)}`);
  return job;
}

/** Step completion for `jobs ls`, e.g. "9/12". */
export function jobSummary(job: Job): string {
  const done = job.steps.filter((s) => s.status === "Succeeded").length;
  return job.steps.length > 0 ? `${done}/${job.steps.length}` : "";
}
