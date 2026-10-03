import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QorenError } from "@qoren/sdk";
import { isApiAccessRequired, run } from "./context.js";
import { EXIT_AUTH, EXIT_ERROR, EXIT_PAYMENT, setJsonMode } from "./output.js";

// The exit codes are the CLI's contract with scripts: 3 is the credential, 4 is
// the plan, 1 is the request. A plan without API access answers 403, the same
// status as a bad credential, and must still land on 4.

let stderr: string[];

beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  setJsonMode(false);
  process.exitCode = undefined;
});

const gated = () =>
  new QorenError(
    "Your Pro plan does not include API access. It is included on the Ultimate, Business and Enterprise plans.",
    403,
    { code: "api_access_required", upgradeUrl: "https://qoren.sh/pricing" },
  );

async function exitFor(err: Error): Promise<typeof process.exitCode> {
  await run(() => Promise.reject(err))();
  return process.exitCode;
}

describe("isApiAccessRequired", () => {
  it("matches only a 403 carrying the api_access_required code", () => {
    expect(isApiAccessRequired(gated())).toBe(true);
    expect(isApiAccessRequired(new QorenError("Forbidden", 403))).toBe(false);
    expect(
      isApiAccessRequired(
        new QorenError("x", 402, { code: "api_access_required" }),
      ),
    ).toBe(false);
    expect(isApiAccessRequired(new Error("api_access_required"))).toBe(false);
  });
});

describe("run: exit codes", () => {
  it("exits 4 with the server's message when the plan lacks API access", async () => {
    expect(await exitFor(gated())).toBe(EXIT_PAYMENT);
    const out = stderr.join("");
    expect(out).toContain("does not include API access");
    expect(out).not.toContain("qoren login");
  });

  it("puts the structured body on stderr in --json mode", async () => {
    setJsonMode(true);
    expect(await exitFor(gated())).toBe(EXIT_PAYMENT);
    const parsed = JSON.parse(stderr.join("")) as {
      detail: { code: string; upgradeUrl: string };
    };
    expect(parsed.detail.code).toBe("api_access_required");
    expect(parsed.detail.upgradeUrl).toBe("https://qoren.sh/pricing");
  });

  it("still exits 3 for any other 403 and for a 401", async () => {
    expect(await exitFor(new QorenError("Forbidden", 403))).toBe(EXIT_AUTH);
    expect(await exitFor(new QorenError("Unauthorized", 401))).toBe(EXIT_AUTH);
  });

  it("exits 4 for no plan at all and 1 for an ordinary failure", async () => {
    expect(await exitFor(new QorenError("No active subscription.", 402))).toBe(
      EXIT_PAYMENT,
    );
    expect(await exitFor(new QorenError("Not found", 404))).toBe(EXIT_ERROR);
  });
});
