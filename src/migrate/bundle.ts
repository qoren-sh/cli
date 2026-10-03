import type { TarEntry } from "./tar.js";

// From an export bundle to an import plan.
//
// migrate.sh (served at qoren.sh/migrate.sh) packs a Hermes, OpenClaw or
// Codex install into `bundle/manifest.json` plus `bundle/files/<path>`. This
// module turns that into the three things Qoren needs to stand the agent up
// again: a template (persona, operating manual, MCP servers, scheduled tasks,
// seed files), a list of secrets to put in the vault, and a list of files to
// copy into the runtime's home once the agent exists.
//
// Everything here is pure: no filesystem, no network, no node-only globals.
// That is what makes it testable against fixtures, what makes `--dry-run` an
// honest preview of exactly what the real run will send, and what lets the
// console run the same code in the browser. This file is kept byte-identical
// between cli/src/migrate and dashboard/src/lib/migrate (a dashboard test
// checks), which is why the wire types below are declared here rather than
// imported from either package.

export type AgentRuntime = "hermes" | "openclaw" | "codex";

/** Structurally the API's McpServer (see @qoren/sdk types). */
export type McpServer = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  toolInclude?: string[];
  toolExclude?: string[];
};

export type ScheduledTask = {
  name: string;
  schedule: string;
  prompt: string;
};

export type WorkspaceFile = {
  path: string;
  description: string;
  content: string;
};

export const RUNTIMES: AgentRuntime[] = ["hermes", "openclaw", "codex"];

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type ExportManifest = {
  format: string;
  runtime: AgentRuntime;
  runtimeVersion?: string;
  exportedAt?: string;
  host?: string;
  sourceHome?: string;
  model?: string;
  withSecrets?: boolean;
  withSessions?: boolean;
  envNames?: string[];
  files?: string[];
  skipped?: string[];
};

export type Bundle = {
  manifest: ExportManifest;
  /** Text files, keyed by their path relative to `bundle/files/`. */
  files: Map<string, string>;
  /** The raw dotenv the exporter packed under --with-secrets, if any. */
  secretsEnv: string | null;
};

/** A file to place under the runtime's own home (HERMES_HOME, OPENCLAW_HOME or
 * CODEX_HOME) after the agent is deployed. Distinct from a template seed file,
 * which lands under the agent's Unix home. */
export type RuntimeFile = {
  path: string;
  content: string;
};

export type ImportPlan = {
  runtime: AgentRuntime;
  /** The model the source was using, or null when the exporter found none. */
  model: string | null;
  soulMd: string;
  agentsMd: string;
  mcpServers: McpServer[];
  scheduledTasks: ScheduledTask[];
  workspaceFiles: WorkspaceFile[];
  runtimeFiles: RuntimeFile[];
  /** Env var names the source defined and Qoren does not provide itself. */
  envNames: string[];
  /** Values for those names, when the bundle carried them. */
  secrets: Record<string, string>;
  /** Things the operator should know that are not errors. */
  notes: string[];
};

const MAX_FILE_BYTES = 256 * 1024;

/** Variables the platform sets itself, or that would fight the ones it sets. */
const PLATFORM_MANAGED = new Set([
  "HOME",
  "HERMES_HOME",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "OPENROUTER_API_KEY",
  "QOREN_MCP_TOKEN",
]);

/** Model-provider keys. Qoren meters models through its own OpenRouter key;
 * an operator who wants their own goes through bring-your-own-key instead. */
const PROVIDER_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
]);

// ------------------------------------------------------------------ bundle

export function parseBundle(entries: TarEntry[]): Bundle {
  let manifest: ExportManifest | null = null;
  const files = new Map<string, string>();
  let secretsEnv: string | null = null;

  for (const entry of entries) {
    const path = entry.path.replace(/^\.\//, "");
    const text = () => decoder.decode(entry.data);
    if (path === "bundle/manifest.json") {
      manifest = JSON.parse(text()) as ExportManifest;
    } else if (path === "bundle/secrets.env") {
      secretsEnv = text();
    } else if (path.startsWith("bundle/files/")) {
      files.set(path.slice("bundle/files/".length), text());
    }
  }

  if (!manifest) {
    throw new Error(
      "Not a Qoren export: bundle/manifest.json is missing. Produce one with `curl -fsSL https://qoren.sh/migrate.sh | sh`.",
    );
  }
  if (manifest.format !== "qoren-export/1") {
    throw new Error(
      `Unsupported export format "${manifest.format}". Update the CLI, or re-run the export script.`,
    );
  }
  if (!RUNTIMES.includes(manifest.runtime)) {
    throw new Error(`Unknown runtime "${manifest.runtime}" in the export.`);
  }
  return { manifest, files, secretsEnv };
}

// -------------------------------------------------------------------- plan

export function planImport(bundle: Bundle): ImportPlan {
  const notes: string[] = [];
  const { manifest, files } = bundle;
  const secrets = bundle.secretsEnv ? parseDotenv(bundle.secretsEnv) : {};

  const base: ImportPlan = {
    runtime: manifest.runtime,
    model: manifest.model?.trim() ? manifest.model.trim() : null,
    soulMd: "",
    agentsMd: "",
    mcpServers: [],
    scheduledTasks: [],
    workspaceFiles: [],
    runtimeFiles: [],
    envNames: [],
    secrets: {},
    notes,
  };

  const plan =
    manifest.runtime === "hermes"
      ? planHermes(base, files)
      : manifest.runtime === "openclaw"
        ? planOpenClaw(base, files)
        : planCodex(base, files);

  // Environment: the names the source defined, minus what Qoren provides.
  const names = (manifest.envNames ?? []).filter((n) => /^[A-Z_][A-Z0-9_]*$/i.test(n));
  const providerKeys = names.filter((n) => PROVIDER_KEYS.has(n));
  plan.envNames = names.filter(
    (n) => !PLATFORM_MANAGED.has(n) && !PROVIDER_KEYS.has(n),
  );
  if (providerKeys.length > 0) {
    notes.push(
      `Model provider keys were not carried over (${providerKeys.join(", ")}): Qoren meters models through its own key. To use your own, add it under Settings, Bring your own key.`,
    );
  }
  for (const name of plan.envNames) {
    if (secrets[name] !== undefined) plan.secrets[name] = secrets[name];
  }
  const missing = plan.envNames.filter((n) => plan.secrets[n] === undefined);
  if (missing.length > 0) {
    notes.push(
      `Values for ${missing.join(", ")} are not in the bundle. Add them in the vault and attach them with qoren agent create --secret, or re-export with --with-secrets.`,
    );
  }
  const messaging = names.filter((n) =>
    /^(TELEGRAM|DISCORD|SLACK|WHATSAPP|SIGNAL|MATRIX)_/i.test(n),
  );
  if (messaging.length > 0) {
    notes.push(
      `Messaging credentials were found (${messaging.join(", ")}). Connect the channel from the agent's Settings > Connections in the console; a bot token alone is not enough to bring a gateway up.`,
    );
  }

  if ((manifest.skipped ?? []).length > 0) {
    notes.push(
      `The export skipped ${manifest.skipped!.length} file(s) that were binary or too large; see manifest.json in the bundle.`,
    );
  }
  if (!plan.soulMd.trim()) {
    plan.soulMd = `# ${capitalize(manifest.runtime)} agent\n\nMigrated from ${manifest.host ?? "a self-hosted install"} on ${manifest.exportedAt ?? "an unknown date"}. No persona file was found in the export; describe who this agent is here.\n`;
    notes.push(
      "No persona file (SOUL.md or IDENTITY.md) was in the export, so a placeholder was written. Edit it from the agent's Memory tab.",
    );
  }
  return plan;
}

// ------------------------------------------------------------------ hermes

function planHermes(plan: ImportPlan, files: Map<string, string>): ImportPlan {
  plan.soulMd = files.get("SOUL.md") ?? "";
  plan.agentsMd = files.get("AGENTS.md") ?? "";

  const config = files.get("config.yaml");
  if (config) {
    plan.mcpServers = mcpFromYaml(config);
    plan.model ??= hermesModel(config);
  }

  plan.scheduledTasks = tasksFromJobsJson(files.get("cron/jobs.json"));

  // Memory and skills live under HERMES_HOME on both sides.
  for (const [path, content] of files) {
    if (path.startsWith("memory/") || path.startsWith("skills/") || path.startsWith("sessions/")) {
      pushRuntimeFile(plan, path, content);
    }
  }
  return plan;
}

function hermesModel(yaml: string): string | null {
  const block = /^model:\s*\n((?:[ \t]+.*\n?)*)/m.exec(yaml);
  if (!block) return null;
  const line = /^\s+default:\s*["']?([^"'\s#]+)/m.exec(block[1] ?? "");
  return line?.[1] ?? null;
}

// ---------------------------------------------------------------- openclaw

function planOpenClaw(plan: ImportPlan, files: Map<string, string>): ImportPlan {
  const soul = files.get("workspace/SOUL.md")?.trim() ?? "";
  const rawIdentity = files.get("workspace/IDENTITY.md")?.trim() ?? "";
  // An IDENTITY.md Qoren wrote holds only the agent's name (the persona is in
  // SOUL.md, see OpenClawPersona in magentic-core), so it adds nothing to fold.
  const identity = rawIdentity.includes("<!-- magentic:identity-meta") ? "" : rawIdentity;
  // Older Qoren agents, and OpenClaw's own bootstrap ritual, can put persona
  // text in both files, so the two are folded into one document rather than
  // one being dropped.
  plan.soulMd =
    soul && identity && soul !== identity
      ? `${soul}\n\n${identity}\n`
      : `${soul || identity}\n`;
  if (!soul && !identity) plan.soulMd = "";
  plan.agentsMd = files.get("workspace/AGENTS.md") ?? "";

  const config = files.get("openclaw.json");
  if (config) {
    const parsed = parseLenientJson(config);
    if (parsed) {
      plan.mcpServers = mcpFromOpenClaw(parsed);
      plan.model ??= openClawModel(parsed);
    } else {
      plan.notes.push(
        "openclaw.json could not be parsed, so MCP servers and the model were not read from it.",
      );
    }
  }

  plan.scheduledTasks = tasksFromJobsJson(files.get("cron/jobs.json"));

  const persona = new Set(["workspace/SOUL.md", "workspace/IDENTITY.md", "workspace/AGENTS.md"]);
  for (const [path, content] of files) {
    if (persona.has(path)) continue;
    if (path.startsWith("workspace/")) {
      // OpenClaw's workspace is the agent's workspace on Qoren too: seed it
      // through the template so it is there before the first turn.
      pushWorkspaceFile(plan, path, content);
    } else if (path.startsWith("skills/") || path.startsWith("sessions/")) {
      pushRuntimeFile(plan, path, content);
    }
    // agents/<id>/* is runtime-managed identity for the old install; Qoren
    // registers its own agent, so those files are deliberately not carried.
  }
  return plan;
}

function openClawModel(config: Record<string, unknown>): string | null {
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const model = asRecord(defaults?.model) ?? asRecord(config.model);
  const primary = model?.primary;
  if (typeof primary === "string" && primary.trim()) return primary.trim();
  if (typeof defaults?.model === "string") return defaults.model;
  return null;
}

function mcpFromOpenClaw(config: Record<string, unknown>): McpServer[] {
  const mcp = asRecord(config.mcp);
  const servers = asRecord(mcp?.servers) ?? asRecord(config.mcpServers);
  if (!servers) return [];
  const out: McpServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const server = asRecord(raw);
    if (!server) continue;
    const built = mcpFromRecord(name, server);
    if (built) out.push(built);
  }
  return out;
}

// ------------------------------------------------------------------- codex

function planCodex(plan: ImportPlan, files: Map<string, string>): ImportPlan {
  // Codex has one instructions file. Qoren writes the persona there, so the
  // whole AGENTS.md becomes the persona rather than being split in two.
  plan.soulMd = files.get("AGENTS.md") ?? "";
  plan.agentsMd = "";

  const config = files.get("config.toml");
  if (config) {
    const toml = parseMinimalToml(config);
    plan.mcpServers = mcpFromToml(toml);
    if (!plan.model) {
      const model = toml.get("model");
      if (typeof model === "string" && model.trim()) plan.model = model.trim();
    }
  }

  for (const [path, content] of files) {
    if (
      path.startsWith("skills/") ||
      path.startsWith("memories/") ||
      path.startsWith("rules/") ||
      path.startsWith("prompts/") ||
      path.startsWith("sessions/") ||
      path === "auth.json"
    ) {
      pushRuntimeFile(plan, path, content);
    }
  }
  if (files.has("auth.json")) {
    plan.notes.push(
      "auth.json was carried over: the agent will run on your ChatGPT sign-in once deployed. Run qoren agent chatgpt-logout to drop it.",
    );
  }
  return plan;
}

function mcpFromToml(toml: Map<string, unknown>): McpServer[] {
  const out: McpServer[] = [];
  for (const [key, value] of toml) {
    const match = /^mcp_servers\.(.+)$/.exec(key);
    if (!match) continue;
    const server = asRecord(value);
    if (!server) continue;
    const built = mcpFromRecord(match[1]!, server);
    if (built) out.push(built);
  }
  return out;
}

// ---------------------------------------------------------- shared helpers

function pushRuntimeFile(plan: ImportPlan, path: string, content: string): void {
  if (!isSafePath(path)) {
    plan.notes.push(`Skipped ${path}: the path is not one Qoren will write.`);
    return;
  }
  if (encoder.encode(content).length > MAX_FILE_BYTES) {
    plan.notes.push(`Skipped ${path}: larger than 256 KB.`);
    return;
  }
  plan.runtimeFiles.push({ path, content });
}

function pushWorkspaceFile(plan: ImportPlan, path: string, content: string): void {
  if (!isSafePath(path)) {
    plan.notes.push(`Skipped ${path}: the path is not one Qoren will write.`);
    return;
  }
  if (encoder.encode(content).length > MAX_FILE_BYTES) {
    plan.notes.push(`Skipped ${path}: larger than 256 KB.`);
    return;
  }
  plan.workspaceFiles.push({
    path,
    description: `Migrated from the previous install (${path}).`,
    content,
  });
}

/** Mirrors WorkspaceFile.IsSafePath on the server: relative, no parent
 * segments, and a conservative character set (no spaces). */
export function isSafePath(path: string): boolean {
  if (!path || path.startsWith("/")) return false;
  const segments = path.split(/[\\/]/);
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return /^[A-Za-z0-9/._-]+$/.test(path);
}

/** The server accepts names of letters, digits, `_` and `-`. */
function isValidMcpName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

function mcpFromRecord(name: string, server: Record<string, unknown>): McpServer | null {
  if (!isValidMcpName(name)) return null;
  if (server.enabled === false || server.disabled === true) return null;
  const command = str(server.command);
  const url = str(server.url);
  const base = { name, enabled: true as const };
  const tools = asRecord(server.tools);
  const include = strList(tools?.include) ?? strList(server.enabled_tools);
  const exclude = strList(tools?.exclude) ?? strList(server.disabled_tools);
  const toolFields = {
    ...(include ? { toolInclude: include } : {}),
    ...(exclude ? { toolExclude: exclude } : {}),
  };
  if (command) {
    return {
      ...base,
      transport: "stdio",
      command,
      ...(strList(server.args) ? { args: strList(server.args)! } : {}),
      ...(strMap(server.env) ? { env: strMap(server.env)! } : {}),
      ...toolFields,
    };
  }
  if (url) {
    return {
      ...base,
      transport: "http",
      url,
      ...(strMap(server.headers) ? { headers: strMap(server.headers)! } : {}),
      ...toolFields,
    };
  }
  return null;
}

/** Hermes' `mcp_servers:` block. Hermes writes it as a map of name to a map of
 * command/args/env or url/headers, and `tools: {include, exclude}`. */
export function mcpFromYaml(yaml: string): McpServer[] {
  const tree = parseMinimalYaml(yaml);
  const servers = asRecord(tree.mcp_servers);
  if (!servers) return [];
  const out: McpServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const server = asRecord(raw);
    if (!server) continue;
    const built = mcpFromRecord(name, server);
    if (built) out.push(built);
  }
  return out;
}

/** Both Hermes and OpenClaw keep scheduled jobs in a `cron/jobs.json` whose
 * shape has shifted between versions; read the fields that matter and skip
 * what cannot be understood rather than refusing the whole file. */
export function tasksFromJobsJson(json: string | undefined): ScheduledTask[] {
  if (!json) return [];
  const parsed = parseLenientJson(json);
  if (!parsed) return [];
  const list = Array.isArray(parsed.jobs)
    ? parsed.jobs
    : Array.isArray(parsed)
      ? (parsed as unknown[])
      : [];
  const out: ScheduledTask[] = [];
  for (const raw of list) {
    const job = asRecord(raw);
    if (!job) continue;
    if (job.enabled === false) continue;
    const scheduleRaw = job.schedule ?? job.cron;
    const schedule =
      typeof scheduleRaw === "string"
        ? scheduleRaw
        : (str(asRecord(scheduleRaw)?.expr) ?? str(asRecord(scheduleRaw)?.cron));
    const payload = asRecord(job.payload);
    const prompt =
      str(job.prompt) ??
      str(job.message) ??
      str(payload?.message) ??
      str(payload?.text) ??
      str(payload?.prompt);
    if (!schedule || !prompt) continue;
    if (!looksLikeCron(schedule)) continue;
    const name =
      str(job.name) ?? str(job.id) ?? `job-${out.length + 1}`;
    out.push({ name: name.slice(0, 80), schedule, prompt });
  }
  return out;
}

function looksLikeCron(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  return parts.length === 5 || parts.length === 6;
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[match[1]!] = value;
  }
  return out;
}

/** JSON, or the JSON-with-comments-and-trailing-commas that OpenClaw accepts. */
export function parseLenientJson(text: string): Record<string, unknown> | null {
  const attempt = (source: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(source);
      return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  return (
    attempt(text) ??
    attempt(
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1"),
    )
  );
}

// A YAML subset: block maps, block sequences of scalars, inline `[a, b]`
// lists, and quoted or bare scalars. Enough for a Hermes config.yaml, which
// Hermes itself writes with a real emitter, so the shapes are regular.
export function parseMinimalYaml(text: string): Record<string, unknown> {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => ({
      indent: raw.length - raw.trimStart().length,
      body: stripYamlComment(raw).trim(),
    }))
    .filter((l) => l.body !== "");
  let i = 0;

  const parseList = (indent: number): unknown[] => {
    const list: unknown[] = [];
    while (i < lines.length && lines[i]!.indent === indent && lines[i]!.body.startsWith("- ")) {
      list.push(yamlScalar(lines[i]!.body.slice(2).trim()));
      i++;
    }
    // Anything nested deeper than a scalar item is beyond this subset.
    while (i < lines.length && lines[i]!.indent > indent) i++;
    return list;
  };

  const parseMap = (indent: number): Record<string, unknown> => {
    const map: Record<string, unknown> = {};
    while (i < lines.length && lines[i]!.indent === indent) {
      const body = lines[i]!.body;
      const match = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(body);
      if (!match) {
        i++;
        continue;
      }
      const key = match[1]!.replace(/^["']|["']$/g, "");
      const rest = (match[2] ?? "").trim();
      i++;
      if (rest !== "") {
        map[key] = yamlScalar(rest);
        continue;
      }
      const next = lines[i];
      if (!next || next.indent < indent) {
        map[key] = null;
      } else if (next.body.startsWith("- ") && next.indent >= indent) {
        map[key] = parseList(next.indent);
      } else if (next.indent > indent) {
        map[key] = parseMap(next.indent);
      } else {
        map[key] = null;
      }
    }
    // Skip anything indented oddly relative to this block.
    while (i < lines.length && lines[i]!.indent > indent) i++;
    return map;
  };

  return lines.length === 0 ? {} : parseMap(lines[0]!.indent);
}

function stripYamlComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inString) {
      if (c === inString) inString = null;
    } else if (c === '"' || c === "'") {
      inString = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function yamlScalar(text: string): unknown {
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    return inner ? splitTopLevel(inner).map((s) => yamlScalar(s.trim())) : [];
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const record: Record<string, unknown> = {};
    for (const part of splitTopLevel(text.slice(1, -1))) {
      const kv = /^("[^"]*"|'[^']*'|[^:]+?)\s*:\s*(.+)$/.exec(part.trim());
      if (kv) record[kv[1]!.replace(/^["']|["']$/g, "")] = yamlScalar(kv[2]!.trim());
    }
    return record;
  }
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

// A TOML subset: `[table.sub]` headers, `key = "string"`, `key = ["a", "b"]`,
// `key = { A = "1" }` inline tables, numbers and booleans. Nested tables come
// back keyed by their dotted header, e.g. `mcp_servers.github`.
export function parseMinimalToml(text: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let table: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1]!.trim().replace(/"/g, "");
      if (!out.has(table)) out.set(table, {});
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.replace(/^"|"$/g, "");
    const value = tomlValue(kv[2]!.trim());
    if (table === null) {
      out.set(key, value);
    } else {
      const record = out.get(table) as Record<string, unknown>;
      record[key] = value;
    }
  }
  return out;
}

function stripTomlComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === inString) inString = null;
    } else if (c === '"' || c === "'") {
      inString = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function tomlValue(text: string): unknown {
  if (text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text.startsWith("[") && text.endsWith("]")) {
    return splitTopLevel(text.slice(1, -1)).map((s) => tomlValue(s.trim()));
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const record: Record<string, unknown> = {};
    for (const part of splitTopLevel(text.slice(1, -1))) {
      const kv = /^([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.+)$/.exec(part.trim());
      if (kv) record[kv[1]!.replace(/^"|"$/g, "")] = tomlValue(kv[2]!.trim());
    }
    return record;
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** Split on commas that are not inside quotes or nested brackets. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      current += c;
      if (c === "\\") {
        current += text[i + 1] ?? "";
        i++;
      } else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") inString = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function strList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return list.length > 0 ? list : null;
}

function strMap(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (!record) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
