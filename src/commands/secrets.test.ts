import type { ClientSecret } from "@qoren/sdk";
import { describe, expect, it } from "vitest";
import { scopeLabel, secretsFor } from "./secrets.js";

const row = (name: string, customerId: string | null, customerName: string | null = null): ClientSecret => ({
  name,
  description: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  kind: null,
  fileName: null,
  customerId,
  customerName,
});

describe("secrets list scoping", () => {
  const rows = [
    row("HUBSPOT_API_KEY", null),
    row("HUBSPOT_API_KEY", "cust-a", "Acme"),
    row("HUBSPOT_API_KEY", "cust-b", "Bravo"),
    row("SLACK_TOKEN", null),
    row("STRIPE_KEY", "cust-b", "Bravo"),
  ];

  it("shows every scope by default", () => {
    expect(secretsFor(rows, undefined)).toHaveLength(5);
  });

  it("shows a client its own secrets plus the agency-wide ones it falls back to", () => {
    expect(secretsFor(rows, "cust-a").map((r) => `${r.name}:${scopeLabel(r)}`)).toEqual([
      "HUBSPOT_API_KEY:Acme",
      "SLACK_TOKEN:all clients",
    ]);
  });

  it("never shows one client another client's secret", () => {
    expect(secretsFor(rows, "cust-a").some((r) => r.customerId === "cust-b")).toBe(false);
  });

  it("narrows to agency-wide with --agency", () => {
    expect(secretsFor(rows, null).map((r) => r.name)).toEqual(["HUBSPOT_API_KEY", "SLACK_TOKEN"]);
  });
});
