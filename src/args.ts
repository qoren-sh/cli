import { readFileSync } from "node:fs";

// Small readers for values typed on the command line, shared by the commands
// that take them so each reads the same way everywhere.

/** `on`/`off` (and the usual synonyms) off the command line, or null when it is neither. */
export function parseOnOff(input: string): boolean | null {
  const v = input.trim().toLowerCase();
  if (["on", "true", "yes", "enable", "enabled", "1"].includes(v)) return true;
  if (["off", "false", "no", "disable", "disabled", "0"].includes(v))
    return false;
  return null;
}

/** A JSON value given inline, or read from a file with `@path`. */
export function readJsonArg(value: string, what: string): unknown {
  const text = value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `${what} is not valid JSON. Pass it inline, or as @file.json to read a file.`,
    );
  }
}
