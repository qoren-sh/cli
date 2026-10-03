import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { QorenError, type Machine, type Options } from "@qoren/sdk";
import { orgSlug } from "../../context.js";
import { age } from "../../output.js";
import { statusColorName } from "../model.js";
import { useUi, type Choice } from "../overlay.js";
import { describeError, statusPaced, useResource, useSession } from "../store.js";
import { Details, Hints, StatusLine, Table, navigate } from "../ui.js";

// Environments: the hosts agents run on.
//
// The one place this deliberately differs from `qoren env create` is the
// availability refusal. The command line answers it with a sentence naming a
// flag to re-run with, because that is all a command that has already exited
// can do. A console is still here and still has the reader's attention, so it
// offers the remedy instead: "nyc1 can't run that size — use nyc3?" is a
// question worth asking, and being told to retype something is not.

/**
 * The "no preference" region, which is `region` omitted on the wire.
 *
 * The @ is what keeps it from ever colliding with a real choice: region
 * values are provider slugs like fra1 and nyc1, which are alphanumeric.
 */
const ANYWHERE = "@anywhere";

export function EnvironmentsPane({
  height,
  focused,
  onOpenAgents,
}: {
  height: number;
  focused: boolean;
  onOpenAgents: (environmentId: string) => void;
}) {
  const session = useSession();
  const { qoren } = session;
  const ui = useUi();
  const [selected, setSelected] = useState(0);

  const environments = useResource(
    "environments",
    () => qoren.environments.list(),
    {
      active: !ui.busy,
      interval: statusPaced((rows: Machine[]) => rows.map((m) => m.status)),
    },
  );

  const rows = environments.data ?? [];
  const current = rows[Math.min(selected, rows.length - 1)];

  /** The plan's own menu of sizes and regions. Fetched when a form needs one
   * rather than on mount: most sessions never open one. */
  const loadOptions = async (): Promise<Options | null> => {
    try {
      return await qoren.account.options();
    } catch (err) {
      ui.toast(describeError(err), "bad");
      return null;
    }
  };

  const sizeChoices = (
    sizes: Options["sizes"],
    marked: string | undefined,
    markedAs: string,
  ): Choice<string>[] =>
    sizes.map((s) => ({
      item: s.slug,
      label: s.slug,
      detail: `${s.description}  ${s.price}`,
      ...(s.slug === marked ? { hint: markedAs } : {}),
    }));

  /**
   * Turn an availability refusal into a question.
   *
   * Returns the size and region to retry with, or null when there is nothing
   * to offer or the reader declined — in which case the backend's own message
   * is the last word.
   */
  const offerRemedy = async (
    err: unknown,
    size: string,
    region: string,
  ): Promise<{ size: string; region: string } | null> => {
    if (!(err instanceof QorenError)) return null;
    const refusal = err.regionUnavailable;
    if (!refusal) return null;

    if (refusal.suggestedRegion) {
      const move = await ui.confirm({
        title: `${refusal.region} can't run that size right now`,
        body: `${refusal.suggestedRegion} is the closest region that can. Build it there instead?`,
      });
      // `autoRegion: true` on the retry is what grants the substitution; the
      // pinned region stays in the request so the platform picks the closest
      // one to it rather than starting over.
      if (move) return { size, region };
    }

    if (refusal.availableSizes.length === 0) return null;
    const other = await ui.select({
      title: `Sizes ${refusal.region} does have`,
      choices: refusal.availableSizes.map((s) => ({
        item: s.slug,
        label: s.slug,
        detail: s.label,
      })),
    });
    return other ? { size: other, region } : null;
  };

  const create = async () => {
    const name = await ui.prompt({
      title: "New environment",
      label: "Name",
      placeholder: "production",
      validate: (value) => (value ? null : "Give it a name."),
    });
    if (!name) return;

    const options = await loadOptions();
    if (!options) return;

    const firstSize = await ui.select({
      title: `Size for ${name}`,
      choices: sizeChoices(options.sizes, options.defaultSize, "default"),
      initial: Math.max(
        0,
        options.sizes.findIndex((s) => s.slug === options.defaultSize),
      ),
    });
    if (!firstSize) return;

    // "Anywhere" first, and the default: pinning a region is a promise the
    // platform keeps even when that region cannot run the size, so it should be
    // a deliberate choice rather than the one you land on by pressing enter.
    const firstRegion = await ui.select({
      title: "Region",
      choices: [
        {
          item: ANYWHERE,
          label: "anywhere",
          detail: "let the platform pick one that can run this size",
        },
        ...options.regions.map((r) => ({
          item: r.slug,
          label: r.slug,
          detail: r.description,
          ...(r.slug === options.defaultRegion ? { hint: "default" } : {}),
        })),
      ],
    });
    if (firstRegion === null) return;

    let size = firstSize;
    let region = firstRegion;

    // Up to two attempts: the first as asked, the second after the reader has
    // answered whatever the refusal offered.
    for (let attempt = 0; attempt < 2; attempt++) {
      const pinned = region !== ANYWHERE;
      try {
        const result = await qoren.environments.create({
          clientSlug: await orgSlug(session),
          name,
          size,
          ...(pinned ? { region, autoRegion: attempt > 0 } : {}),
        });
        if (!result.jobId) {
          ui.toast(`${name} requested.`);
          break;
        }
        const outcome = await ui.job(result.jobId, `Creating ${name}`);
        ui.toast(
          outcome.status === "done"
            ? `${name} is ready.`
            : outcome.status === "failed"
              ? outcome.message
              : `${name} is still being created.`,
          outcome.status === "failed" ? "bad" : "good",
        );
        break;
      } catch (err) {
        const remedy =
          attempt === 0 ? await offerRemedy(err, size, region) : null;
        if (!remedy) {
          ui.toast(describeError(err), "bad");
          break;
        }
        size = remedy.size;
        region = remedy.region;
      }
    }
    environments.reload();
  };

  const rename = async (machine: Machine) => {
    const name = await ui.prompt({
      title: `Rename ${machine.name}`,
      label: "Name",
      initial: machine.name,
      validate: (value) => (value ? null : "Give it a name."),
    });
    if (!name || name === machine.name) return;
    try {
      await qoren.environments.rename(machine.id, name);
      ui.toast(`Renamed to ${name}.`);
    } catch (err) {
      ui.toast(describeError(err), "bad");
    }
    environments.reload();
  };

  const resize = async (machine: Machine) => {
    const options = await loadOptions();
    if (!options) return;

    const target = await ui.select({
      title: `Resize ${machine.name}`,
      choices: sizeChoices(options.sizes, machine.size, "current"),
    });
    if (!target || target === machine.size) return;
    let size = target;

    const ok = await ui.confirm({
      title: `Resize ${machine.name} to ${size}?`,
      body: "The environment powers off, resizes and comes back up. Its agents are unreachable until it does.",
    });
    if (!ok) return;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await qoren.environments.resize(machine.id, size);
        const outcome = await ui.job(result.jobId, `Resizing ${machine.name}`);
        ui.toast(
          outcome.status === "failed" ? outcome.message : "Resize complete.",
          outcome.status === "failed" ? "bad" : "good",
        );
        break;
      } catch (err) {
        // An environment cannot change region, so the only remedy on offer is
        // a size the region it already lives in does run.
        const sizes =
          attempt === 0 && err instanceof QorenError
            ? (err.sizeUnavailable?.availableSizes ?? [])
            : [];
        if (sizes.length === 0) {
          ui.toast(describeError(err), "bad");
          break;
        }
        const other = await ui.select({
          title: `Sizes ${machine.region} does have`,
          choices: sizes.map((s) => ({
            item: s.slug,
            label: s.slug,
            detail: s.label,
          })),
        });
        if (!other) break;
        size = other;
      }
    }
    environments.reload();
  };

  const destroy = async (machine: Machine) => {
    const ok = await ui.confirm({
      title: `Destroy ${machine.name}?`,
      body: "This removes the environment and every agent on it. It cannot be undone.",
      danger: true,
      requireText: machine.name,
    });
    if (!ok) return;
    try {
      const result = await qoren.environments.destroy(machine.id);
      const outcome = await ui.job(result.jobId, `Destroying ${machine.name}`);
      ui.toast(
        outcome.status === "failed" ? outcome.message : "Environment destroyed.",
        outcome.status === "failed" ? "bad" : "good",
      );
    } catch (err) {
      ui.toast(describeError(err), "bad");
    }
    setSelected(0);
    environments.reload();
  };

  const collaboration = async (machine: Machine) => {
    const turningOn = !machine.teamMessagingEnabled;
    const ok = await ui.confirm({
      title: `Turn collaboration ${turningOn ? "on" : "off"} for ${machine.name}?`,
      body: turningOn
        ? "The agents on this environment will be able to discover and message each other."
        : "The agents on this environment will stop being able to reach each other.",
    });
    if (!ok) return;
    try {
      const result = await qoren.environments.setCollaboration(
        machine.id,
        turningOn,
      );
      ui.toast(
        `Collaboration ${result.enabled ? "on" : "off"}; ${result.jobIds.length} agent(s) reconfiguring.`,
      );
    } catch (err) {
      ui.toast(describeError(err), "bad");
    }
    environments.reload();
  };

  const inspect = async (machine: Machine) => {
    // Vitals are a live read off the host, so they are fetched on demand and
    // reported as unavailable rather than holding up the rest: an environment
    // still provisioning has none to give.
    let vitals: string;
    try {
      vitals = JSON.stringify(await qoren.environments.vitals(machine.id), null, 2);
    } catch (err) {
      vitals = `Host readings unavailable: ${describeError(err)}`;
    }
    await ui.show(
      machine.name,
      [
        `Id             ${machine.id}`,
        `Name           ${machine.name}`,
        `Status         ${machine.status}`,
        `Size           ${machine.size}`,
        `Region         ${machine.region}`,
        `Image          ${machine.image}`,
        `IP             ${machine.ip ?? "-"}`,
        `Created        ${machine.createdAt}`,
        `Collaboration  ${machine.teamMessagingEnabled ? "on" : "off"}`,
        `Cost           ${machine.hourlyUsd == null ? "-" : `$${machine.hourlyUsd}/hour`}`,
        "",
        "Host readings",
        vitals,
      ].join("\n"),
    );
  };

  useInput(
    (input, key) => {
      const next = navigate(rows.length, selected, input, key);
      if (next !== null) {
        setSelected(next);
        return;
      }
      if (input === "n") {
        void create();
        return;
      }
      if (!current) return;
      if (key.return) void inspect(current);
      else if (input === "R") void rename(current);
      else if (input === "s") void resize(current);
      else if (input === "d") void destroy(current);
      else if (input === "c") void collaboration(current);
      else if (input === "a") onOpenAgents(current.id);
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
          empty={
            environments.loading
              ? "Loading..."
              : "No environments yet. Press n to make one."
          }
          columns={[
            { header: "name", width: 22, value: (m) => m.name },
            {
              header: "status",
              width: 13,
              value: (m) => m.status,
              color: (m) => statusColorName(m.status),
            },
            { header: "size", width: 24, value: (m) => m.size },
            { header: "region", width: 7, value: (m) => m.region },
            { header: "ip", width: 16, value: (m) => m.ip ?? "" },
            {
              header: "collab",
              width: 6,
              value: (m) => (m.teamMessagingEnabled ? "on" : ""),
            },
            { header: "age", value: (m) => age(m.createdAt) },
          ]}
        />
      </Box>
      {current ? (
        <Box paddingTop={1}>
          <Details
            pairs={[
              ["id", current.id],
              [
                "state",
                <Text key="state" color={statusColorName(current.status)}>
                  {current.status}
                </Text>,
              ],
              [
                "cost",
                current.hourlyUsd == null ? "" : `$${current.hourlyUsd}/hour`,
              ],
            ]}
          />
        </Box>
      ) : null}
      <Box>
        <StatusLine
          error={environments.error}
          refreshing={environments.refreshing}
        >
          <Hints
            keys={[
              ["enter", "details"],
              ["n", "new"],
              ["R", "rename"],
              ["s", "resize"],
              ["c", "collab"],
              ["d", "destroy"],
              ["a", "agents"],
            ]}
          />
        </StatusLine>
      </Box>
    </Box>
  );
}
