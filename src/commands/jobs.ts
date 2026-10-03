import type { Command } from "commander";
import type { Job } from "@qoren/sdk";
import { requireContext, run, type GlobalOptions } from "../context.js";
import { followJob, jobSummary } from "../jobProgress.js";
import { age, dim, emit, note, statusColor, table } from "../output.js";

// Jobs. Everything expensive is one, so this is where you look when a deploy
// was started with --no-wait, or when something is taking longer than expected.

export function jobCommands(program: Command, global: () => GlobalOptions) {
  const jobs = program.command("jobs").alias("job").description("Inspect jobs");

  jobs
    .command("ls")
    .alias("list")
    .description("List recent jobs")
    .option("--limit <n>", "how many", "20")
    .action((options: { limit: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const rows = await ctx.qoren.jobs.list(
          Number.parseInt(options.limit, 10) || 20,
        );
        emit(rows, () =>
          table(rows, [
            { header: "id", value: (j: Job) => j.id },
            { header: "job", value: (j) => j.title || j.type },
            { header: "target", value: (j) => j.target ?? "" },
            { header: "status", value: (j) => statusColor(j.status) },
            { header: "steps", value: (j) => jobSummary(j) },
            { header: "age", value: (j) => age(j.createdAt) },
          ]),
        );
      })(),
    );

  jobs
    .command("get <id>")
    .description("Show one job and its steps")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const job = await ctx.qoren.jobs.get(id);
        emit(job, () => {
          note(`${job.title || job.type} ${statusColor(job.status)}`);
          for (const step of job.steps) {
            process.stdout.write(
              `  ${statusColor(step.status)} ${step.label || step.key}${
                step.detail ? ` ${dim(step.detail)}` : ""
              }\n`,
            );
          }
          if (job.error) {
            process.stderr.write(`${job.error.message}\n`);
          }
        });
      })(),
    );

  jobs
    .command("watch <id>")
    .description("Follow a running job until it finishes")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const job = await followJob(ctx, id);
        emit(job, () => note(dim("Done.")));
      })(),
    );

  jobs
    .command("cancel <id>")
    .description("Ask a running job to stop")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.jobs.cancel(id);
        // Best effort upstream: a step already in flight runs to completion.
        emit(result, () => note("Cancellation requested."));
      })(),
    );
}
