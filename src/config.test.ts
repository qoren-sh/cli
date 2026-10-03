import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configPath,
  DEFAULT_BASE_URL,
  listProfiles,
  patchProfile,
  profileName,
  removeProfile,
  resolveBaseUrl,
  resolveProfile,
  saveProfile,
} from "./config.js";

// The config store holds bearer tokens, so these tests care about two things:
// that the precedence rules are what a CI job depends on, and that the file is
// not readable by anyone else.

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qoren-cli-test-"));
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.QOREN_TOKEN;
  delete process.env.QOREN_API_URL;
  delete process.env.QOREN_PROFILE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("config store", () => {
  it("round-trips a profile", () => {
    saveProfile("default", { token: "qrn_a", baseUrl: "https://qoren.sh" });
    expect(resolveProfile({})).toMatchObject({
      token: "qrn_a",
      baseUrl: "https://qoren.sh",
    });
  });

  it("writes the credentials file 0600", () => {
    saveProfile("default", { token: "qrn_a", baseUrl: "https://qoren.sh" });
    // A token in a world-readable file is a published token.
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("keeps the file 0600 when overwriting an existing one", () => {
    saveProfile("default", { token: "qrn_a", baseUrl: "https://qoren.sh" });
    saveProfile("default", { token: "qrn_b", baseUrl: "https://qoren.sh" });
    // writeFileSync's mode only applies on create, so this is the case that
    // would silently leave a loose permission behind.
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  it("returns null when nothing is stored rather than inventing a profile", () => {
    expect(resolveProfile({})).toBeNull();
  });

  it("survives a corrupt config file", () => {
    saveProfile("default", { token: "qrn_a", baseUrl: "https://qoren.sh" });
    // Truncated JSON should read as "not signed in", not crash every command.
    writeFileSync(configPath(), "{ not json");
    expect(resolveProfile({})).toBeNull();
  });

  it("lets QOREN_TOKEN win over the stored profile", () => {
    saveProfile("default", { token: "qrn_stored", baseUrl: "https://qoren.sh" });
    process.env.QOREN_TOKEN = "qrn_from_ci";
    // This is what makes CI deterministic: a checked-out developer profile can
    // never leak into a pipeline run.
    expect(resolveProfile({})?.token).toBe("qrn_from_ci");
  });

  it("lets --api-url win over both the env and the stored profile", () => {
    saveProfile("default", { token: "qrn_a", baseUrl: "https://stored.example" });
    process.env.QOREN_API_URL = "https://env.example";
    expect(resolveProfile({ baseUrl: "https://flag.example" })?.baseUrl).toBe(
      "https://flag.example",
    );
    expect(resolveProfile({})?.baseUrl).toBe("https://env.example");
  });

  it("falls back to production when nothing says otherwise", () => {
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
    process.env.QOREN_TOKEN = "qrn_x";
    expect(resolveProfile({})?.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("tracks the current profile and switches with --profile", () => {
    saveProfile("work", { token: "qrn_work", baseUrl: "https://qoren.sh" });
    saveProfile("personal", { token: "qrn_home", baseUrl: "https://qoren.sh" });

    // The last login becomes current.
    expect(profileName()).toBe("personal");
    expect(resolveProfile({})?.token).toBe("qrn_home");
    expect(resolveProfile({ profile: "work" })?.token).toBe("qrn_work");
    expect(listProfiles().sort()).toEqual(["personal", "work"]);
  });

  it("caches the org slug onto an existing profile", () => {
    saveProfile("default", { token: "qrn_a", baseUrl: "https://qoren.sh" });
    patchProfile("default", { orgSlug: "acme" });
    expect(resolveProfile({})?.orgSlug).toBe("acme");
  });

  it("ignores a patch for a profile that isn't stored", () => {
    // An env-token session has no file to patch; this must not create one.
    expect(() => patchProfile("nope", { orgSlug: "acme" })).not.toThrow();
    expect(listProfiles()).toEqual([]);
  });

  it("removes a profile and reports whether there was one", () => {
    saveProfile("default", { token: "qrn_a", baseUrl: "https://qoren.sh" });
    expect(removeProfile("default")).toBe(true);
    expect(removeProfile("default")).toBe(false);
    expect(resolveProfile({})).toBeNull();
  });
});
