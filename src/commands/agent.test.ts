import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import {
  MAX_SPEND_CAP,
  approvalModeLine,
  capsAlreadyReached,
  mergeSpendCaps,
  parseOnOff,
  parseSpendCap,
  spendKeyLine,
} from "./agent.js";

describe("parseOnOff", () => {
  it("reads on and off and their usual spellings", () => {
    for (const v of ["on", "ON", " true ", "yes", "enable", "1"]) {
      expect(parseOnOff(v)).toBe(true);
    }
    for (const v of ["off", "Off", "false", "no", "disable", "0"]) {
      expect(parseOnOff(v)).toBe(false);
    }
  });

  it("refuses anything else instead of guessing", () => {
    expect(parseOnOff("maybe")).toBeNull();
    expect(parseOnOff("")).toBeNull();
  });
});

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("approvalModeLine", () => {
  it("says what the setting means, not just its value", () => {
    expect(plain(approvalModeLine("Atlas", true))).toBe(
      "Approval mode is on: Atlas proposes changes for you to approve instead of making them.",
    );
    expect(plain(approvalModeLine(null, false))).toBe(
      "Approval mode is off: the agent acts on its own.",
    );
  });
});

describe("parseSpendCap", () => {
  it("reads whole credits, with or without separators", () => {
    expect(parseSpendCap("500")).toBe(500);
    expect(parseSpendCap("10,000")).toBe(10000);
    expect(parseSpendCap("1_000_000")).toBe(1000000);
    expect(parseSpendCap(String(MAX_SPEND_CAP))).toBe(MAX_SPEND_CAP);
  });

  it("reads off and none as removing the cap", () => {
    expect(parseSpendCap("off")).toBe("off");
    expect(parseSpendCap(" None ")).toBe("off");
  });

  it("refuses fractions, negatives, zero and values past the ceiling", () => {
    for (const v of ["0", "-5", "2.5", "1e3", "lots", "", String(MAX_SPEND_CAP + 1)]) {
      expect(() => parseSpendCap(v)).toThrow(InvalidArgumentError);
    }
  });
});

describe("mergeSpendCaps", () => {
  const current = { dailyCredits: 500, weeklyCredits: null, monthlyCredits: 10000 };

  it("returns null when no flag was given, so the command only reads", () => {
    expect(mergeSpendCaps(current, {})).toBeNull();
  });

  it("changes only the flags given and carries the rest over", () => {
    expect(mergeSpendCaps(current, { weekly: 2000 })).toEqual({
      dailyCredits: 500,
      weeklyCredits: 2000,
      monthlyCredits: 10000,
    });
    expect(mergeSpendCaps(current, { daily: "off", monthly: 20000 })).toEqual({
      dailyCredits: null,
      weeklyCredits: null,
      monthlyCredits: 20000,
    });
  });
});

describe("spend limit summaries", () => {
  const limits = {
    dailyCredits: 100,
    weeklyCredits: 1000,
    monthlyCredits: null,
    spent: { dailyCredits: 120, weeklyCredits: 400, monthlyCredits: 900 },
    key: "agent" as const,
    enforced: true,
    canEdit: true,
  };

  it("names the windows whose cap is already reached", () => {
    expect(capsAlreadyReached(limits)).toEqual(["daily"]);
    expect(capsAlreadyReached({ ...limits, spent: null })).toEqual([]);
  });

  it("says when the caps do not apply", () => {
    expect(spendKeyLine({ ...limits, key: "own", enforced: false })).toMatch(
      /your own model key/,
    );
    expect(spendKeyLine({ ...limits, key: "pending", enforced: false })).toMatch(
      /apply once it lands/,
    );
  });
});
