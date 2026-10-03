import type { ApprovalRequest } from "@qoren/sdk";
import { describe, expect, it } from "vitest";
import { statusTone } from "../output.js";
import { multiLine, wantsTo } from "./approvals.js";

const request = (over: Partial<ApprovalRequest>): ApprovalRequest => ({
  id: "ap1",
  agentId: "a1",
  agentName: "Ops",
  turnId: "t1",
  actionType: "designer.machine",
  displayCommand: "shell: ls -la",
  rationale: null,
  risk: "medium",
  status: "pending",
  source: "chat",
  sourceLabel: null,
  createdAt: "2026-09-30T00:00:00Z",
  decidedAt: null,
  expiresAt: "2026-10-01T00:00:00Z",
  decisionNote: null,
  ...over,
});

describe("approvals output", () => {
  it("names a file approval's change and a short content hash", () => {
    const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(
      wantsTo(request({ fileOp: { op: "delete", path: "out/report.md", contentSha256: hash } })),
    ).toBe("delete out/report.md (sha256 e3b0c44298fc)");
  });

  it("flattens a multi-line command for the table and lists it for the full print", () => {
    const script = "shell: cd /srv\n  make build\n";
    const rows = [request({ displayCommand: script }), request({ id: "ap2" })];
    expect(wantsTo(rows[0]!)).toBe("shell: cd /srv make build");
    expect(multiLine(rows).map((a) => a.id)).toEqual(["ap1"]);
  });

  it("keeps a long single-line command whole", () => {
    const long = `shell: ${"x".repeat(3990)}`;
    expect(wantsTo(request({ displayCommand: long }))).toBe(long);
  });

  it("shows an executed approval as done", () => {
    expect(statusTone("executed")).toBe("good");
  });
});
