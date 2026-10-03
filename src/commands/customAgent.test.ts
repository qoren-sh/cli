import { describe, expect, it } from "vitest";
import { channelInput, isTerminalRun, runDuration } from "./customAgent.js";

describe("isTerminalRun", () => {
  it("knows which states a run never leaves", () => {
    for (const s of ["succeeded", "failed", "canceled", "expired", "budget_exceeded"]) {
      expect(isTerminalRun(s)).toBe(true);
    }
    for (const s of ["queued", "running", "waiting", "parked_credits"]) {
      expect(isTerminalRun(s)).toBe(false);
    }
  });
});

describe("runDuration", () => {
  it("measures a finished run, and a running one up to now", () => {
    expect(runDuration({ startedAt: 1000, endedAt: 1500 })).toBe("500ms");
    expect(runDuration({ startedAt: 0, endedAt: 75_000 })).toBe("1m 15s");
    expect(runDuration({ startedAt: 0, endedAt: null }, 9_000)).toBe("9s");
  });
});

describe("channelInput", () => {
  it("requires a Discord server id and sends it as the guild", () => {
    expect(() => channelInput("discord", { botToken: "tok" })).toThrow(/--guild/);
    expect(() => channelInput("discord", { botToken: "tok", guild: "  " })).toThrow(/Copy Server ID/);
    expect(channelInput("discord", { botToken: "tok", guild: "123456789012345678", allMessages: true })).toEqual({
      kind: "discord",
      credentials: { botToken: "tok", guildId: "123456789012345678" },
      mentionsOnly: false,
    });
  });

  it("requires Slack's signing secret and keeps other kinds' options out", () => {
    expect(() => channelInput("slack", { botToken: "xoxb" })).toThrow(/signing secret/);
    expect(channelInput("slack", { botToken: "xoxb", signingSecret: "s", guild: "1", botName: "Q" })).toEqual({
      kind: "slack",
      credentials: { botToken: "xoxb", signingSecret: "s" },
      botName: "Q",
    });
    expect(channelInput("telegram", { botToken: "1:a", guild: "1", allMessages: true })).toEqual({
      kind: "telegram",
      credentials: { botToken: "1:a" },
    });
  });

  it("refuses an unknown kind and a missing token", () => {
    expect(() => channelInput("irc", { botToken: "t" })).toThrow(/Unknown channel/);
    expect(() => channelInput("telegram", {})).toThrow(/--bot-token/);
  });
});
