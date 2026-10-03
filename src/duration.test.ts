import { describe, expect, it } from "vitest";
import { parseDuration } from "./duration.js";

// A public link's expiry is the only thing standing between "here is the report"
// and a URL that works forever, so a misread duration is a security bug rather
// than a typo. These pin the shapes accepted and, more importantly, the ones
// refused outright instead of guessed at.
describe("parseDuration", () => {
  it("reads every unit the flag documents", () => {
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("30m")).toBe(1_800);
    expect(parseDuration("2h")).toBe(7_200);
    expect(parseDuration("3d")).toBe(259_200);
  });

  it("tolerates the case and spacing someone actually types", () => {
    expect(parseDuration("2H")).toBe(7_200);
    expect(parseDuration(" 7d ")).toBe(604_800);
  });

  it("refuses a bare number rather than picking a unit for it", () => {
    // "7" is a week to whoever wrote it and seven seconds to a parser that
    // defaults to seconds. Neither guess is safe, so it is an error.
    expect(parseDuration("7")).toBeNull();
  });

  it("refuses anything that is not a positive amount and a unit", () => {
    for (const bad of ["", "0d", "-1h", "1w", "abc", "1.5h", "1h30m"]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });
});
