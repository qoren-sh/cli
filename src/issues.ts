import type { DesignIssue } from "@qoren/sdk";
import pc from "picocolors";

// Showing what is wrong with a design.
//
// Import, publish, deploy and test runs all answer with the same list of
// issues, either as data (a push) or inside a 422 (a publish refused). One
// renderer, so a problem reads the same whichever command found it. Issues are
// commentary on the result, so they go to stderr like every other note.

/** The issues a 422 body carries, or an empty list. */
export function issuesFromBody(body: unknown): DesignIssue[] {
  if (
    body &&
    typeof body === "object" &&
    "issues" in body &&
    Array.isArray(body.issues)
  ) {
    return (body.issues as unknown[]).filter(
      (i): i is DesignIssue =>
        !!i &&
        typeof i === "object" &&
        typeof (i as DesignIssue).message === "string",
    );
  }
  return [];
}

export function hasErrors(issues: DesignIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/** One line per issue, errors first: severity, where, message, code. */
export function formatIssue(issue: DesignIssue): string {
  const where = [issue.nodeId, issue.path].filter(Boolean).join(" ");
  const severity =
    issue.severity === "error" ? pc.red("error  ") : pc.yellow("warning");
  return `  ${severity} ${where ? `${pc.bold(where)}: ` : ""}${issue.message} ${pc.dim(`(${issue.code})`)}`;
}

export function printIssues(issues: DesignIssue[]): void {
  const sorted = [...issues].sort(
    (a, b) =>
      (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1),
  );
  for (const issue of sorted) process.stderr.write(`${formatIssue(issue)}\n`);
}

/** "2 errors, 1 warning", or "no problems". */
export function issueSummary(issues: DesignIssue[]): string {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  if (issues.length === 0) return "no problems";
  const part = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [errors ? part(errors, "error") : "", warnings ? part(warnings, "warning") : ""]
    .filter(Boolean)
    .join(", ");
}
