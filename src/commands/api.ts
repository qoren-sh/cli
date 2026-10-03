import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { requireContext, run, type GlobalOptions } from "../context.js";

// The escape hatch.
//
// This CLI wraps the endpoints most people need, not all ~137 of them, and the
// control plane gains endpoints faster than commands get written for them.
// Rather than making a new endpoint unreachable until someone adds a verb,
// `qoren api` speaks to any of them directly — same credential, same proxy,
// same rules. It is the reason a missing command is an inconvenience instead of
// a blocker.
//
// Output is always raw JSON, because there is nothing to know about the shape.

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function apiCommand(program: Command, global: () => GlobalOptions) {
  program
    .command("api <method> <path>")
    .description("Call any control-plane endpoint directly")
    .option(
      "--data <json>",
      "request body as JSON, or @filename to read from a file (- for stdin)",
    )
    .option("--query <key=value...>", "query string parameters; repeatable")
    .addHelpText(
      "after",
      `
Examples:
  qoren api GET agents
  qoren api GET machines --query limit=5
  qoren api POST agents --data @agent.json
  qoren api DELETE machines/abc123`,
    )
    .action(
      (
        method: string,
        path: string,
        options: { data?: string; query?: string[] },
      ) =>
        run(async () => {
          const ctx = requireContext(global());
          const verb = method.toUpperCase();
          if (!METHODS.includes(verb)) {
            throw new Error(
              `Unknown method "${method}". Use one of: ${METHODS.join(", ")}.`,
            );
          }

          const query: Record<string, string> = {};
          for (const pair of options.query ?? []) {
            const index = pair.indexOf("=");
            if (index < 1) {
              throw new Error(`Could not read --query "${pair}". Use key=value.`);
            }
            query[pair.slice(0, index)] = pair.slice(index + 1);
          }

          const result = await ctx.qoren.raw(path, {
            method: verb,
            ...(options.data !== undefined
              ? { body: parseBody(options.data) }
              : {}),
            ...(Object.keys(query).length > 0 ? { query } : {}),
          });

          // Raw by definition: no --json switch, because there is no human
          // rendering to switch away from.
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        })(),
    );
}

/** `--data` accepts inline JSON, @file, or @- for stdin. */
function parseBody(value: string): unknown {
  let text = value;
  if (value.startsWith("@")) {
    const source = value.slice(1);
    text = readFileSync(source === "-" ? 0 : source, "utf8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("--data is not valid JSON.");
  }
}
