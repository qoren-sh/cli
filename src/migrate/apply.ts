import type { HostedAgentRuntime as AgentRuntime } from "@qoren/sdk";
import { orgSlug, type Context } from "../context.js";
import { followJob } from "../jobProgress.js";
import { bold, dim, note, warn } from "../output.js";
import type { ImportPlan } from "./bundle.js";

// Turning an import plan into a running agent.
//
// Four calls, in the order the platform needs them:
//
//   1. save an org template carrying the persona, MCP servers, scheduled tasks
//      and seed files (one round trip, reviewed server-side);
//   2. put any secret values the bundle carried into the vault, by name;
//   3. deploy an agent from that template with those secrets attached, and
//      wait for the job;
//   4. copy the runtime-home files (memory, skills, sessions) into place, as
//      the agent's own user, now that the runtime exists to receive them.
//
// Step 4 goes through the workspace write route plus one `exec`, because the
// write route is confined to the agent's workspace while memory lives under
// the runtime home. The files are staged under workspace/.qoren-import and
// moved with a single command that the runtime's own shell wrapper points at
// the right home variable.

export type ApplyOptions = {
  environmentId: string;
  name: string;
  slug: string;
  runtime: AgentRuntime;
  model: string;
  templateName: string;
  importSecrets: boolean;
  wait: boolean;
};

export type ApplyResult = {
  templateSlug: string;
  jobId: string;
  agentId: string | null;
  slug: string;
  secretsSet: string[];
  runtimeFilesCopied: number;
  ok: boolean;
};

const STAGE_DIR = "workspace/.qoren-import";

/** The variable each runtime's shell wrapper sets to its own home. */
const HOME_VAR: Record<AgentRuntime, string> = {
  hermes: "HERMES_HOME",
  openclaw: "OPENCLAW_HOME",
  codex: "CODEX_HOME",
};

export async function applyPlan(
  ctx: Context,
  plan: ImportPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  // 1. Template.
  note(`Saving template ${bold(options.templateName)}…`);
  const saved = await ctx.qoren.templates.save({
    name: options.templateName,
    description: `Migrated ${options.runtime} agent (${plan.mcpServers.length} MCP servers, ${plan.scheduledTasks.length} scheduled tasks).`,
    soulMd: plan.soulMd,
    agentsMd: plan.agentsMd || null,
    model: options.model,
    runtimes: [options.runtime],
    mcpServers: plan.mcpServers,
    scheduledTasks: plan.scheduledTasks,
    workspaceFiles: plan.workspaceFiles,
    overwrite: true,
  });
  const templateSlug = savedSlug(saved) ?? options.templateName;
  for (const finding of savedWarnings(saved)) warn(finding);

  // 2. Secrets.
  const secretsSet: string[] = [];
  const secretNames = Object.keys(plan.secrets);
  if (options.importSecrets && secretNames.length > 0) {
    const org = await orgSlug(ctx);
    // Saved for the target environment's agency client (when it has one), so the values neither reach
    // other clients' agents nor lose to a same-named secret that client already has.
    const { customerId } = await ctx.qoren.environments.get(options.environmentId);
    for (const name of secretNames) {
      await ctx.qoren.secrets.set(org, {
        name,
        value: plan.secrets[name]!,
        description: `Imported from the previous ${options.runtime} install.`,
        customerId: customerId ?? null,
      });
      secretsSet.push(name);
    }
    note(`Stored ${secretsSet.length} secret(s) in the vault: ${secretsSet.join(", ")}`);
  } else if (secretNames.length > 0) {
    warn(
      `The bundle carries values for ${secretNames.join(", ")} but --import-secrets was not given, so they were not stored.`,
    );
  }

  // 3. Deploy.
  const created = await ctx.qoren.agents.create({
    machineId: options.environmentId,
    slug: options.slug,
    name: options.name,
    runtime: options.runtime,
    model: options.model,
    presetName: templateSlug,
    ...(secretsSet.length > 0 ? { clientSecretNames: secretsSet } : {}),
  });
  for (const finding of created.safetyWarnings ?? []) {
    warn(`${finding.severity}: ${finding.title} ${dim(finding.suggestion)}`);
  }

  const result: ApplyResult = {
    templateSlug,
    jobId: created.jobId,
    agentId: null,
    slug: options.slug,
    secretsSet,
    runtimeFilesCopied: 0,
    ok: false,
  };
  if (!options.wait) {
    if (plan.runtimeFiles.length > 0) {
      warn(
        `${plan.runtimeFiles.length} runtime file(s) (memory, skills) were NOT copied because --no-wait skips the post-deploy step. Re-run without it, or copy them yourself with qoren agent exec.`,
      );
    }
    return result;
  }
  await followJob(ctx, created.jobId, `Deploying ${bold(options.name)}…`);

  // 4. Runtime-home files.
  const agent = (await ctx.qoren.agents.list(options.environmentId)).find(
    (a) => a.slug === options.slug,
  );
  if (!agent) {
    warn("The deploy finished but the agent could not be found by slug; runtime files were not copied.");
    return { ...result, ok: true };
  }
  result.agentId = agent._id;

  if (plan.runtimeFiles.length > 0) {
    note(`Copying ${plan.runtimeFiles.length} file(s) into the runtime home…`);
    for (const file of plan.runtimeFiles) {
      await ctx.qoren.agents.writeFile(agent._id, `${STAGE_DIR}/${file.path}`, file.content);
    }
    const homeVar = HOME_VAR[options.runtime];
    const moved = await ctx.qoren.agents.exec(agent._id, moveCommand(homeVar));
    if (moved.exitCode !== 0) {
      warn(
        `Copying runtime files failed (exit ${moved.exitCode}): ${moved.stdErr.trim() || moved.stdOut.trim()}. They are still staged under ${STAGE_DIR}.`,
      );
    } else {
      result.runtimeFilesCopied = plan.runtimeFiles.length;
    }
  }
  return { ...result, ok: true };
}

/** Move everything staged under workspace/.qoren-import into the runtime
 * home, preserving relative paths, then drop the staging directory. Existing
 * files are overwritten: the operator asked to import, and a fresh deploy has
 * nothing of its own worth keeping under memory/ yet. */
export function moveCommand(homeVar: string): string {
  return [
    "set -e",
    `dst="\${${homeVar}:-}"`,
    `[ -n "$dst" ] || { echo "${homeVar} is not set" >&2; exit 3; }`,
    `src="$HOME/${STAGE_DIR}"`,
    `cd "$src"`,
    `find . -type f | while IFS= read -r f; do mkdir -p "$dst/$(dirname "$f")"; cp "$f" "$dst/$f"; done`,
    `cd "$HOME" && rm -rf "$src"`,
  ].join("; ");
}

function savedSlug(saved: unknown): string | null {
  if (typeof saved !== "object" || saved === null) return null;
  const slug = (saved as { slug?: unknown }).slug;
  return typeof slug === "string" && slug ? slug : null;
}

function savedWarnings(saved: unknown): string[] {
  if (typeof saved !== "object" || saved === null) return [];
  const warnings = (saved as { safetyWarnings?: unknown }).safetyWarnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.map((w) => {
    const f = w as { severity?: string; title?: string; suggestion?: string };
    return `${f.severity ?? "warning"}: ${f.title ?? ""} ${f.suggestion ?? ""}`.trim();
  });
}
