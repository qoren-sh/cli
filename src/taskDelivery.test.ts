import { describe, expect, it } from "vitest";
import { CHAT_TARGET_RE, describeDelivery, resolveDelivery } from "./taskDelivery.js";

// The chat target grammar is shared with the control plane; these pin the
// forms it accepts and the ones the CLI refuses before a request is made.
describe("CHAT_TARGET_RE", () => {
  it("accepts every documented form", () => {
    for (const target of [
      "telegram",
      "telegram:-1001234567890",
      "telegram:-1001234567890:42",
      "slack:C0123ABC",
      "discord:123456789012345678",
      "matrix:@ops:1",
    ])
      expect(CHAT_TARGET_RE.test(target)).toBe(true);
  });

  it("refuses what the control plane would", () => {
    for (const target of ["", "Telegram", "telegram:", "telegram:a b", "1telegram", "telegram:1:2:3", "slack:C0123#x"])
      expect(CHAT_TARGET_RE.test(target)).toBe(false);
  });
});

describe("resolveDelivery", () => {
  it("leaves a create to the server default when no flag is given", () => {
    expect(resolveDelivery({})).toEqual({});
  });

  it("turns --deliver-to into the chat policy", () => {
    expect(resolveDelivery({ deliverTo: "telegram:-100123:7" })).toEqual({
      deliveryPolicy: "chat",
      deliveryTarget: "telegram:-100123:7",
    });
    expect(resolveDelivery({ delivery: "chat", deliverTo: "slack:C1" })).toEqual({
      deliveryPolicy: "chat",
      deliveryTarget: "slack:C1",
    });
  });

  it("refuses a malformed target or a conflicting policy", () => {
    expect(() => resolveDelivery({ deliverTo: "Telegram:123" })).toThrow(/not a chat target/);
    expect(() => resolveDelivery({ delivery: "all-channels", deliverTo: "slack:C1" })).toThrow(/cannot be combined/);
    expect(() => resolveDelivery({ delivery: "everywhere" })).toThrow(/must be one of/);
    expect(() => resolveDelivery({ delivery: "chat" })).toThrow(/needs --deliver-to/);
  });

  it("clears the target when switching to another policy", () => {
    expect(
      resolveDelivery({ delivery: "activity-only" }, { deliveryPolicy: "chat", deliveryTarget: "slack:C1" }),
    ).toEqual({ deliveryPolicy: "activity-only", deliveryTarget: null });
  });

  it("keeps an existing chat target on a replace", () => {
    const existing = { deliveryPolicy: "chat" as const, deliveryTarget: "telegram:-100123" };
    expect(resolveDelivery({}, existing)).toEqual(existing);
    expect(resolveDelivery({ delivery: "chat" }, existing)).toEqual(existing);
  });
});

describe("describeDelivery", () => {
  it("names the chat for a chat task", () => {
    expect(describeDelivery({ deliveryPolicy: "chat", deliveryTarget: "telegram:-100123" })).toBe(
      "chat telegram:-100123",
    );
    expect(describeDelivery({ deliveryPolicy: "activity-only", deliveryTarget: null })).toBe("activity-only");
  });
});
