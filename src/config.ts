import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Where the CLI keeps its credentials.
//
// One file, `~/.config/qoren/config.json`, holding named profiles so a person
// who works across accounts can switch with --profile rather than logging out.
// It is written 0600 and its directory 0700: it holds bearer tokens, and a
// world-readable token is the same as a published one.
//
// Environment variables win over the file, always. That is what makes CI work
// without a login step, and it means a script can never accidentally pick up a
// developer's personal profile — set QOREN_TOKEN and the file is not consulted.

export const DEFAULT_BASE_URL = "https://qoren.sh";

export type Profile = {
  token: string;
  baseUrl: string;
  /** Cached from `GET /clients` so environment commands don't re-resolve the
   * org's fleet tenant on every invocation. Refreshed on a miss. */
  orgSlug?: string;
  email?: string;
};

type ConfigFile = {
  /** Profile used when --profile is not given. */
  current?: string;
  profiles?: Record<string, Profile>;
};

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(xdg, "qoren") : join(homedir(), ".config", "qoren");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

function readFile(): ConfigFile {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as ConfigFile;
  } catch {
    // Missing, unreadable or corrupt all mean the same thing to a CLI: there is
    // no stored login. Refusing to run would only strand someone whose file got
    // truncated, when `qoren login` fixes it.
    return {};
  }
}

function writeFileAtomically(config: ConfigFile): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when it CREATES the file, so an existing
  // file keeps whatever permissions it had. Set them every time.
  chmodSync(path, 0o600);
}

/** The name of the profile a command should use. */
export function profileName(explicit?: string): string {
  return explicit ?? process.env.QOREN_PROFILE?.trim() ?? readFile().current ?? "default";
}

/**
 * The credentials to run with, or null when there are none.
 *
 * Resolution order, highest first:
 *   1. QOREN_TOKEN / QOREN_API_URL   (CI, and any deliberate override)
 *   2. --api-url                     (a flag beats stored config)
 *   3. the named profile
 */
export function resolveProfile(options: {
  profile?: string;
  baseUrl?: string;
}): Profile | null {
  const envToken = process.env.QOREN_TOKEN?.trim();
  const envUrl = process.env.QOREN_API_URL?.trim();
  if (envToken) {
    return {
      token: envToken,
      baseUrl: options.baseUrl ?? envUrl ?? DEFAULT_BASE_URL,
    };
  }

  const stored = readFile().profiles?.[profileName(options.profile)];
  if (!stored) return null;
  return {
    ...stored,
    baseUrl: options.baseUrl ?? envUrl ?? stored.baseUrl ?? DEFAULT_BASE_URL,
  };
}

/** The base URL to talk to even when there is no stored login (so `qoren login`
 * knows where to send the browser). */
export function resolveBaseUrl(explicit?: string): string {
  return (
    explicit ??
    process.env.QOREN_API_URL?.trim() ??
    resolveProfile({})?.baseUrl ??
    DEFAULT_BASE_URL
  );
}

/** Store a profile and make it current. */
export function saveProfile(name: string, profile: Profile): void {
  const config = readFile();
  writeFileAtomically({
    ...config,
    current: name,
    profiles: { ...config.profiles, [name]: profile },
  });
}

/** Update fields on an existing profile, e.g. caching the resolved org slug.
 * A no-op when the profile isn't stored (an env-token session has no file). */
export function patchProfile(name: string, patch: Partial<Profile>): void {
  const config = readFile();
  const existing = config.profiles?.[name];
  if (!existing) return;
  writeFileAtomically({
    ...config,
    profiles: { ...config.profiles, [name]: { ...existing, ...patch } },
  });
}

/** Forget a profile. Returns false when there was nothing to forget. */
export function removeProfile(name: string): boolean {
  const config = readFile();
  if (!config.profiles?.[name]) return false;
  const profiles = { ...config.profiles };
  delete profiles[name];
  writeFileAtomically({
    ...config,
    profiles,
    ...(config.current === name ? { current: undefined } : {}),
  });
  return true;
}

/** Every stored profile name, for `qoren logout --all` and diagnostics. */
export function listProfiles(): string[] {
  return Object.keys(readFile().profiles ?? {});
}
