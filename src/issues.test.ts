import { describe, expect, it } from "vitest";
import { formatIssue, hasErrors, issueSummary, issuesFromBody } from "./issues.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("issues", () => {
  const error = { severity: "error" as const, code: "model_not_allowed", message: "Not here.", path: "model" };
  const warning = { severity: "warning" as const, code: "unreachable_reply", message: "Unreachable.", nodeId: "reply" };

  it("counts errors and warnings in words", () => {
    expect(issueSummary([])).toBe("no problems");
    expect(issueSummary([error])).toBe("1 error");
    expect(issueSummary([error, warning, warning])).toBe("1 error, 2 warnings");
    expect(hasErrors([warning])).toBe(false);
    expect(hasErrors([warning, error])).toBe(true);
  });

  it("says where the problem is, then what it is", () => {
    expect(plain(formatIssue(warning))).toBe("  warning reply: Unreachable. (unreachable_reply)");
    expect(plain(formatIssue({ ...error, path: null }))).toBe("  error   Not here. (model_not_allowed)");
  });

  it("reads the issues off a refusal body and ignores anything else", () => {
    expect(issuesFromBody({ code: "validation_failed", issues: [error, 3, null] })).toEqual([error]);
    expect(issuesFromBody({ error: "x" })).toEqual([]);
    expect(issuesFromBody(null)).toEqual([]);
  });
});
