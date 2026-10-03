import { QorenError, type AgencyClient, type ClientCosts } from "@qoren/sdk";
import { describe, expect, it } from "vitest";
import {
  CLIENTS_DISABLED,
  clientsGateError,
  categoryRows,
  costRows,
  formatDollars,
  matchClient,
  parseCostWindow,
} from "./clients.js";

const client = (over: Partial<AgencyClient>): AgencyClient => ({
  id: "c1",
  name: "Acme",
  contactEmail: null,
  notes: null,
  archivedAt: null,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  environmentCount: 0,
  agentCount: 0,
  ...over,
});

describe("matchClient", () => {
  const acme = client({ id: "c1", name: "Acme" });
  const oldAcme = client({
    id: "c2",
    name: "Acme",
    archivedAt: "2026-08-01T00:00:00Z",
  });
  const gone = client({
    id: "c3",
    name: "Gone",
    archivedAt: "2026-08-01T00:00:00Z",
  });

  it("prefers an id, then the active client of that name", () => {
    expect(matchClient([acme, oldAcme], "c2")).toBe(oldAcme);
    expect(matchClient([acme, oldAcme], "Acme")).toBe(acme);
  });

  it("finds an archived client by name when it is the only one", () => {
    expect(matchClient([acme, gone], "Gone")).toBe(gone);
  });

  it("refuses to guess between archived namesakes, and says so when nothing matches", () => {
    const twin = { ...gone, id: "c4" };
    expect(() => matchClient([gone, twin], "Gone")).toThrow(/more than one/i);
    expect(() => matchClient([acme], "acme")).toThrow(/qoren clients list/);
  });
});

describe("parseCostWindow", () => {
  const now = Date.UTC(2026, 8, 26, 12);
  const day = 86_400_000;

  it("defaults to the last 30 days", () => {
    expect(parseCostWindow(undefined, undefined, now)).toEqual({
      from: now - 30 * day,
      to: now,
    });
  });

  it("reads a bare --to date as the whole of that day", () => {
    expect(parseCostWindow("2026-09-01", "2026-09-30", now)).toEqual({
      from: Date.UTC(2026, 8, 1),
      to: Date.UTC(2026, 9, 1),
    });
  });

  it("keeps a full timestamp exact", () => {
    expect(
      parseCostWindow(undefined, "2026-09-10T06:00:00Z", now).to,
    ).toBe(Date.UTC(2026, 8, 10, 6));
  });

  it("rejects nonsense and a window that runs backwards", () => {
    expect(() => parseCostWindow("last week", undefined, now)).toThrow(
      /--from must be an ISO date/,
    );
    expect(() => parseCostWindow("2026-09-20", "2026-09-10", now)).toThrow(
      /before/,
    );
  });
});

describe("costRows", () => {
  const byKind = { environment: 0, llm: 0, webSearch: 0, runs: 0, tools: 0 };
  const costs: ClientCosts = {
    from: 0,
    to: 1,
    trackingSince: 0,
    totalCredits: 4500,
    pendingSettlements: 0,
    customers: [
      { customerId: "c1", name: "Small", credits: 500, byKind, environments: [], agents: [] },
      { customerId: null, name: null, credits: 1000, byKind, environments: [], agents: [] },
      { customerId: "c2", name: "Big", credits: 2500, byKind, environments: [], agents: [] },
    ],
    account: { credits: 500, byKind },
    beforeTracking: { credits: 0, byKind, estimated: false },
  };

  it("lists clients by spend, then no client, account and the total", () => {
    expect(costRows(costs)).toEqual([
      { label: "Big", credits: 2500 },
      { label: "Small", credits: 500 },
      { label: "No client", credits: 1000 },
      { label: "Account", credits: 500 },
      { label: "Total", credits: 4500, total: true },
    ]);
  });

  it("adds spend from before tracking just above the total", () => {
    const rows = costRows({
      ...costs,
      totalCredits: 4800,
      beforeTracking: { credits: 300, byKind, estimated: true },
    });
    expect(rows.slice(-2)).toEqual([
      { label: "Before client tracking", credits: 300 },
      { label: "Total", credits: 4800, total: true },
    ]);
  });

  it("sums every line by category, Custom agent runs and tools included", () => {
    expect(
      categoryRows({
        ...costs,
        customers: [
          {
            customerId: "c1",
            name: "Small",
            credits: 530,
            byKind: { ...byKind, environment: 500, runs: 20, tools: 10 },
            environments: [],
            agents: [],
          },
        ],
        account: { credits: 40, byKind: { ...byKind, llm: 40 } },
        beforeTracking: { credits: 60, byKind: { ...byKind, environment: 60 }, estimated: false },
      }),
    ).toEqual([
      { label: "Hosting", credits: 560 },
      { label: "Models", credits: 40 },
      { label: "Custom agent runs", credits: 20 },
      { label: "Custom agent tools", credits: 10 },
    ]);
  });

  it("prices a thousand credits at a dollar", () => {
    expect(formatDollars(4500)).toBe("$4.50");
  });
});

describe("clientsGateError", () => {
  it("turns the feature refusal into a plain failure, not a sign-in prompt", () => {
    const mapped = clientsGateError(new QorenError(CLIENTS_DISABLED, 403));
    expect(mapped).not.toBeInstanceOf(QorenError);
    expect((mapped as Error).message).toBe(CLIENTS_DISABLED);
  });

  it("reads the refusal by its code too", () => {
    const mapped = clientsGateError(
      new QorenError("Nope.", 403, { error: "Nope.", code: "agency_clients_disabled" }),
    );
    expect(mapped).not.toBeInstanceOf(QorenError);
  });

  it("leaves every other error alone", () => {
    const other = new QorenError("Forbidden.", 403);
    expect(clientsGateError(other)).toBe(other);
  });
});
