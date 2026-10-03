import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  age,
  emit,
  fail,
  isJsonMode,
  note,
  setColorEnabled,
  setJsonMode,
  table,
  warn,
} from "./output.js";

// The promise --json makes is that stdout carries data and nothing else. These
// tests hold that line: if progress chatter ever leaks onto stdout, piping
// `qoren env ls --json` into jq breaks for everyone.

let stdout: string[];
let stderr: string[];

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  setColorEnabled(false);
  setJsonMode(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  setJsonMode(false);
});

describe("json mode", () => {
  it("prints only the payload on stdout", () => {
    setJsonMode(true);
    emit({ id: "env_1" }, () => process.stdout.write("a human table\n"));

    expect(JSON.parse(stdout.join(""))).toEqual({ id: "env_1" });
    expect(stdout.join("")).not.toContain("a human table");
  });

  it("suppresses progress notes entirely", () => {
    setJsonMode(true);
    note("Creating…");
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("still warns, because a warning outlives the pipe", () => {
    setJsonMode(true);
    warn("Out of credits.");
    // On stderr, so it cannot corrupt the JSON on stdout.
    expect(stderr.join("")).toContain("Out of credits.");
    expect(stdout).toEqual([]);
  });

  it("reports errors as structured JSON on stderr", () => {
    setJsonMode(true);
    fail("Nope.", { safetyFindings: [] });
    expect(JSON.parse(stderr.join(""))).toEqual({
      error: "Nope.",
      detail: { safetyFindings: [] },
    });
    expect(stdout).toEqual([]);
  });

  it("is off by default", () => {
    expect(isJsonMode()).toBe(false);
  });
});

describe("human mode", () => {
  it("renders the table and keeps commentary on stderr", () => {
    emit([{ name: "prod" }], () =>
      table([{ name: "prod" }], [{ header: "name", value: (r) => r.name }]),
    );
    note("done");

    expect(stdout.join("")).toContain("NAME");
    expect(stdout.join("")).toContain("prod");
    expect(stderr.join("")).toContain("done");
  });

  it("pads columns but never leaves trailing whitespace", () => {
    table(
      [
        { a: "short", b: "x" },
        { a: "much-longer-value", b: "y" },
      ],
      [
        { header: "a", value: (r) => r.a },
        { header: "b", value: (r) => r.b },
      ],
    );
    const lines = stdout.join("").trimEnd().split("\n");
    // Column a is padded so column b aligns...
    expect(lines[1]).toMatch(/^short {13}\s+x$/);
    // ...but no line ends in spaces, which would be noise in a pipe.
    for (const line of lines) expect(line).not.toMatch(/\s$/);
  });

  it("says so rather than printing an empty table", () => {
    table([], [{ header: "name", value: () => "" }]);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("Nothing to show");
  });
});

describe("age", () => {
  it("reads in the largest useful unit", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(age(ago(5 * 60_000))).toBe("5m");
    expect(age(ago(3 * 3_600_000))).toBe("3h 0m");
    expect(age(ago(5 * 86_400_000))).toBe("5d 0h");
  });

  it("is blank for absent or nonsense input rather than showing NaN", () => {
    expect(age(null)).toBe("");
    expect(age(undefined)).toBe("");
    expect(age("not a date")).toBe("");
    // A clock skew that puts creation in the future should not read "-3m".
    expect(age(new Date(Date.now() + 60_000).toISOString())).toBe("");
  });
});
