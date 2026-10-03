import { describe, expect, it } from "vitest";
import { HOSTED_RUNTIMES, RUNTIMES, isCustomAgent, isHostedRuntime } from "./runtimes.js";

describe("runtimes", () => {
  it("lists custom for filtering but never offers it for a deploy", () => {
    expect(RUNTIMES).toContain("custom");
    expect(HOSTED_RUNTIMES).toEqual(["hermes", "openclaw", "codex"]);
    expect(isHostedRuntime("custom")).toBe(false);
    expect(isHostedRuntime("nope")).toBe(false);
  });

  it("recognises a Custom agent by runtime or by its missing environment", () => {
    expect(isCustomAgent({ runtime: "custom", machineId: null })).toBe(true);
    expect(isCustomAgent({ runtime: null, machineId: null })).toBe(true);
    expect(isCustomAgent({ runtime: "hermes", machineId: "m1" })).toBe(false);
  });
});
