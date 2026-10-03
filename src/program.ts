import { Command } from "commander";
import { accountCommands } from "./commands/account.js";
import { agentCommands } from "./commands/agent.js";
import { apiCommand } from "./commands/api.js";
import { approvalCommands } from "./commands/approvals.js";
import { clientsCommands } from "./commands/clients.js";
import { designerCommands } from "./commands/designer.js";
import { interactiveCommand } from "./commands/interactive.js";
import { authCommands } from "./commands/auth.js";
import { envCommands } from "./commands/env.js";
import { jobCommands } from "./commands/jobs.js";
import { secretsCommands } from "./commands/secrets.js";
import { webhookCommands } from "./commands/webhook.js";
import { VERSION, type GlobalOptions } from "./context.js";
import { setColorEnabled, setJsonMode } from "./output.js";

// The command tree.
//
// Structure: this file wires global options and delegates every verb to a
// module under commands/. Those modules call @qoren/sdk and never build a URL
// themselves, which is what keeps the CLI and the console honest with each
// other — an endpoint is described once, in the SDK, and both read it there.
//
// Adding a command is therefore: add the SDK method, add a verb here. Anything
// not yet wrapped is still reachable through `qoren api`.
//
// Kept separate from index.ts (the bin) so tests can build and inspect the tree
// without the module running the CLI on import.

/**
 * What to parse, given what was typed.
 *
 * `qoren` with nothing after it, at a real terminal, opens interactive mode:
 * there is no useful command called "nothing", and a wall of help text is a
 * poor answer to someone who has just installed this and wants to see their
 * fleet.
 *
 * Every other case is untouched, and the two that matter are: a pipe or a CI
 * log (no terminal) still gets the help text, because a full screen there
 * would be either impossible or unreadable; and `qoren --help`, which has an
 * argument and so never reaches this at all.
 */
export function argvForInteractive(
  argv: string[],
  interactive = process.stdin.isTTY === true && process.stdout.isTTY === true,
): string[] {
  return argv.length === 2 && interactive ? [...argv, "tui"] : argv;
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("qoren")
    .description("Drive your Qoren account, environments and agents.")
    .version(VERSION, "-v, --version")
    .option("--json", "print machine-readable JSON instead of a table")
    .option("--profile <name>", "which stored login to use")
    .option("--api-url <url>", "Qoren server to talk to")
    .option("--no-color", "disable colour")
    .showHelpAfterError()
    // Hand control back instead of calling process.exit itself, so index.ts
    // decides the exit code. Without this every usage mistake exits 1, which a
    // script cannot tell apart from "the request failed". Inherited by
    // subcommands created with .command().
    .exitOverride()
    .configureOutput({
      // Usage errors belong on stderr with everything else that is not data.
      writeErr: (str) => process.stderr.write(str),
    });

  // Read after parsing, so subcommands see resolved values.
  const global = (): GlobalOptions => program.opts<GlobalOptions>();

  program.hook("preAction", () => {
    const opts = global();
    setJsonMode(opts.json === true);
    // Colour only when a human is watching: a pipe, NO_COLOR or --no-color all
    // mean plain text.
    setColorEnabled(
      opts.color !== false &&
        !process.env.NO_COLOR &&
        process.stdout.isTTY === true,
    );
  });

  authCommands(program, global);
  envCommands(program, global);
  clientsCommands(program, global);
  agentCommands(program, global);
  secretsCommands(program, global);
  designerCommands(program, global);
  webhookCommands(program, global);
  approvalCommands(program, global);
  accountCommands(program, global);
  jobCommands(program, global);
  apiCommand(program, global);
  interactiveCommand(program, global);

  return program;
}
