import { describe, expect, it } from "vitest";
import {
  isSafePath,
  mcpFromYaml,
  parseBundle,
  parseDotenv,
  parseMinimalToml,
  parseMinimalYaml,
  planImport,
  tasksFromJobsJson,
  type ExportManifest,
} from "./bundle.js";
import { moveCommand } from "./apply.js";
import { readTar, type TarEntry } from "./tar.js";

// Fixtures are built in memory: an export is only a manifest plus text files,
// and building them here keeps each case readable next to what it asserts.

function entry(path: string, text: string): TarEntry {
  return { path, data: Buffer.from(text, "utf8") };
}

function bundleOf(
  manifest: Partial<ExportManifest> & { runtime: ExportManifest["runtime"] },
  files: Record<string, string>,
  secretsEnv?: string,
): TarEntry[] {
  const entries = [
    entry(
      "bundle/manifest.json",
      JSON.stringify({ format: "qoren-export/1", ...manifest }),
    ),
    ...Object.entries(files).map(([p, c]) => entry(`bundle/files/${p}`, c)),
  ];
  if (secretsEnv !== undefined) entries.push(entry("bundle/secrets.env", secretsEnv));
  return entries;
}

/** A minimal ustar writer, so the reader is tested against real bytes. */
function ustar(files: { path: string; text: string }[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.text, "utf8");
    const header = Buffer.alloc(512);
    header.write(file.path, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe("tar reader", () => {
  it("reads plain ustar files back out", () => {
    const bytes = ustar([
      { path: "bundle/manifest.json", text: "{}" },
      { path: "bundle/files/SOUL.md", text: "# Soul\n" },
    ]);
    const entries = readTar(bytes);
    expect(entries.map((e) => e.path)).toEqual([
      "bundle/manifest.json",
      "bundle/files/SOUL.md",
    ]);
    expect(Buffer.from(entries[1]!.data).toString()).toBe("# Soul\n");
  });
});

describe("parseBundle", () => {
  it("refuses an archive without a manifest", () => {
    expect(() => parseBundle([entry("bundle/files/x", "")])).toThrow(/manifest/);
  });

  it("refuses a format it does not know", () => {
    expect(() =>
      parseBundle([entry("bundle/manifest.json", '{"format":"qoren-export/9","runtime":"hermes"}')]),
    ).toThrow(/format/);
  });

  it("keys files by their path under bundle/files", () => {
    const bundle = parseBundle(bundleOf({ runtime: "hermes" }, { "memory/MEMORY.md": "hi" }));
    expect(bundle.files.get("memory/MEMORY.md")).toBe("hi");
    expect(bundle.secretsEnv).toBeNull();
  });
});

describe("hermes plan", () => {
  const config = `
model:
  default: "anthropic/claude-sonnet-4.5"
  provider: "openrouter"
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "\${GITHUB_TOKEN}"
  docs:
    url: "https://docs.example.com/mcp"
    headers:
      Authorization: "Bearer \${DOCS_KEY}"
    tools:
      include:
        - search
        - read
`;
  const jobs = JSON.stringify({
    jobs: [
      { name: "Morning brief", schedule: "0 7 * * 1-5", prompt: "Brief me." },
      { name: "Disabled", schedule: "0 8 * * *", prompt: "No.", enabled: false },
      { name: "Not cron", schedule: "every 5m", prompt: "Skip me." },
    ],
  });

  it("carries persona, MCP servers, tasks and memory", () => {
    const plan = planImport(
      parseBundle(
        bundleOf(
          { runtime: "hermes", envNames: ["GITHUB_TOKEN", "OPENROUTER_API_KEY", "HERMES_HOME"] },
          {
            "config.yaml": config,
            "SOUL.md": "# Ada\n",
            "AGENTS.md": "# Manual\n",
            "memory/MEMORY.md": "remember this",
            "skills/notes/SKILL.md": "---\nname: notes\n---\n",
            "cron/jobs.json": jobs,
          },
        ),
      ),
    );
    expect(plan.runtime).toBe("hermes");
    expect(plan.model).toBe("anthropic/claude-sonnet-4.5");
    expect(plan.soulMd).toBe("# Ada\n");
    expect(plan.agentsMd).toBe("# Manual\n");
    expect(plan.mcpServers).toEqual([
      {
        name: "github",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
      },
      {
        name: "docs",
        enabled: true,
        transport: "http",
        url: "https://docs.example.com/mcp",
        headers: { Authorization: "Bearer ${DOCS_KEY}" },
        toolInclude: ["search", "read"],
      },
    ]);
    expect(plan.scheduledTasks).toEqual([
      { name: "Morning brief", schedule: "0 7 * * 1-5", prompt: "Brief me." },
    ]);
    expect(plan.runtimeFiles.map((f) => f.path)).toEqual([
      "memory/MEMORY.md",
      "skills/notes/SKILL.md",
    ]);
    // Platform-managed names are dropped; the user's own key is kept.
    expect(plan.envNames).toEqual(["GITHUB_TOKEN"]);
    expect(plan.notes.some((n) => n.includes("GITHUB_TOKEN"))).toBe(true);
  });

  it("writes a placeholder persona when none was exported", () => {
    const plan = planImport(parseBundle(bundleOf({ runtime: "hermes" }, {})));
    expect(plan.soulMd).toContain("No persona file");
    expect(plan.notes.some((n) => n.startsWith("No persona"))).toBe(true);
  });

  it("only keeps secret values for keys the agent will use", () => {
    const plan = planImport(
      parseBundle(
        bundleOf(
          { runtime: "hermes", envNames: ["GITHUB_TOKEN", "OPENAI_API_KEY"] },
          {},
          'GITHUB_TOKEN="ghp_x"\nOPENAI_API_KEY=sk-y\nUNLISTED=z\n',
        ),
      ),
    );
    expect(plan.secrets).toEqual({ GITHUB_TOKEN: "ghp_x" });
    expect(plan.notes.some((n) => n.includes("OPENAI_API_KEY"))).toBe(true);
  });
});

describe("openclaw plan", () => {
  it("folds SOUL and IDENTITY into one persona and seeds the workspace", () => {
    const plan = planImport(
      parseBundle(
        bundleOf(
          { runtime: "openclaw", envNames: ["TELEGRAM_BOT_TOKEN"] },
          {
            "openclaw.json": `{
  // comment
  "agents": { "defaults": { "model": { "primary": "anthropic/claude-opus-4.5" } } },
  "mcp": { "servers": { "fs": { "command": "mcp-fs", "args": ["/data"] }, "off": { "url": "https://x", "enabled": false } } },
}`,
            "workspace/SOUL.md": "# Soul",
            "workspace/IDENTITY.md": "# Identity",
            "workspace/AGENTS.md": "# Ops",
            "workspace/USER.md": "about the user",
            "workspace/memory/2026-09-01.md": "log",
            "skills/x/SKILL.md": "skill",
            "agents/main/agent/models.json": "{}",
          },
        ),
      ),
    );
    expect(plan.model).toBe("anthropic/claude-opus-4.5");
    expect(plan.soulMd).toBe("# Soul\n\n# Identity\n");
    expect(plan.agentsMd).toBe("# Ops");
    expect(plan.mcpServers.map((m) => m.name)).toEqual(["fs"]);
    expect(plan.workspaceFiles.map((f) => f.path)).toEqual([
      "workspace/USER.md",
      "workspace/memory/2026-09-01.md",
    ]);
    expect(plan.runtimeFiles.map((f) => f.path)).toEqual(["skills/x/SKILL.md"]);
    expect(plan.notes.some((n) => n.includes("Messaging"))).toBe(true);
  });

  it("reads OpenClaw's structured cron jobs", () => {
    const tasks = tasksFromJobsJson(
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "j1",
            name: "Digest",
            schedule: { kind: "cron", expr: "0 9 * * *" },
            payload: { kind: "agentTurn", message: "Send the digest." },
          },
        ],
      }),
    );
    expect(tasks).toEqual([{ name: "Digest", schedule: "0 9 * * *", prompt: "Send the digest." }]);
  });
});

describe("codex plan", () => {
  it("uses AGENTS.md as the persona and reads MCP tables from config.toml", () => {
    const plan = planImport(
      parseBundle(
        bundleOf(
          { runtime: "codex" },
          {
            "config.toml": `model = "gpt-5-codex" # main
model_reasoning_effort = "high"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "x" }

[mcp_servers.remote]
url = "https://mcp.example.com"
`,
            "AGENTS.md": "# Codex agent",
            "memories/notes.md": "n",
            "auth.json": "{}",
          },
        ),
      ),
    );
    expect(plan.model).toBe("gpt-5-codex");
    expect(plan.soulMd).toBe("# Codex agent");
    expect(plan.agentsMd).toBe("");
    expect(plan.mcpServers).toEqual([
      {
        name: "github",
        enabled: true,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "x" },
      },
      { name: "remote", enabled: true, transport: "http", url: "https://mcp.example.com" },
    ]);
    expect(plan.runtimeFiles.map((f) => f.path)).toEqual(["memories/notes.md", "auth.json"]);
    expect(plan.notes.some((n) => n.includes("auth.json"))).toBe(true);
  });
});

describe("parsers", () => {
  it("parses a YAML block with same-indent sequences", () => {
    expect(
      parseMinimalYaml("a:\n  b: 1\n  list:\n  - x\n  - 'y'\n  inline: [p, q]\nc: \"d # not a comment\"\n"),
    ).toEqual({ a: { b: 1, list: ["x", "y"], inline: ["p", "q"] }, c: "d # not a comment" });
  });

  it("ignores a Hermes config without MCP servers", () => {
    expect(mcpFromYaml("model:\n  default: x\n")).toEqual([]);
  });

  it("parses TOML tables and inline tables", () => {
    const toml = parseMinimalToml('top = "v"\n[a.b]\nk = ["1", "2"]\nm = { X = "y" }\n');
    expect(toml.get("top")).toBe("v");
    expect(toml.get("a.b")).toEqual({ k: ["1", "2"], m: { X: "y" } });
  });

  it("parses dotenv with quotes, export and comments", () => {
    expect(parseDotenv('# c\nexport A="1"\nB=\'2\'\nC=3 # trailing\n')).toEqual({
      A: "1",
      B: "2",
      C: "3",
    });
  });

  it("refuses unsafe paths the server would refuse too", () => {
    expect(isSafePath("memory/MEMORY.md")).toBe(true);
    expect(isSafePath("../etc/passwd")).toBe(false);
    expect(isSafePath("/abs")).toBe(false);
    expect(isSafePath("has space.md")).toBe(false);
  });
});

describe("moveCommand", () => {
  it("copies into the runtime's own home variable and cleans up the stage", () => {
    const command = moveCommand("HERMES_HOME");
    expect(command).toContain('dst="${HERMES_HOME:-}"');
    expect(command).toContain("workspace/.qoren-import");
    expect(command).toContain('rm -rf "$src"');
  });
});
