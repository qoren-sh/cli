import { render } from "ink";
import { App } from "./app.js";
import type { Context } from "../context.js";

// Starting interactive mode.
//
// Kept apart from the React tree so nothing in src/tui runs on import: the
// command tree is built for every invocation, including `qoren env ls --json`
// in a cron job, and mounting a renderer there would be absurd.

export class NotATerminal extends Error {}

/**
 * Take over the terminal until the reader quits.
 *
 * Refuses anywhere it cannot work rather than degrading: this needs a keyboard
 * and a screen, and a half-drawn interface in a pipe or a CI log is worse than
 * a sentence saying which command to use instead.
 */
export async function runInteractive(session: Context): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new NotATerminal(
      "Interactive mode needs a terminal. Use the commands instead: run `qoren --help`.",
    );
  }

  const instance = render(<App session={session} />, {
    // The alternate screen, the way vim and less use it: this gets the whole
    // window, and the reader's scrollback comes back untouched on quit.
    alternateScreen: true,
    // Ctrl+C is wired up in the shell so it can work while the chat field has
    // the keyboard; letting Ink handle it too would be a second exit path with
    // different teardown.
    exitOnCtrlC: false,
    incrementalRendering: true,
  });

  await instance.waitUntilExit();
}
