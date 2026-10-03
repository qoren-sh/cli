import { QorenError } from "@qoren/sdk";
import { describe, expect, it } from "vitest";
import { availabilityHint } from "./commands/env.js";
import { argvForInteractive, buildProgram } from "./program.js";

// The command tree is a contract with the people who script against it: a verb
// that quietly disappears breaks someone's pipeline. These assert the surface
// exists and stays shaped the way the docs describe.

function commandPaths(): string[] {
  const paths: string[] = [];
  for (const command of buildProgram().commands) {
    paths.push(command.name());
    for (const sub of command.commands) {
      paths.push(`${command.name()} ${sub.name()}`);
    }
  }
  return paths;
}

describe("command surface", () => {
  it("exposes the documented verbs", () => {
    const paths = commandPaths();
    for (const expected of [
      "login",
      "logout",
      "whoami",
      "env ls",
      "env get",
      "env create",
      "env rm",
      "env rename",
      "env resize",
      "env assign",
      "clients list",
      "clients create",
      "clients rename",
      "clients archive",
      "clients hologram",
      "secrets list",
      "secrets set",
      "secrets rm",
      "secrets reveal",
      "secrets used-by",
      "agent ls",
      "agent get",
      "agent create",
      "agent rm",
      "agent rename",
      "agent approval-mode",
      "agent limits",
      "agent message",
      "agent exec",
      "agent logs",
      "agent status",
      "agent doctor",
      "agent chatgpt-login",
      "agent chatgpt-logout",
      "agent share",
      "agent links",
      "agent unshare",
      "agent import",
      "agent run",
      "agent runs",
      "agent run-get",
      "agent run-cancel",
      "agent chat",
      "agent threads",
      "agent client",
      "agent channel",
      "agent attach",
      "agent detach",
      "agent attached",
      "designer ls",
      "designer get",
      "designer new",
      "designer rm",
      "designer export",
      "designer push",
      "designer publish",
      "designer rollback",
      "designer versions",
      "designer agents",
      "designer test",
      "designer test-get",
      "designer test-cancel",
      "designer show",
      "designer deploy",
      "designer starters",
      "designer models",
      "designer set",
      "webhook sources",
      "webhook ls",
      "webhook get",
      "webhook create",
      "webhook rules",
      "webhook events",
      "webhook pause",
      "webhook resume",
      "webhook rotate",
      "webhook test",
      "webhook deliveries",
      "webhook delivery",
      "webhook replay",
      "webhook rm",
      "approvals ls",
      "approvals approve",
      "approvals deny",
      "account usage",
      "account spending",
      "account costs",
      "jobs ls",
      "jobs get",
      "jobs cancel",
      "api",
      "tui",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it("does not offer environment-level exec or workspace commands", () => {
    // Those routes are admin-only upstream (RequireAdmin), so a command for
    // them would 403 for every user this CLI is built for. The per-agent
    // equivalents are the ones that work.
    const paths = commandPaths();
    expect(paths).not.toContain("env exec");
    expect(paths).not.toContain("env message");
    expect(paths).not.toContain("env workspace");
    // The platform-wide prompting endpoints are admin-only too.
    expect(paths).not.toContain("prompting");
    // So are the org teardown and erase routes account deletion drives, and
    // the support tooling for an erased org's retained backups.
    expect(paths.some((p) => /erase|teardown|retained/.test(p))).toBe(false);
    // And the console's outreach mail send (/api/outreach/send): only its own scheduler sends
    // from that mailbox.
    expect(paths.some((p) => p.includes("outreach"))).toBe(false);
  });

  it("names the trigger commands after what they are for", () => {
    // "webhook" is what cal.com, GitHub and Stripe all call this in their own
    // settings pages, so it is the word someone arrives already holding. The
    // aliases cover the two other things they might type.
    const webhook = buildProgram().commands.find((c) => c.name() === "webhook");
    expect(webhook?.aliases()).toEqual(
      expect.arrayContaining(["webhooks", "trigger"]),
    );
  });

  it("makes a trigger say what it is for and where it comes from", () => {
    const webhook = buildProgram().commands.find((c) => c.name() === "webhook");
    const create = webhook?.commands.find((c) => c.name() === "create");
    // The source defaults to cal.com and the event filter can be set later, but
    // a nameless trigger is unreadable in a list of them.
    expect(create?.options.filter((o) => o.required).map((o) => o.long))
      .toContain("--name");
  });

  it("offers channel verbs under agent channel", () => {
    const agent = buildProgram().commands.find((c) => c.name() === "agent");
    const channel = agent?.commands.find((c) => c.name() === "channel");
    expect(channel?.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["ls", "add", "rm", "test"]),
    );
  });

  it("points a Custom agent create at the Designer instead of deploying one", async () => {
    const program = buildProgram();
    const agent = program.commands.find((c) => c.name() === "agent");
    const create = agent?.commands.find((c) => c.name() === "create");
    const swallow = (): void => undefined;
    create?.configureOutput({ writeErr: swallow, writeOut: swallow });
    create?.showHelpAfterError(false);
    await expect(
      program.parseAsync(["node", "qoren", "agent", "create", "--runtime", "custom"]),
    ).rejects.toThrow(/qoren designer deploy/);
  });

  it("gives no designer option a name the program already owns", () => {
    // A subcommand's --version is swallowed by the program's own -v/--version.
    const program = buildProgram();
    const globals = new Set(program.options.map((o) => o.long));
    const designer = program.commands.find((c) => c.name() === "designer");
    for (const sub of designer?.commands ?? []) {
      for (const option of sub.options) {
        expect(globals.has(option.long)).toBe(false);
      }
    }
  });

  it("keeps the global options every command relies on", () => {
    const flags = buildProgram().options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining(["--json", "--profile", "--api-url", "--no-color"]),
    );
  });

  it("requires the arguments that cannot be guessed", () => {
    const env = buildProgram().commands.find((c) => c.name() === "env");
    const create = env?.commands.find((c) => c.name() === "create");
    const required = create?.options.filter((o) => o.required).map((o) => o.long);
    // A size and region have sane defaults; a name does not.
    expect(required).toContain("--name");
  });

  it("does not borrow the word the browser console already owns", () => {
    // Qoren's console is the one in a browser. A CLI verb of the same name
    // would make every sentence in the docs ambiguous about which was meant.
    const tui = buildProgram().commands.find((c) => c.name() === "tui");
    expect(tui?.aliases()).toContain("ui");
    expect(tui?.aliases()).not.toContain("console");
  });

  it("gives env and agent the plural aliases people will reach for", () => {
    const program = buildProgram();
    const env = program.commands.find((c) => c.name() === "env");
    const agent = program.commands.find((c) => c.name() === "agent");
    expect(env?.aliases()).toContain("environments");
    expect(agent?.aliases()).toContain("agents");
  });

  it("keeps the flag that answers a region_unavailable refusal", () => {
    // The hint printed on that refusal names this flag by hand. Renaming or
    // dropping it would leave the CLI telling people to type something that
    // does not exist.
    const env = buildProgram().commands.find((c) => c.name() === "env");
    const create = env?.commands.find((c) => c.name() === "create");
    expect(create?.options.map((o) => o.long)).toContain("--auto-region");
  });
});

// The hint is the whole difference between a dead end and a next step, so its
// wording is a contract too. Note that the --size value shown is the provider
// SLUG: the flag is forwarded to the API verbatim, and the API's `size` is a
// slug, so printing our `light`/`heavy` catalog key would hand someone a value
// the platform refuses.
describe("availabilityHint", () => {
  const LIGHT = {
    slug: "s-1vcpu-2gb-70gb-intel",
    key: "light",
    label: "Light",
  };
  const HEAVY = {
    slug: "s-2vcpu-4gb-120gb-intel",
    key: "heavy",
    label: "Heavy",
  };

  const regionRefusal = (over: Record<string, unknown> = {}) =>
    new QorenError("The Standard size isn't available in nyc1 right now.", 409, {
      code: "region_unavailable",
      region: "nyc1",
      size: "s-2vcpu-2gb-90gb-intel",
      provisionSize: null,
      suggestedRegion: "nyc3",
      availableSizes: [LIGHT, HEAVY],
      ...over,
    });

  const sizeRefusal = (over: Record<string, unknown> = {}) =>
    new QorenError("The Max size isn't available in fra1.", 409, {
      code: "size_unavailable",
      region: "fra1",
      size: "s-4vcpu-8gb-240gb-intel",
      availableSizes: [HEAVY],
      ...over,
    });

  it("offers both remedies when the backend offered both", () => {
    expect(availabilityHint(regionRefusal())).toBe(
      "Re-run with --auto-region to use the closest region that offers this size, " +
        "or use one of these sizes in nyc1: Light (--size s-1vcpu-2gb-70gb-intel), " +
        "Heavy (--size s-2vcpu-4gb-120gb-intel).",
    );
  });

  it("names only the flag when the region is the only way out", () => {
    expect(availabilityHint(regionRefusal({ availableSizes: [] }))).toBe(
      "Re-run with --auto-region to use the closest region that offers this size.",
    );
  });

  it("drops the flag when no region has the size, and lists what's left", () => {
    expect(
      availabilityHint(
        regionRefusal({ suggestedRegion: null, availableSizes: [LIGHT] }),
      ),
    ).toBe("Use one of these sizes in nyc1: Light (--size s-1vcpu-2gb-70gb-intel).");
  });

  it("does not re-suggest a flag the caller already passed", () => {
    expect(availabilityHint(regionRefusal(), { autoRegion: true })).toBe(
      "Use one of these sizes in nyc1: Light (--size s-1vcpu-2gb-70gb-intel), " +
        "Heavy (--size s-2vcpu-4gb-120gb-intel).",
    );
  });

  it("stays quiet when there is genuinely nothing to suggest", () => {
    expect(
      availabilityHint(
        regionRefusal({ suggestedRegion: null, availableSizes: [] }),
      ),
    ).toBeNull();
    expect(availabilityHint(sizeRefusal({ availableSizes: [] }))).toBeNull();
    expect(availabilityHint(new QorenError("Not found.", 404))).toBeNull();
    expect(availabilityHint(new Error("boom"))).toBeNull();
  });

  it("lists the sizes a resize can actually reach, with no region remedy", () => {
    // An environment cannot change region, so --auto-region must never appear.
    const hint = availabilityHint(sizeRefusal());
    expect(hint).toBe(
      "Use one of these sizes in fra1: Heavy (--size s-2vcpu-4gb-120gb-intel).",
    );
    expect(hint).not.toContain("--auto-region");
  });

  it("survives a server too old to send the alternatives at all", () => {
    expect(
      availabilityHint(
        new QorenError("Nope.", 409, {
          code: "region_unavailable",
          region: "nyc1",
          suggestedRegion: "nyc3",
        }),
      ),
    ).toBe(
      "Re-run with --auto-region to use the closest region that offers this size.",
    );
  });
});

// Typing `qoren` alone at a terminal opens interactive mode. The reason this is a
// pure function rather than an if-statement in the bin is that the cases it must
// NOT change are the ones that would break someone's pipeline, and those are
// worth pinning down.
describe("argvForInteractive", () => {
  const argv = (...args: string[]) => ["/usr/bin/node", "/bin/qoren", ...args];

  it("opens the console for a bare invocation at a terminal", () => {
    expect(argvForInteractive(argv(), true)).toEqual(argv("tui"));
  });

  it("leaves a bare invocation alone when there is no terminal", () => {
    // `qoren | cat`, or a CI log. A console there is unreadable at best, so the
    // help text stays the answer.
    expect(argvForInteractive(argv(), false)).toEqual(argv());
  });

  it("never touches an invocation that named a command", () => {
    for (const args of [["--help"], ["env", "ls"], ["--json"], ["-v"]]) {
      expect(argvForInteractive(argv(...args), true)).toEqual(argv(...args));
    }
  });
});
