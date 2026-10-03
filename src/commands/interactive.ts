import type { Command } from "commander";
import { requireContext, run, type GlobalOptions } from "../context.js";
import { isJsonMode } from "../output.js";

// Interactive mode: the whole account on one screen, driven by the keyboard.
//
// Named "tui" rather than "console" on purpose. Qoren already has a console —
// the one in the browser — and a CLI verb that borrowed the word would make
// every sentence in the docs ambiguous about which one it meant.
//
// Ink and React are a good deal heavier than the rest of this package, and most
// invocations are a single command in a script that will never draw a frame, so
// it is imported dynamically: `qoren env ls --json` pays nothing for it, and
// only someone who actually asked for a screen waits for it to load.

export function interactiveCommand(
  program: Command,
  global: () => GlobalOptions,
) {
  program
    .command("tui")
    .alias("ui")
    .description("Open interactive mode")
    .action(() =>
      run(async () => {
        if (isJsonMode()) {
          // --json promises stdout carries data and nothing else. Taking over
          // the screen would break that promise rather than bend it, so say so
          // instead of half-honouring both.
          throw new Error(
            "Interactive mode cannot run with --json. Drop the flag, or use the commands.",
          );
        }
        const ctx = requireContext(global());
        const { runInteractive } = await import("../tui/index.js");
        await runInteractive(ctx);
      })(),
    );
}
