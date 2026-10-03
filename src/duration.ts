// Reading a human duration off the command line.
//
// The API takes seconds, because a client has no reason to produce or parse
// "3d". A person at a terminal has every reason not to type 259200, so the flag
// takes the short form and this turns it into the number the wire wants. Same
// vocabulary the agent-facing files_share tool accepts, so a duration copied
// from the docs works in either place.

const UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/**
 * Seconds for a duration like `30m`, `2h` or `3d`, or null when it is not one.
 *
 * A bare number is refused rather than guessed at: "7" could be days or seconds
 * depending on what the reader had in mind, and getting that wrong on a public
 * link is the difference between a week and a moment.
 */
export function parseDuration(input: string): number | null {
  const match = /^\s*(\d+)\s*([smhd])\s*$/i.exec(input);
  if (!match) return null;
  const amount = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * UNITS[match[2]!.toLowerCase()]!;
}
