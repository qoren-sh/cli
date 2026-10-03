import type { Job } from "@qoren/sdk";
import { describe, expect, it } from "vitest";
import {
  currentStep,
  editLine,
  emptyLine,
  jobProgressText,
  moveSelection,
  readChatTurn,
  readableDate,
  refreshDelay,
  scrollWindow,
  statusColorName,
  truncate,
  wrapText,
} from "./model.js";

// The console's behaviour, tested where it can be: the pure functions the React
// tree is a thin shell over. A key that moves the selection to the wrong row, a
// scroll window that jumps, a reply parsed wrong — all of those are here rather
// than in a component nobody can hold still long enough to assert on.

describe("moveSelection", () => {
  it("clamps rather than wrapping, at both ends", () => {
    // Wrapping would make holding the arrow key indistinguishable from not
    // having moved at all, in a list too long to see the ends of.
    expect(moveSelection(5, 0, -1)).toBe(0);
    expect(moveSelection(5, 4, 1)).toBe(4);
    expect(moveSelection(5, 2, 1)).toBe(3);
    expect(moveSelection(5, 0, 10)).toBe(4);
  });

  it("stays at zero on an empty list", () => {
    expect(moveSelection(0, 0, 1)).toBe(0);
  });
});

describe("scrollWindow", () => {
  it("shows the whole list when it fits", () => {
    expect(scrollWindow(3, 1, 10)).toEqual({ start: 0, end: 3 });
  });

  it("only moves when the selection would leave the window", () => {
    // Selecting the last visible row must not scroll: the reader can still see
    // where they came from.
    expect(scrollWindow(20, 4, 5, 0)).toEqual({ start: 0, end: 5 });
    expect(scrollWindow(20, 5, 5, 0)).toEqual({ start: 1, end: 6 });
    expect(scrollWindow(20, 3, 5, 3)).toEqual({ start: 3, end: 8 });
    expect(scrollWindow(20, 2, 5, 3)).toEqual({ start: 2, end: 7 });
  });

  it("scrolls one line at a time rather than by a screenful", () => {
    let start = 0;
    for (let selected = 0; selected < 12; selected++) {
      start = scrollWindow(30, selected, 5, start).start;
    }
    expect(start).toBe(7);
  });

  it("never scrolls past the end", () => {
    expect(scrollWindow(6, 5, 5, 99)).toEqual({ start: 1, end: 6 });
  });

  it("copes with no rows and no room", () => {
    expect(scrollWindow(0, 0, 5)).toEqual({ start: 0, end: 0 });
    expect(scrollWindow(5, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("editLine", () => {
  const line = (value: string, cursor = value.length) => ({ value, cursor });

  it("inserts at the cursor, not the end", () => {
    expect(editLine(line("ac", 1), "b", {})).toEqual(line("abc", 2));
  });

  it("takes a whole paste in one go", () => {
    expect(editLine(emptyLine(), "a pasted name", {})).toEqual(
      line("a pasted name"),
    );
  });

  it("drops control characters a paste carried in", () => {
    // Invisible on screen and unfixable once stored, so they never get in.
    expect(editLine(emptyLine(), "prod\u001b[31m-1\u0007", {}).value).toBe(
      "prod[31m-1",
    );
  });

  it("backspaces to the left and does nothing at the start", () => {
    expect(editLine(line("abc"), "", { backspace: true })).toEqual(line("ab"));
    expect(editLine(line("abc", 0), "", { backspace: true })).toEqual(
      line("abc", 0),
    );
  });

  it("treats delete as forward delete, or as backspace at the end", () => {
    // Some terminals report backspace as delete, so the end-of-line case has to
    // rub out to the left or the key appears to be broken.
    expect(editLine(line("abc", 1), "", { delete: true })).toEqual(
      line("ac", 1),
    );
    expect(editLine(line("abc"), "", { delete: true })).toEqual(line("ab"));
  });

  it("moves and clamps the cursor", () => {
    expect(editLine(line("abc", 0), "", { leftArrow: true })).toEqual(
      line("abc", 0),
    );
    expect(editLine(line("abc"), "", { rightArrow: true })).toEqual(line("abc"));
    expect(editLine(line("abc"), "", { home: true })).toEqual(line("abc", 0));
    expect(editLine(line("abc", 0), "", { end: true })).toEqual(line("abc", 3));
  });

  it("keeps the readline habits people's fingers already know", () => {
    expect(editLine(line("hello"), "a", { ctrl: true })).toEqual(
      line("hello", 0),
    );
    expect(editLine(line("hello", 0), "e", { ctrl: true })).toEqual(
      line("hello", 5),
    );
    expect(editLine(line("hello world", 6), "u", { ctrl: true })).toEqual(
      line("world", 0),
    );
    expect(editLine(line("hello world", 5), "k", { ctrl: true })).toEqual(
      line("hello", 5),
    );
    expect(editLine(line("hello world"), "w", { ctrl: true })).toEqual(
      line("hello ", 6),
    );
  });

  it("returns the same state when the key means nothing here", () => {
    // The caller relies on identity to know it should let a parent handle it.
    const before = line("abc");
    expect(editLine(before, "", {})).toBe(before);
    expect(editLine(before, "x", { meta: true })).toBe(before);
    expect(editLine(before, "z", { ctrl: true })).toBe(before);
  });
});

describe("readChatTurn", () => {
  it("reads a streaming partial, tool and all", () => {
    // The exact shape the control plane writes into the job while a turn runs.
    expect(
      readChatTurn({
        exitCode: 0,
        stdOut: "Looking at that now",
        stdErr: "",
        streaming: true,
        tool: "bash",
      }),
    ).toEqual({
      text: "Looking at that now",
      streaming: true,
      tool: "bash",
      sessionId: null,
      stdErr: "",
      exitCode: 0,
    });
  });

  it("reads the final result and its session id", () => {
    const turn = readChatTurn({
      exitCode: 0,
      stdOut: "Done.",
      stdErr: "",
      sessionId: "mgc-abc123",
    });
    expect(turn.sessionId).toBe("mgc-abc123");
    expect(turn.streaming).toBe(false);
  });

  it("reports no session for a turn that fell back to the SSH path", () => {
    // Overwriting a good session id with null would silently end the
    // conversation, so the caller must be able to tell "none" from "unchanged".
    expect(readChatTurn({ exitCode: 0, stdOut: "hi" }).sessionId).toBeNull();
    expect(readChatTurn({ sessionId: "" }).sessionId).toBeNull();
  });

  it("survives a job with no result at all", () => {
    for (const value of [null, undefined, "nonsense", 42]) {
      expect(readChatTurn(value).text).toBe("");
    }
  });
});

describe("refreshDelay", () => {
  it("polls hard while anything is mid-flight", () => {
    expect(refreshDelay(["active", "new"])).toBe(3_000);
    expect(refreshDelay(["Running"])).toBe(3_000);
  });

  it("backs off when the fleet is at rest", () => {
    // Every poll is a real request against someone's control plane.
    expect(refreshDelay(["active", "off"])).toBe(20_000);
    expect(refreshDelay(["Succeeded", "Failed", "Cancelled"])).toBe(20_000);
    expect(refreshDelay([])).toBe(20_000);
  });
});

describe("job summaries", () => {
  const job = (steps: [string, string][]): Job =>
    ({
      steps: steps.map(([key, status]) => ({
        key,
        label: key,
        status,
        startedAt: null,
        finishedAt: null,
        detail: null,
      })),
    }) as unknown as Job;

  it("counts finished steps", () => {
    expect(
      jobProgressText(
        job([
          ["a", "Succeeded"],
          ["b", "Running"],
          ["c", "Pending"],
        ]),
      ),
    ).toBe("1/3");
    expect(jobProgressText(job([]))).toBe("");
  });

  it("names the step in flight, or the last one that started", () => {
    expect(
      currentStep(
        job([
          ["a", "Succeeded"],
          ["b", "Running"],
        ]),
      ),
    ).toBe("b");
    expect(
      currentStep(
        job([
          ["a", "Succeeded"],
          ["b", "Pending"],
        ]),
      ),
    ).toBe("a");
    expect(currentStep(job([["a", "Pending"]]))).toBe("");
  });
});

describe("wrapText", () => {
  it("breaks on words and keeps the newlines it was given", () => {
    expect(wrapText("the quick brown fox", 9)).toEqual([
      "the quick",
      "brown fox",
    ]);
    expect(wrapText("one\ntwo", 20)).toEqual(["one", "two"]);
  });

  it("splits a word wider than the column instead of overflowing", () => {
    // A URL or a stack frame must not push the transcript off the screen.
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("hi abcdefghij", 4)).toEqual(["hi", "abcd", "efgh", "ij"]);
  });

  it("gives nothing back when there is no room", () => {
    expect(wrapText("anything", 0)).toEqual([]);
  });
});

describe("presentation helpers", () => {
  it("truncates with an ellipsis only when it has to", () => {
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 1)).toBe("a");
    expect(truncate("abcdef", 0)).toBe("");
  });

  it("reads lifecycle words the same way the plain tables do", () => {
    expect(statusColorName("active")).toBe("green");
    expect(statusColorName("Failed")).toBe("red");
    expect(statusColorName("provisioning")).toBe("yellow");
    expect(statusColorName("whatever")).toBe("gray");
  });

  it("turns a timestamp into something a person can read", () => {
    // The usage governor sends epoch millis; other endpoints send ISO.
    expect(readableDate(1786150711602)).toBe("2026-08-08 00:58");
    expect(readableDate("2026-08-18T01:50:59.725Z")).toBe("2026-08-18 01:50");
    expect(readableDate(null)).toBe("");
    expect(readableDate("")).toBe("");
    expect(readableDate("not a date")).toBe("not a date");
  });
});
