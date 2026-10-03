import { describe, expect, it } from "vitest";
import { collectContextFrom, describeChain, resolveContextFrom } from "./taskChain.js";

describe("resolveContextFrom", () => {
  it("leaves the field out without a flag, so a replace keeps the current list", () => {
    expect(resolveContextFrom(undefined)).toBeUndefined();
  });

  it("clears the list with --no-context-from", () => {
    expect(resolveContextFrom(false)).toEqual([]);
  });

  it("passes ids, names and self through for the control plane to resolve", () => {
    const collected = ["daily-crawl", " self ", "t1"].reduce<string[] | undefined>(
      (acc, v) => collectContextFrom(v, acc),
      undefined,
    );
    expect(resolveContextFrom(collected)).toEqual(["daily-crawl", "self", "t1"]);
  });

  it("refuses more than five before a round trip", () => {
    expect(() => resolveContextFrom(["a", "b", "c", "d", "e", "f"])).toThrow(/at most 5/);
    expect(() => resolveContextFrom([" "])).toThrow(/needs a task/);
  });
});

describe("describeChain", () => {
  const tasks = [
    { id: "t1", name: "daily-crawl" },
    { id: "t2", name: "digest" },
  ];

  it("names the tasks read, self for its own previous run, the id when unknown", () => {
    expect(describeChain({ id: "t2", contextFrom: ["t1", "t2", "gone"] }, tasks)).toBe(
      "daily-crawl, self, gone",
    );
    expect(describeChain({ id: "t2" }, tasks)).toBe("");
  });
});
