import pc from "picocolors";

// How the CLI talks.
//
// Two audiences, one command: a person reading a terminal, and a script reading
// stdout. Every command therefore supports --json, and the rule that keeps that
// promise honest is that DATA goes to stdout and everything else — progress,
// status, warnings — goes to stderr. A `qoren env ls --json | jq` never has to
// filter out a spinner.

export type ExitCode = 0 | 1 | 2 | 3 | 4;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;
export const EXIT_PAYMENT = 4;

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Colour is disabled for a pipe, for NO_COLOR, and for --no-color. */
export function setColorEnabled(enabled: boolean): void {
  pc.createColors(enabled);
}

/** The command's result. In --json mode this is the only thing on stdout. */
export function emit(data: unknown, render: () => void): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  render();
}

/** Human-facing progress or commentary. Always stderr, never in --json mode. */
export function note(message: string): void {
  if (jsonMode) return;
  process.stderr.write(`${message}\n`);
}

/** A warning worth seeing even when piping data out. */
export function warn(message: string): void {
  process.stderr.write(`${pc.yellow("!")} ${message}\n`);
}

/** A failure. Always stderr, and structured in --json mode so a script can read
 * the reason rather than parse prose. */
export function fail(message: string, detail?: unknown): void {
  if (jsonMode) {
    process.stderr.write(
      `${JSON.stringify({ error: message, detail: detail ?? null }, null, 2)}\n`,
    );
    return;
  }
  process.stderr.write(`${pc.red("Error:")} ${message}\n`);
}

export function dim(text: string): string {
  return pc.dim(text);
}

export function bold(text: string): string {
  return pc.bold(text);
}

/**
 * What a lifecycle word means, as a colour name rather than an escape sequence.
 *
 * Kept separate from statusColor because the interactive console (src/tui)
 * renders through Ink, which wants a colour name, not pre-styled text. One list
 * of words, read by both, so "provisioning" cannot be amber in a table and grey
 * in the console.
 */
export type Tone = "good" | "bad" | "busy" | "idle";

export function statusTone(status: string): Tone {
  const value = status.toLowerCase();
  if (
    [
      "active",
      "running",
      "succeeded",
      "connected",
      "ok",
      "healthy",
      "completed",
      "delivered",
      "executed",
    ].includes(value)
  ) {
    return "good";
  }
  if (
    [
      "failed",
      "error",
      "cancelled",
      "blocked",
      // Scheduled-task health and run outcomes.
      "failing",
      "missed",
      "ambiguous",
      "stale",
      "delivery_failing",
      "reconcile_failing",
      "timeout",
      "delivery-failing",
      "delivery-failed",
    ].includes(value)
  ) {
    return "bad";
  }
  if (
    ["new", "pending", "queued", "connecting", "provisioning", "claimed"].includes(
      value,
    )
  ) {
    return "busy";
  }
  return "idle";
}

/** Colour for a lifecycle word, so a long list reads at a glance. */
export function statusColor(status: string): string {
  switch (statusTone(status)) {
    case "good":
      return pc.green(status);
    case "bad":
      return pc.red(status);
    case "busy":
      return pc.yellow(status);
    default:
      return pc.dim(status);
  }
}

export type Column<T> = {
  header: string;
  /** Cell text. Return "" for absent; the table renders a dash. */
  value: (row: T) => string;
};

// Width is measured on the UNSTYLED text: colour codes are invisible but count
// as characters, and padding to the styled length is what makes a coloured
// column drift out of alignment.
const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\[[0-9;]*m/g, "");

const displayWidth = (text: string): number => stripAnsi(text).length;

/** A simple aligned table. Padded to the widest cell, two spaces between
 * columns, no borders — easy to read, and easy to cut/awk. */
export function table<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) {
    note(dim("Nothing to show."));
    return;
  }

  const cells = rows.map((row) =>
    columns.map((column) => column.value(row) || dim("-")),
  );
  const widths = columns.map((column, i) =>
    Math.max(
      displayWidth(column.header),
      ...cells.map((row) => displayWidth(row[i] ?? "")),
    ),
  );

  const line = (values: string[], style: (t: string) => string = (t) => t) =>
    values
      .map((value, i) => {
        const padded =
          value + " ".repeat(Math.max(0, (widths[i] ?? 0) - displayWidth(value)));
        // Never pad the last column: trailing whitespace is noise in a pipe.
        return i === values.length - 1 ? style(value) : style(padded);
      })
      .join("  ")
      .trimEnd();

  process.stdout.write(
    `${line(
      columns.map((c) => c.header.toUpperCase()),
      pc.dim,
    )}\n`,
  );
  for (const row of cells) process.stdout.write(`${line(row)}\n`);
}

/** Key/value block for a single record. */
export function details(pairs: [string, string][]): void {
  const width = Math.max(...pairs.map(([key]) => key.length));
  for (const [key, value] of pairs) {
    process.stdout.write(
      `${pc.dim(key.padEnd(width))}  ${value || pc.dim("-")}\n`,
    );
  }
}

/** Compact relative age, e.g. "3d 4h". */
export function age(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
