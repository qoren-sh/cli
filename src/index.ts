#!/usr/bin/env node
import { argvForInteractive, buildProgram } from "./program.js";
import { EXIT_ERROR, EXIT_USAGE, fail } from "./output.js";

// The `qoren` binary. The command tree lives in program.ts; this only runs it
// and decides what the shell sees.

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(argvForInteractive(process.argv));
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Commander signals --help and --version by throwing. Neither is a failure.
    if (code === "commander.helpDisplayed" || code === "commander.version") {
      return;
    }
    if (code?.startsWith("commander.")) {
      process.exitCode = EXIT_USAGE;
      return;
    }
    // A command body handles its own errors (see context.run); anything
    // arriving here is unexpected, so report it rather than dying silently.
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT_ERROR;
  }
}

void main();
