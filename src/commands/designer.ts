import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import type {
  DesignBindings,
  DesignBindingValue,
  DesignerAgentView,
  DesignInput,
  DesignIssue,
  DesignPublishResult,
  DesignSpec,
  DesignSummary,
  DesignVersionRef,
  UpdateDesignerSettingsInput,
} from "@qoren/sdk";
import {
  requireContext,
  run,
  type Context,
  type GlobalOptions,
} from "../context.js";
import { hasErrors, issueSummary, printIssues } from "../issues.js";
import { age, bold, details, dim, emit, note, statusColor, table, warn } from "../output.js";
import { slugify } from "../slug.js";
import { parseOnOff, readJsonArg } from "../args.js";
import { gated, resolveClient } from "./clients.js";
import { parseWaitTimeout, printRun, reportWaitedRun, waitForRun } from "./customAgent.js";

// The Agent Designer, from the terminal: designs as code.
//
// A design is a JSON spec with one editable draft and immutable published
// versions. The loop this file is built around is the one a team keeps in git:
// `export` a design to a file, edit it, `push` it back (validated, optionally
// published), then `deploy` it as a Custom agent for each client. Operating the
// agents themselves (runs, chat, channels) lives under `qoren agent`.

const ms = (value: number | null | undefined): string =>
  value ? new Date(value).toISOString() : "";

const ago = (value: number | null | undefined): string =>
  value ? age(new Date(value).toISOString()) : "";

/** Repeatable `--input key=value` flags. */
export function collectPairs(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Pick one design by id, exact name, or the name's slug. Archived designs are
 * matched only by id. Null when nothing matches; a name that matches more than
 * one design is refused rather than guessed.
 */
export function findDesign(
  designs: DesignSummary[],
  ref: string,
): DesignSummary | null {
  const byId = designs.find((d) => d.designId === ref);
  if (byId) return byId;
  const active = designs.filter((d) => d.archivedAt === null);
  const named = active.filter((d) => d.name === ref);
  const candidates =
    named.length > 0
      ? named
      : active.filter((d) => slugify(d.name) === slugify(ref) && slugify(ref) !== "");
  if (candidates.length > 1) {
    throw new Error(
      `More than one design is called "${ref}". Use its id (see qoren designer ls).`,
    );
  }
  return candidates[0] ?? null;
}

export function matchDesign(designs: DesignSummary[], ref: string): DesignSummary {
  const design = findDesign(designs, ref);
  if (!design) {
    throw new Error(
      `No design has the id or name "${ref}". Run qoren designer ls to see them.`,
    );
  }
  return design;
}

async function resolveDesign(ctx: Context, ref: string): Promise<DesignSummary> {
  return matchDesign(await ctx.qoren.designer.designs.list(), ref);
}

/** `draft`, `latest` or a version number, off the command line. */
export function parseVersionRef(input: string): DesignVersionRef {
  const value = input.trim().toLowerCase();
  if (value === "draft" || value === "latest") return value;
  const n = Number.parseInt(value.replace(/^v/, ""), 10);
  if (Number.isInteger(n) && n > 0 && String(n) === value.replace(/^v/, "")) return n;
  throw new Error(`Expected draft, latest or a version number, got "${input}".`);
}

export function parseVersion(input: string): number {
  const ref = parseVersionRef(input);
  if (typeof ref !== "number") throw new Error(`Expected a version number, got "${input}".`);
  return ref;
}

/** Read a design spec file, refusing anything that is not one. */
export function readSpecFile(path: string): DesignSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    throw new Error(
      `Could not read ${path} as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { kind?: unknown }).kind !== "qoren.design"
  ) {
    throw new Error(
      `${path} is not a design spec (expected "kind": "qoren.design"). Get one with qoren designer export.`,
    );
  }
  return parsed as DesignSpec;
}

const RESOURCE_KINDS = new Set([
  "connection",
  "knowledge_base",
  "machine",
  "fleet_agent",
  "mcp_server",
]);

/**
 * Turn `key=value` pairs into the three binding maps, using what the design
 * says each input is. A secret input takes a vault secret NAME (never a value),
 * a resource input takes an id, and a scalar is typed by its kind: `number`
 * and `boolean` are parsed, a multiple-choice input splits on commas, and an
 * empty value clears the input.
 */
export function bindInputs(inputs: DesignInput[], pairs: string[]): DesignBindings {
  const out: Required<DesignBindings> = {
    bindings: {},
    secretBindings: {},
    resourceBindings: {},
  };
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`Expected key=value, got "${pair}".`);
    const key = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1);
    const input = inputs.find((i) => i.key === key);
    if (!input) {
      const known = inputs.map((i) => i.key).join(", ");
      throw new Error(
        `This design has no input "${key}".${known ? ` Its inputs are: ${known}.` : " It declares no inputs."}`,
      );
    }
    const list = () => raw.split(",").map((v) => v.trim()).filter(Boolean);
    if (input.kind === "secret") {
      out.secretBindings[key] = raw.trim();
    } else if (RESOURCE_KINDS.has(input.kind)) {
      out.resourceBindings[key] = input.multiple ? list() : raw.trim();
    } else {
      out.bindings[key] = scalar(input, raw);
    }
  }
  return out;
}

function scalar(input: DesignInput, raw: string): DesignBindingValue {
  if (raw === "") return null;
  if (input.kind === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`Input "${input.key}" takes a number, got "${raw}".`);
    return n;
  }
  if (input.kind === "boolean") {
    const b = parseOnOff(raw);
    if (b === null) throw new Error(`Input "${input.key}" takes on or off, got "${raw}".`);
    return b;
  }
  if (input.multiple) return raw.split(",").map((v) => v.trim()).filter(Boolean);
  return raw;
}

/** Only the binding maps that carry something, so an untouched map is left alone upstream. */
function nonEmpty(b: DesignBindings): DesignBindings {
  const out: DesignBindings = {};
  if (b.bindings && Object.keys(b.bindings).length) out.bindings = b.bindings;
  if (b.secretBindings && Object.keys(b.secretBindings).length) out.secretBindings = b.secretBindings;
  if (b.resourceBindings && Object.keys(b.resourceBindings).length) out.resourceBindings = b.resourceBindings;
  return out;
}

/** Laid over what an agent already has: the API replaces a map whole. */
export function mergeBindings(
  current: Pick<DesignerAgentView, "bindings" | "secretBindings" | "resourceBindings">,
  changes: DesignBindings,
): DesignBindings {
  const out: DesignBindings = {};
  if (changes.bindings) out.bindings = { ...current.bindings, ...changes.bindings };
  if (changes.secretBindings) out.secretBindings = { ...current.secretBindings, ...changes.secretBindings };
  if (changes.resourceBindings) out.resourceBindings = { ...current.resourceBindings, ...changes.resourceBindings };
  return out;
}

function parseCredits(value: string): number {
  const n = Number.parseInt(value.replace(/[,_]/g, ""), 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("--budget takes a whole number of credits, 1 or more (1,000 credits is $1).");
  }
  return n;
}

function printPublish(name: string, result: DesignPublishResult): void {
  note(`Published ${bold(name)} as version ${bold(String(result.version))}.`);
  if (result.upgraded.length > 0) {
    note(`  ${dim("·")} ${result.upgraded.length} agent(s) moved to it`);
  }
  for (const behind of result.needsInputs) {
    warn(
      `Agent ${behind.agentId} stays on its version until it has: ${behind.missingInputs.join(", ")}. Set them with qoren designer set.`,
    );
  }
}

/** A Custom agent's design settings, for a person. Secret inputs show the
 * vault name they point at; no value ever reaches this command. */
export function printAgentDesigner(v: DesignerAgentView): void {
  const version =
    v.versionPolicy === "pinned"
      ? `pinned to v${v.pinnedVersion}`
      : `follows the latest${v.latestVersion == null ? "" : ` (v${v.latestVersion})`}`;
  details([
    ["Agent", v.agentId],
    ["Design", `${v.designName ?? dim("(archived)")} (${v.designId})`],
    ["Running", v.activeVersion == null ? "" : `v${v.activeVersion}`],
    ["Version", version],
    ["Status", v.status ? statusColor(v.status) : ""],
    [
      "Upgrade",
      v.pendingUpgrade
        ? `v${v.pendingUpgrade.version} waits for: ${v.pendingUpgrade.missingInputs.join(", ")}`
        : "",
    ],
    ["Budget", `${v.runGuardCredits.toLocaleString("en-US")} credits per run`],
    ["Paused", v.paused ? "yes" : "no"],
    ["Client", v.customerId ?? ""],
  ]);
  const rows = [
    ...Object.entries(v.bindings ?? {}).map(([key, value]) => ({
      key,
      kind: "value",
      value: value === null ? "" : Array.isArray(value) ? value.join(", ") : String(value),
    })),
    ...Object.entries(v.secretBindings ?? {}).map(([key, value]) => ({ key, kind: "secret", value })),
    ...Object.entries(v.resourceBindings ?? {}).map(([key, value]) => ({
      key,
      kind: "resource",
      value: Array.isArray(value) ? value.join(", ") : value,
    })),
  ];
  if (rows.length > 0) {
    note(bold("\nInputs"));
    table(rows, [
      { header: "key", value: (r) => r.key },
      { header: "kind", value: (r) => r.kind },
      { header: "value", value: (r) => r.value },
    ]);
  }
}

const HELP_INPUT =
  "an input value as key=value; repeatable. Secret inputs take a vault secret name, resource inputs an id";

export function designerCommands(program: Command, global: () => GlobalOptions) {
  const designer = program
    .command("designer")
    .alias("designs")
    .description("Build Custom agents in the Agent Designer: designs as code");

  designer
    .command("ls")
    .alias("list")
    .description("List your designs")
    .option("--archived", "include archived designs")
    .action((options: { archived?: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        const designs = await ctx.qoren.designer.designs.list({
          includeArchived: options.archived === true,
        });
        emit(designs, () =>
          table(designs, [
            { header: "id", value: (d) => d.designId },
            { header: "name", value: (d) => d.name },
            {
              header: "version",
              value: (d) => (d.latestVersion == null ? dim("draft only") : `v${d.latestVersion}`),
            },
            { header: "agents", value: (d) => String(d.instanceCount) },
            { header: "updated", value: (d) => ago(d.updatedAt) },
            { header: "archived", value: (d) => (d.archivedAt ? "yes" : "") },
          ]),
        );
      })(),
    );

  designer
    .command("get <design>")
    .description("Show one design: its draft, inputs and triggers")
    .action((ref: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const { designId } = await resolveDesign(ctx, ref);
        const d = await ctx.qoren.designer.designs.get(designId);
        emit(d, () => {
          details([
            ["Id", d.designId],
            ["Name", d.name],
            ["Description", d.description ?? ""],
            ["Latest version", d.latestVersion == null ? dim("not published") : `v${d.latestVersion}`],
            ["Agents", String(d.instanceCount)],
            ["Draft", `revision ${d.draftRevision}, hash ${d.draftHash.slice(0, 12)}`],
            ["Triggers", d.triggers.map((t) => `${t.nodeId} (${t.kind})`).join(", ")],
            ["Updated", ms(d.updatedAt)],
          ]);
          const inputs = d.latestInputs ?? d.inputs;
          if (inputs.length > 0) {
            note(bold(`\nInputs${d.latestInputs ? " (latest version)" : " (draft)"}`));
            table(inputs, [
              { header: "key", value: (i) => i.key },
              { header: "kind", value: (i) => i.kind + (i.multiple ? "[]" : "") },
              { header: "required", value: (i) => (i.required ? "yes" : "") },
              { header: "label", value: (i) => i.label },
            ]);
          }
        });
      })(),
    );

  designer
    .command("new <name>")
    .alias("create")
    .description("Create a design: blank, from a starter, or from a spec file")
    .option("--starter <slug>", "start from a starter design (see qoren designer starters)")
    .option("--from <file>", "start from a design spec file")
    .option("--description <text>", "what the design is for")
    .action(
      (name: string, options: { starter?: string; from?: string; description?: string }) =>
        run(async () => {
          if (options.starter && options.from) {
            throw new Error("Choose --starter or --from, not both.");
          }
          const spec = options.from ? readSpecFile(options.from) : undefined;
          const ctx = requireContext(global());
          const result = await ctx.qoren.designer.designs.create({
            name,
            ...(options.description ? { description: options.description } : {}),
            ...(options.starter ? { starterSlug: options.starter } : {}),
            ...(spec ? { spec } : {}),
          });
          emit(result, () => {
            note(`Created ${bold(result.design.name)} (${result.design.designId}).`);
            if (result.issues.length > 0) {
              note(`The draft has ${issueSummary(result.issues)}:`);
              printIssues(result.issues);
            }
          });
        })(),
    );

  designer
    .command("rm <design>")
    .alias("archive")
    .description("Archive a design (refused while agents still run it)")
    .action((ref: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const design = await resolveDesign(ctx, ref);
        const result = await ctx.qoren.designer.designs.archive(design.designId);
        emit({ ...result, designId: design.designId }, () =>
          note(`Archived ${bold(design.name)}.`),
        );
      })(),
    );

  designer
    .command("export <design>")
    // Not --version: the program's own -v/--version would swallow it.
    .description("Print a design's JSON spec (the draft unless --at says otherwise)")
    .option("--at <version>", "draft, latest, or a version number", "draft")
    .option("--out <file>", "write the spec to a file instead of stdout")
    .action((ref: string, options: { at: string; out?: string }) =>
      run(async () => {
        const version = parseVersionRef(options.at);
        const ctx = requireContext(global());
        const design = await resolveDesign(ctx, ref);
        const exported = await ctx.qoren.designer.designs.export(design.designId, version);
        const text = `${JSON.stringify(exported.spec, null, 2)}\n`;
        if (options.out) {
          writeFileSync(options.out, text);
          emit({ ...exported, spec: undefined, path: options.out }, () =>
            note(
              `Wrote ${bold(design.name)} ${exported.version == null ? "(draft)" : `v${exported.version}`} to ${options.out}.`,
            ),
          );
          return;
        }
        // The spec IS the data, so it goes to stdout as is; --json adds the
        // version and hash around it.
        emit(exported, () => process.stdout.write(text));
      })(),
    );

  designer
    .command("push <file>")
    .description(
      "Import a spec file into a design's draft, creating the design if it is new; exits 1 when the draft has errors",
    )
    .option("--design <design>", "the design to update (defaults to the spec's meta.name)")
    .option("--publish", "publish the draft as a new version when it has no errors")
    .option("--note <text>", "what changed, for the version history (with --publish)")
    .option("--dry-run", "validate and report, save nothing")
    .action(
      (
        file: string,
        options: { design?: string; publish?: boolean; note?: string; dryRun?: boolean },
      ) =>
        run(async () => {
          const spec = readSpecFile(file);
          const ref = options.design ?? spec.meta?.name;
          if (!ref) {
            throw new Error("Pass --design, or give the spec a meta.name.");
          }
          if (options.publish && options.dryRun) {
            throw new Error("Choose --publish or --dry-run, not both.");
          }
          const ctx = requireContext(global());
          const existing = findDesign(await ctx.qoren.designer.designs.list(), ref);

          let designId: string;
          let name: string;
          let created = false;
          let applied: boolean;
          let issues: DesignIssue[];
          let draftHash: string | null = null;

          if (!existing) {
            if (options.dryRun) {
              emit(
                { designId: null, name: ref, created: false, applied: false, issues: [], published: null },
                () =>
                  note(
                    `No design called ${bold(ref)} yet. Push without --dry-run to create it; it is validated then.`,
                  ),
              );
              return;
            }
            const result = await ctx.qoren.designer.designs.create({
              name: spec.meta?.name ?? ref,
              ...(spec.meta?.description ? { description: spec.meta.description } : {}),
              spec,
            });
            designId = result.design.designId;
            name = result.design.name;
            created = true;
            applied = true;
            issues = result.issues;
            draftHash = result.draftHash ?? null;
          } else {
            designId = existing.designId;
            name = existing.name;
            const result = await ctx.qoren.designer.designs.import(designId, {
              spec,
              ...(options.dryRun ? { dryRun: true } : {}),
            });
            applied = result.applied;
            issues = result.issues;
            draftHash = result.draftHash;
          }

          const failed = hasErrors(issues);
          let published: DesignPublishResult | null = null;
          if (options.publish && !failed) {
            published = await ctx.qoren.designer.designs.publish(designId, {
              ...(options.note ? { note: options.note } : {}),
              ...(draftHash ? { expectedDraftHash: draftHash } : {}),
            });
          }

          emit({ designId, name, created, applied, issues, draftHash, published }, () => {
            const verb = options.dryRun
              ? "Checked"
              : created
                ? "Created"
                : "Updated the draft of";
            note(`${verb} ${bold(name)} (${designId}): ${issueSummary(issues)}.`);
            printIssues(issues);
            if (published) printPublish(name, published);
            else if (options.publish) warn("Not published: fix the errors above first.");
          });
          if (failed) process.exitCode = 1;
        })(),
    );

  designer
    .command("publish <design>")
    .description("Publish the draft as the next immutable version")
    .option("--note <text>", "what changed, for the version history")
    .action((ref: string, options: { note?: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const design = await resolveDesign(ctx, ref);
        const result = await ctx.qoren.designer.designs.publish(design.designId, {
          ...(options.note ? { note: options.note } : {}),
        });
        emit(result, () => printPublish(design.name, result));
      })(),
    );

  designer
    .command("rollback <design> <version>")
    .description("Republish an earlier version as the next one")
    .action((ref: string, version: string) =>
      run(async () => {
        const n = parseVersion(version);
        const ctx = requireContext(global());
        const design = await resolveDesign(ctx, ref);
        const result = await ctx.qoren.designer.designs.rollback(design.designId, n);
        emit(result, () => printPublish(design.name, result));
      })(),
    );

  designer
    .command("versions <design>")
    .description("List a design's published versions")
    .action((ref: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const design = await resolveDesign(ctx, ref);
        const versions = await ctx.qoren.designer.designs.versions(design.designId);
        emit(versions, () =>
          table(versions, [
            { header: "version", value: (v) => `v${v.version}` },
            { header: "published", value: (v) => ms(v.publishedAt) },
            { header: "agents", value: (v) => String(v.instanceCount) },
            { header: "required inputs", value: (v) => v.requiredInputKeys.join(", ") },
            { header: "note", value: (v) => v.changelog ?? "" },
          ]),
        );
      })(),
    );

  designer
    .command("agents <design>")
    .alias("instances")
    .description("List the Custom agents deployed from a design")
    .action((ref: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const design = await resolveDesign(ctx, ref);
        const instances = await ctx.qoren.designer.designs.instances(design.designId);
        emit(instances, () =>
          table(instances, [
            { header: "agent", value: (i) => i.agentId },
            { header: "name", value: (i) => i.name },
            { header: "status", value: (i) => statusColor(i.status) },
            {
              header: "version",
              value: (i) =>
                (i.activeVersion == null ? "" : `v${i.activeVersion}`) +
                (i.versionPolicy === "pinned" ? dim(" pinned") : ""),
            },
            {
              header: "waiting on",
              value: (i) =>
                i.pendingUpgrade
                  ? `v${i.pendingUpgrade.version}: ${i.pendingUpgrade.missingInputs.join(", ")}`
                  : "",
            },
          ]),
        );
      })(),
    );

  designer
    .command("test <design>")
    .description("Run the current draft once, as the console's test panel does")
    .option("--trigger <nodeId>", "the trigger to fire (needed when the design has several)")
    .option("--message <text>", "for a chat trigger: the message to send")
    .option("--payload <json>", "what the trigger hands the graph, inline or as @file.json")
    .option("--input <key=value>", HELP_INPUT, collectPairs)
    .option("--execute-outputs", "really send emails, replies and HTTP calls (they dry-run by default)")
    .option("--wait", "wait for the run to finish and print its trace and result")
    .option("--timeout <duration>", "with --wait: give up after this long, e.g. 10m", "30m")
    .action(
      (
        ref: string,
        options: {
          trigger?: string;
          message?: string;
          payload?: string;
          input?: string[];
          executeOutputs?: boolean;
          wait?: boolean;
          timeout: string;
        },
      ) =>
        run(async () => {
          if (options.message !== undefined && options.payload !== undefined) {
            throw new Error("Choose --message or --payload, not both.");
          }
          const timeout = parseWaitTimeout(options.timeout);
          const ctx = requireContext(global());
          const design = await resolveDesign(ctx, ref);
          const detail = await ctx.qoren.designer.designs.get(design.designId);
          const trigger =
            options.trigger ?? (detail.triggers.length === 1 ? detail.triggers[0]?.nodeId : undefined);
          if (!trigger) {
            throw new Error(
              detail.triggers.length === 0
                ? "The draft has no trigger to fire. Add one first."
                : `Pick a trigger with --trigger: ${detail.triggers.map((t) => t.nodeId).join(", ")}.`,
            );
          }
          const payload =
            options.payload !== undefined
              ? readJsonArg(options.payload, "--payload")
              : options.message !== undefined
                ? { message: { text: options.message, attachments: [] } }
                : {};
          const result = await ctx.qoren.designer.designs.testRun(design.designId, {
            triggerNodeId: trigger,
            payload,
            ...nonEmpty(bindInputs(detail.inputs, options.input ?? [])),
            ...(options.executeOutputs ? { executeOutputs: true } : {}),
          });
          const checkBack = `qoren designer test-get ${design.designId} ${result.runId}`;
          if (!options.wait) {
            emit(result, () => {
              note(`Test run ${bold(result.runId)} started from ${trigger}.`);
              note(dim(`Follow it with: ${checkBack}`));
              note(dim(`Stop it with: qoren designer test-cancel ${design.designId} ${result.runId}`));
            });
            return;
          }
          note(dim(`Test run ${result.runId} started from ${trigger}.`));
          const waited = await waitForRun(
            () => ctx.qoren.designer.designs.getTestRun(design.designId, result.runId),
            timeout,
          );
          // A test is for debugging, so show the whole trace, not just the outcome.
          reportWaitedRun(waited, options.timeout, checkBack, { trace: true });
        })(),
    );

  designer
    .command("test-get <design> <runId>")
    .description("Show one test run: status, steps and result")
    .action((ref: string, runId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const design = await resolveDesign(ctx, ref);
        const r = await ctx.qoren.designer.designs.getTestRun(design.designId, runId);
        emit(r, () => printRun(r));
      })(),
    );

  designer
    .command("test-cancel <design> <runId>")
    .description("Stop a test run that is still going")
    .action((ref: string, runId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const design = await resolveDesign(ctx, ref);
        const res = await ctx.qoren.designer.designs.cancelTestRun(design.designId, runId);
        emit(res, () =>
          note(
            res.cancelled
              ? `Test run ${bold(res.runId)} cancelled.`
              : `Test run ${bold(res.runId)} had already finished; nothing to cancel.`,
          ),
        );
      })(),
    );

  designer
    .command("deploy <design>")
    .description("Deploy the latest published version as a new Custom agent")
    .requiredOption("--name <name>", "display name")
    .option("--slug <slug>", "identity, unique in your account (defaults to the name)")
    .option("--client <client>", "the agency client it works for, by id or name")
    .option("--pin <version>", "stay on this version instead of following the latest")
    .option("--input <key=value>", HELP_INPUT, collectPairs)
    .option("--budget <credits>", "per-run credit ceiling (default 1,000, which is $1)")
    .action(
      (
        ref: string,
        options: {
          name: string;
          slug?: string;
          client?: string;
          pin?: string;
          input?: string[];
          budget?: string;
        },
      ) =>
        run(async () => {
          const pinned = options.pin !== undefined ? parseVersion(options.pin) : undefined;
          const budget = options.budget !== undefined ? parseCredits(options.budget) : undefined;
          const ctx = requireContext(global());
          const design = await resolveDesign(ctx, ref);
          const detail = await ctx.qoren.designer.designs.get(design.designId);
          if (!detail.latestInputs) {
            throw new Error(
              `${design.name} has no published version yet. Publish it first: qoren designer publish ${design.designId}`,
            );
          }
          const customerId = options.client
            ? (await resolveClient(ctx, options.client)).id
            : undefined;
          const result = await gated(
            ctx.qoren.designer.designs.deploy(design.designId, {
              name: options.name,
              ...(options.slug ? { slug: options.slug } : {}),
              ...(customerId ? { customerId } : {}),
              ...(pinned !== undefined
                ? { versionPolicy: "pinned" as const, pinnedVersion: pinned }
                : { versionPolicy: "follow_latest" as const }),
              ...(budget !== undefined ? { runGuardCredits: budget } : {}),
              ...bindInputs(detail.latestInputs, options.input ?? []),
            }),
          );
          emit(result, () => {
            note(`Deployed ${bold(options.name)} as Custom agent ${bold(result.agentId)}.`);
            if (result.instance.status === "needs_inputs") {
              warn("It needs more inputs before it can run. Set them with qoren designer set.");
            }
            note(dim(`Try it: qoren agent chat ${result.agentId} "hello"`));
          });
        })(),
    );

  designer
    .command("starters")
    .description("List the starter designs Qoren authored")
    .action(() =>
      run(async () => {
        const ctx = requireContext(global());
        const starters = await ctx.qoren.designer.starters();
        emit(starters, () =>
          table(starters, [
            { header: "slug", value: (s) => s.slug },
            { header: "name", value: (s) => s.name },
            { header: "category", value: (s) => s.category },
            { header: "blurb", value: (s) => s.blurb },
          ]),
        );
      })(),
    );

  designer
    .command("models")
    .description("List the models this account may use in a design")
    .action(() =>
      run(async () => {
        const ctx = requireContext(global());
        const models = await ctx.qoren.designer.models();
        emit(models, () => {
          note(
            dim(
              models.billingMode === "byok"
                ? "On your own key: any model with tool support."
                : "On managed billing: the curated model list.",
            ),
          );
          table(models.models, [
            { header: "id", value: (m) => m.id },
            { header: "name", value: (m) => m.name ?? "" },
            { header: "tools", value: (m) => (m.supportsTools ? "yes" : "") },
            { header: "in $/M", value: (m) => (m.promptUsdPerM ? m.promptUsdPerM.toFixed(2) : "") },
            { header: "out $/M", value: (m) => (m.completionUsdPerM ? m.completionUsdPerM.toFixed(2) : "") },
            { header: "context", value: (m) => (m.contextLength ? m.contextLength.toLocaleString("en-US") : "") },
          ]);
        });
      })(),
    );

  designer
    .command("show <agent>")
    .description("Show which design a Custom agent runs, and its inputs, version, budget and state")
    .action((agentId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const v = await ctx.qoren.designer.getSettings(agentId);
        emit(v, () => printAgentDesigner(v));
      })(),
    );

  designer
    .command("set <agent>")
    .description("Change a Custom agent's inputs, version, budget or pause state")
    .option("--name <name>", "rename it")
    .option("--pin <version>", "stay on this version")
    .option("--follow-latest", "move to each new version as it is published")
    .option("--input <key=value>", `${HELP_INPUT}; merged into what it has`, collectPairs)
    .option("--replace", "with --input: replace its values instead of merging into them")
    .option("--budget <credits>", "per-run credit ceiling (1,000 credits is $1)")
    .option("--pause", "refuse new runs and stop its schedules")
    .option("--resume", "undo --pause")
    .action(
      (
        agentId: string,
        options: {
          name?: string;
          pin?: string;
          followLatest?: boolean;
          input?: string[];
          replace?: boolean;
          budget?: string;
          pause?: boolean;
          resume?: boolean;
        },
      ) =>
        run(async () => {
          if (options.pin !== undefined && options.followLatest) {
            throw new Error("Choose --pin or --follow-latest, not both.");
          }
          if (options.pause && options.resume) {
            throw new Error("Choose --pause or --resume, not both.");
          }
          const change: UpdateDesignerSettingsInput = {
            ...(options.name ? { name: options.name } : {}),
            ...(options.pin !== undefined
              ? { versionPolicy: "pinned" as const, pinnedVersion: parseVersion(options.pin) }
              : {}),
            ...(options.followLatest ? { versionPolicy: "follow_latest" as const } : {}),
            ...(options.budget !== undefined ? { runGuardCredits: parseCredits(options.budget) } : {}),
            ...(options.pause ? { paused: true } : {}),
            ...(options.resume ? { paused: false } : {}),
          };
          const ctx = requireContext(global());
          if (options.input?.length) {
            const current = await ctx.qoren.designer.getSettings(agentId);
            const detail = await ctx.qoren.designer.designs.get(current.designId);
            const bound = nonEmpty(bindInputs(detail.latestInputs ?? detail.inputs, options.input));
            Object.assign(change, options.replace ? bound : mergeBindings(current, bound));
          }
          if (Object.keys(change).length === 0) {
            throw new Error("Nothing to change. See qoren designer set --help.");
          }
          const result = await ctx.qoren.designer.updateSettings(agentId, change);
          emit(result, () => {
            const s = result.designer;
            note(`Updated ${bold(result.agent.name)}.`);
            details([
              ["Version", s.versionPolicy === "pinned" ? `pinned to v${s.pinnedVersion}` : "follows the latest"],
              ["Budget", `${s.runGuardCredits.toLocaleString("en-US")} credits per run`],
              ["Paused", s.paused ? "yes" : "no"],
              ["Status", result.instance ? statusColor(result.instance.status) : ""],
            ]);
          });
        })(),
    );
}
