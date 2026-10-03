import type { Command } from "commander";
import { QorenError, type AvailableSize, type Machine } from "@qoren/sdk";
import { orgSlug, requireContext, run, type GlobalOptions } from "../context.js";
import { followJob } from "../jobProgress.js";
import {
  clientsGateError,
  gated,
  matchEnvironment,
  resolveClient,
} from "./clients.js";
import { age, bold, details, emit, note, statusColor, table } from "../output.js";

// Environments: the hosts agents run on.
//
// No `exec`, `message` or `workspace` here. Those routes exist but are
// admin-only upstream, so a command for them would 403 for everyone this CLI is
// for. The per-agent equivalents (`qoren agent exec`) are the ones that work,
// and they are better scoped anyway — they run as the agent's own user.

/**
 * The sentence to append to an availability refusal so the person reading it
 * knows what to type next. Pure and exported so the wording is testable without
 * a control plane, and so `create` and `resize` cannot drift apart.
 *
 * Returns null when the refusal offers nothing actionable (or isn't one), in
 * which case the backend's own message already says everything there is to say.
 */
export function availabilityHint(
  err: unknown,
  opts: { autoRegion?: boolean } = {},
): string | null {
  if (!(err instanceof QorenError)) return null;

  const offer = err.regionUnavailable;
  if (offer) {
    // --auto-region is only worth naming when there is somewhere to move to and
    // the caller hasn't already granted it.
    const canMove = offer.suggestedRegion !== null && !opts.autoRegion;
    const sizes = sizeChoices(offer.region, offer.availableSizes);
    if (canMove && sizes) return `${MOVE_HINT}, or ${sizes}.`;
    if (canMove) return `${MOVE_HINT}.`;
    return sizes ? `${capitalize(sizes)}.` : null;
  }

  const resize = err.sizeUnavailable;
  if (resize) {
    const sizes = sizeChoices(resize.region, resize.availableSizes);
    return sizes ? `${capitalize(sizes)}.` : null;
  }

  return null;
}

const MOVE_HINT =
  "Re-run with --auto-region to use the closest region that offers this size";

/**
 * The "or pick a different size" half of a hint, or null when the backend
 * offered no alternative.
 *
 * The value printed for --size is the size SLUG, not our `light`/`standard`
 * catalog key: the flag is forwarded to the API verbatim and the API's `size`
 * field is a provider slug, so the key would be refused if anyone pasted it.
 * The label is there so the line still reads as product vocabulary.
 */
function sizeChoices(region: string, sizes: AvailableSize[]): string | null {
  if (sizes.length === 0) return null;
  const list = sizes.map((s) => `${s.label} (--size ${s.slug})`).join(", ");
  return `use one of these sizes in ${region}: ${list}`;
}

const capitalize = (text: string): string =>
  text.charAt(0).toUpperCase() + text.slice(1);

/** Re-throw an availability refusal with the hint appended to its message. The
 * body is carried through untouched, so `--json` still reports the structured
 * refusal a script can branch on. */
function withHint(err: unknown, opts: { autoRegion?: boolean } = {}): unknown {
  const hint = availabilityHint(err, opts);
  return hint && err instanceof QorenError
    ? new QorenError(`${err.message} ${hint}`, err.status, err.body)
    : err;
}

function envTable(rows: Machine[]): void {
  // The client column only earns its width on an account that uses clients.
  const withClient = rows.some((m) => m.customerName);
  table(rows, [
    { header: "id", value: (m) => m.id },
    { header: "name", value: (m) => m.name },
    { header: "status", value: (m) => statusColor(m.status) },
    { header: "size", value: (m) => m.size },
    { header: "region", value: (m) => m.region },
    ...(withClient
      ? [{ header: "client", value: (m: Machine) => m.customerName ?? "" }]
      : []),
    { header: "ip", value: (m) => m.ip ?? "" },
    { header: "age", value: (m) => age(m.createdAt) },
  ]);
}

export function envCommands(program: Command, global: () => GlobalOptions) {
  const env = program
    .command("env")
    .alias("environments")
    .description("Manage environments");

  env
    .command("ls")
    .alias("list")
    .description("List your environments")
    .action(() =>
      run(async () => {
        const ctx = requireContext(global());
        const machines = await ctx.qoren.environments.list();
        emit(machines, () => envTable(machines));
      })(),
    );

  env
    .command("get <id>")
    .description("Show one environment")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const m = await ctx.qoren.environments.get(id);
        emit(m, () =>
          details([
            ["Id", m.id],
            ["Name", m.name],
            ["Status", statusColor(m.status)],
            ["Size", m.size],
            ["Region", m.region],
            ["Image", m.image],
            ["IP", m.ip ?? ""],
            ["Created", m.createdAt],
            ["Collaboration", m.teamMessagingEnabled ? "on" : "off"],
            ["Client", m.customerName ?? ""],
            ["Cost", m.hourlyUsd == null ? "" : `$${m.hourlyUsd}/hour`],
          ]),
        );
      })(),
    );

  env
    .command("create")
    .description("Provision a new environment")
    .requiredOption("--name <name>", "name for the environment")
    .option("--size <size>", "light | standard | heavy | max", "light")
    .option("--region <region>", "provider region, e.g. fra1")
    .option(
      "--auto-region",
      "if the region doesn't offer the size, use the closest one that does",
    )
    .option("--image <image>", "base image")
    .option("--org <slug>", "organization slug (resolved automatically)")
    .option("--client <client>", "assign it to a client (id or exact name)")
    .option("--no-wait", "print the job id and exit instead of following it")
    .action(
      (options: {
        name: string;
        size: string;
        region?: string;
        autoRegion?: boolean;
        image?: string;
        org?: string;
        client?: string;
        wait: boolean;
      }) =>
        run(async () => {
          const ctx = requireContext(global());
          // Resolved before the create so a mistyped client never leaves an
          // unassigned environment behind.
          const clientId =
            options.client !== undefined
              ? (await resolveClient(ctx, options.client)).id
              : undefined;
          let result;
          try {
            result = await ctx.qoren.environments.create({
              clientSlug: await orgSlug(ctx, options.org),
              name: options.name,
              size: options.size,
              ...(options.region !== undefined
                ? { region: options.region }
                : {}),
              ...(options.autoRegion ? { autoRegion: true } : {}),
              ...(options.image !== undefined ? { image: options.image } : {}),
              ...(clientId !== undefined ? { clientId } : {}),
            });
          } catch (err) {
            // A region that doesn't offer the size is fixable from right here: name the flag that
            // grants permission to auto-select, and the sizes that region does have, instead of
            // leaving a bare refusal.
            throw withHint(clientsGateError(err), {
              autoRegion: options.autoRegion ?? false,
            });
          }

          if (!options.wait || !result.jobId) {
            emit(result, () => note(`Job ${bold(result.jobId ?? "-")} started.`));
            return;
          }
          await followJob(ctx, result.jobId, `Creating ${bold(options.name)}…`);
          emit({ ...result, ok: true }, () =>
            note(`Environment ${bold(options.name)} is ready.`),
          );
        })(),
    );

  env
    .command("assign <environment> <client>")
    .description(
      "Assign an environment to a client (ids or exact names), or to none",
    )
    .action((envRef: string, clientRef: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const machine = matchEnvironment(
          await ctx.qoren.environments.list(),
          envRef,
        );
        const client =
          clientRef === "none" ? null : await resolveClient(ctx, clientRef);
        const updated = await gated(
          ctx.qoren.environments.assignClient(machine.id, client?.id ?? null),
        );
        emit(updated, () =>
          note(
            client
              ? `Environment ${bold(machine.name)} now belongs to ${bold(client.name)}.`
              : `Environment ${bold(machine.name)} no longer belongs to a client.`,
          ),
        );
      })(),
    );

  env
    .command("rm <id>")
    .alias("destroy")
    .description("Destroy an environment and everything on it")
    .option("--no-wait", "print the job id and exit instead of following it")
    .action((id: string, options: { wait: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.environments.destroy(id);
        if (!options.wait) {
          emit(result, () => note(`Job ${bold(result.jobId)} started.`));
          return;
        }
        await followJob(ctx, result.jobId, `Destroying ${bold(id)}…`);
        emit({ ...result, ok: true }, () => note("Environment destroyed."));
      })(),
    );

  env
    .command("rename <id> <name>")
    .description("Rename an environment")
    .action((id: string, name: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.environments.rename(id, name);
        emit(result, () => note(`Renamed to ${bold(result.name)}.`));
      })(),
    );

  env
    .command("resize <id>")
    .description("Move an environment to a larger size")
    .requiredOption("--size <size>", "light | standard | heavy | max")
    .option("--no-wait", "print the job id and exit instead of following it")
    .action((id: string, options: { size: string; wait: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        let result;
        try {
          result = await ctx.qoren.environments.resize(id, options.size);
        } catch (err) {
          // An environment can't change region, so the only way out of a size
          // this one's region doesn't offer is a different size. Name them.
          throw withHint(err);
        }
        if (!options.wait) {
          emit(result, () => note(`Job ${bold(result.jobId)} started.`));
          return;
        }
        // The environment is powered off, resized and powered back on, so its
        // agents are unreachable for the duration. Worth saying out loud.
        await followJob(
          ctx,
          result.jobId,
          `Resizing to ${bold(options.size)} (the environment restarts)…`,
        );
        emit({ ...result, ok: true }, () => note("Resize complete."));
      })(),
    );

  env
    .command("vitals <id>")
    .description("Show host readings for an environment")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const vitals = await ctx.qoren.environments.vitals(id);
        emit(vitals, () =>
          process.stdout.write(`${JSON.stringify(vitals, null, 2)}\n`),
        );
      })(),
    );

  env
    .command("collaboration <id> <state>")
    .description("Turn agent-to-agent messaging on or off (state: on | off)")
    .action((id: string, state: string) =>
      run(async () => {
        const ctx = requireContext(global());
        if (state !== "on" && state !== "off") {
          throw new Error("State must be `on` or `off`.");
        }
        const result = await ctx.qoren.environments.setCollaboration(
          id,
          state === "on",
        );
        emit(result, () =>
          note(
            `Collaboration ${result.enabled ? "enabled" : "disabled"}; ${
              result.jobIds.length
            } agent(s) reconfiguring.`,
          ),
        );
      })(),
    );
}
