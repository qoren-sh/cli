import { Qoren, QorenError } from "@qoren/sdk";
import {
  patchProfile,
  profileName,
  resolveProfile,
  type Profile,
} from "./config.js";
import {
  EXIT_AUTH,
  EXIT_ERROR,
  EXIT_PAYMENT,
  fail,
  isJsonMode,
} from "./output.js";
import { issuesFromBody, printIssues } from "./issues.js";

// What every command needs: an authenticated client, and one place that turns a
// control-plane failure into an exit code and a sentence worth reading.

export const VERSION = "0.1.0";

export type GlobalOptions = {
  json?: boolean;
  profile?: string;
  apiUrl?: string;
  color?: boolean;
};

export type Context = {
  qoren: Qoren;
  profile: Profile;
  profileName: string;
};

class AuthRequired extends Error {}

/**
 * The org's plan does not include API access (a 403 with `code:
 * "api_access_required"`). The token is fine, so this is a plan problem (exit
 * 4), not a credential one (exit 3): logging in again would fail identically.
 *
 * Read off the code rather than the SDK's `isApiAccessRequired`, so a CLI
 * built against an older SDK still tells the two apart.
 */
export function isApiAccessRequired(err: unknown): boolean {
  return (
    err instanceof QorenError &&
    err.status === 403 &&
    err.code === API_ACCESS_REQUIRED
  );
}

const API_ACCESS_REQUIRED = "api_access_required";

/**
 * The caller's organization is being deleted (a 403 with `code:
 * "org_deleting"`). Logging in again cannot help, so the server's message,
 * which says what is happening, is shown instead of "credentials rejected".
 */
export function isOrgDeleting(err: unknown): boolean {
  return err instanceof QorenError && err.status === 403 && err.code === "org_deleting";
}
const PRICING_URL = "https://qoren.sh/pricing";

/** Build the client for this invocation, or explain how to get one. */
export function requireContext(options: GlobalOptions): Context {
  const name = profileName(options.profile);
  const profile = resolveProfile({
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.apiUrl !== undefined ? { baseUrl: options.apiUrl } : {}),
  });
  if (!profile) {
    throw new AuthRequired(
      "You are not signed in. Run `qoren login`, or set QOREN_TOKEN.",
    );
  }
  return {
    qoren: new Qoren({
      baseUrl: profile.baseUrl,
      token: profile.token,
      userAgent: `qoren-cli/${VERSION}`,
    }),
    profile,
    profileName: name,
  };
}

/**
 * The org's fleet tenant slug, which creating an environment needs.
 *
 * Cached in the profile after the first lookup: it never changes for an
 * account, and paying a round trip for it on every `env create` would be a
 * waste. An explicit --org always wins.
 */
export async function orgSlug(
  ctx: Context,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  if (ctx.profile.orgSlug) return ctx.profile.orgSlug;
  const slug = await ctx.qoren.resolveOrgSlug();
  patchProfile(ctx.profileName, { orgSlug: slug });
  return slug;
}

/**
 * Run a command body and turn whatever it throws into an exit code.
 *
 * The distinctions that matter to someone scripting this: 3 means the
 * credential is the problem (log in again), 4 means the plan is (upgrade), 1
 * means the request itself failed. Anything else would make a CI job unable to
 * tell "my token expired" from "that environment doesn't exist".
 */
export function run(
  body: () => Promise<void>,
): (...args: never[]) => Promise<void> {
  return async () => {
    try {
      await body();
    } catch (err) {
      process.exitCode = report(err);
    }
  };
}

function report(err: unknown): number {
  if (err instanceof AuthRequired) {
    fail(err.message);
    return EXIT_AUTH;
  }

  if (err instanceof QorenError) {
    // Checked before isAuthError: it is a 403, but signing in again is not the
    // fix. The server's message names the plans that include API access.
    // (A boolean, not a type guard: a guard would narrow QorenError out of
    // every branch below.)
    if (isApiAccessRequired(err)) {
      fail(
        err.message ||
          `Your plan does not include API access. Upgrade at ${PRICING_URL}.`,
        isJsonMode() ? err.body : undefined,
      );
      return EXIT_PAYMENT;
    }
    // Agent Designer refusals. They are 403s, but the credential is fine: the
    // plan has no Custom agents (or no more of them), or only the owner may
    // make this change. Sending someone to sign in again would be wrong.
    const designer = designerRefusal(err);
    if (designer !== null) {
      fail(err.message, isJsonMode() ? err.body : undefined);
      return designer;
    }
    if (err.isAuthError) {
      fail(
        err.status === 401
          ? "Your credentials were rejected. Run `qoren login` again, or check QOREN_TOKEN."
          : err.message,
      );
      return EXIT_AUTH;
    }
    if (err.isPaymentRequired) {
      fail(
        "This action needs an active plan. Open Qoren in a browser to choose one.",
      );
      return EXIT_PAYMENT;
    }
    // A 422 from a create carries the safety review's findings. They are the
    // whole reason the call was refused, so print them rather than the summary
    // line alone.
    const findings = safetyFindings(err.body);
    fail(err.message, isJsonMode() ? err.body : undefined);
    // A design refused for its problems (422 validation_failed) lists them.
    const issues = issuesFromBody(err.body);
    if (!isJsonMode() && issues.length > 0) printIssues(issues);
    if (!isJsonMode() && findings.length > 0) {
      for (const finding of findings) {
        process.stderr.write(
          `  ${finding.severity}: ${finding.title}\n    ${finding.suggestion}\n`,
        );
      }
    }
    return EXIT_ERROR;
  }

  fail(err instanceof Error ? err.message : String(err));
  return EXIT_ERROR;
}

/** The exit code for an Agent Designer refusal, or null when this is not one.
 * A plan limit is a plan problem (4); owner-only is a plain failure (1). */
export function designerRefusal(err: QorenError): number | null {
  if (err.status !== 403) return null;
  switch (err.code) {
    case "designer_disabled":
    case "custom_agent_limit":
      return EXIT_PAYMENT;
    case "designer_owner_only":
      return EXIT_ERROR;
    default:
      return null;
  }
}

type Finding = { severity: string; title: string; suggestion: string };

function safetyFindings(body: unknown): Finding[] {
  if (
    body &&
    typeof body === "object" &&
    "safetyFindings" in body &&
    Array.isArray(body.safetyFindings)
  ) {
    return body.safetyFindings as Finding[];
  }
  return [];
}
