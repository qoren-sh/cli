import { useState } from "react";
import { Box, useInput } from "ink";
import type { Job } from "@qoren/sdk";
import { age } from "../../output.js";
import { currentStep, jobProgressText, statusColorName, truncate } from "../model.js";
import { useUi } from "../overlay.js";
import { describeError, statusPaced, useResource, useSession } from "../store.js";
import { Hints, StatusLine, Table, navigate } from "../ui.js";

// Jobs: the durable record of everything expensive the platform is doing.
//
// This is where you come when a deploy was started and then walked away from,
// or when something is taking longer than it should. Watching one from here is
// the same wait the other panes do inline, so a job started anywhere can be
// picked back up here.

export function JobsPane({
  height,
  focused,
}: {
  height: number;
  focused: boolean;
}) {
  const { qoren } = useSession();
  const ui = useUi();
  const [selected, setSelected] = useState(0);

  const jobs = useResource("jobs", () => qoren.jobs.list(50), {
    active: !ui.busy,
    interval: statusPaced((rows: Job[]) => rows.map((j) => j.status)),
  });

  const rows = jobs.data ?? [];
  const current = rows[Math.min(selected, rows.length - 1)];

  const inspect = async (job: Job) => {
    // Re-read it: the list is a summary, and the steps of a job that has moved
    // on since the last poll are the whole point of opening it.
    let full = job;
    try {
      full = await qoren.jobs.get(job.id);
    } catch {
      // The list row is still worth showing, so fall through with what we have.
    }
    const steps = full.steps
      .map(
        (s) =>
          `${s.status.padEnd(10)} ${s.label || s.key}${s.detail ? `  ${s.detail}` : ""}`,
      )
      .join("\n");
    await ui.show(
      `${full.title || full.type}  ${full.status}`,
      [
        `Id       ${full.id}`,
        `Target   ${full.target ?? "-"}`,
        `Started  ${full.startedAt ?? "-"}`,
        `Ended    ${full.finishedAt ?? "-"}`,
        "",
        steps || "(no steps recorded)",
        full.error ? `\nFailed at ${full.error.stepKey ?? "?"}\n${full.error.message}` : "",
      ].join("\n"),
    );
  };

  const watch = async (job: Job) => {
    const outcome = await ui.job(job.id, job.title || job.type);
    if (outcome.status === "failed") ui.toast(outcome.message, "bad");
    else if (outcome.status === "done") ui.toast("Finished.");
    jobs.reload();
  };

  const cancel = async (job: Job) => {
    const ok = await ui.confirm({
      title: `Cancel ${job.title || job.type}?`,
      body: "Best effort: a step already running finishes before it stops.",
    });
    if (!ok) return;
    try {
      await qoren.jobs.cancel(job.id);
      ui.toast("Cancellation requested.");
    } catch (err) {
      ui.toast(describeError(err), "bad");
    }
    jobs.reload();
  };

  useInput(
    (input, key) => {
      const next = navigate(rows.length, selected, input, key);
      if (next !== null) {
        setSelected(next);
        return;
      }
      if (!current) return;
      if (key.return) void inspect(current);
      else if (input === "w") void watch(current);
      else if (input === "c") void cancel(current);
    },
    { isActive: focused && !ui.busy },
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1}>
        <Table
          rows={rows}
          selected={selected}
          height={height}
          focused={focused}
          empty={jobs.loading ? "Loading..." : "Nothing has run yet."}
          columns={[
            { header: "job", width: 30, value: (j) => j.title || j.type },
            {
              header: "status",
              width: 10,
              value: (j) => j.status,
              color: (j) => statusColorName(j.status),
            },
            { header: "steps", width: 7, value: jobProgressText },
            { header: "now", width: 26, value: (j) => truncate(currentStep(j), 26) },
            { header: "age", value: (j) => age(j.createdAt) },
          ]}
        />
      </Box>
      <Box>
        <StatusLine error={jobs.error} refreshing={jobs.refreshing}>
          <Hints
            keys={[
              ["enter", "steps"],
              ["w", "watch"],
              ["c", "cancel"],
            ]}
          />
        </StatusLine>
      </Box>
    </Box>
  );
}
