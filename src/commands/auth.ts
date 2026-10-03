import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { Qoren, QorenError } from "@qoren/sdk";
import {
  listProfiles,
  profileName,
  removeProfile,
  resolveBaseUrl,
  resolveProfile,
  saveProfile,
} from "../config.js";
import {
  isApiAccessRequired,
  requireContext,
  run,
  VERSION,
  type GlobalOptions,
} from "../context.js";
import { awaitLoopbackCode, createPkcePair, openBrowser } from "../loopback.js";
import { bold, details, dim, emit, note, warn } from "../output.js";

// login / logout / whoami.

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

type TokenResponse = {
  token: string;
  token_name: string;
  user: { id: string; email: string | null; name: string | null };
};

/** Read a secret from the terminal without echoing it. */
async function promptToken(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // Node's readline has no built-in masking, so suppress the echo by writing
    // nothing for each keypress. Falls back to a normal prompt when stdin is
    // not a TTY (a piped token), where there is no echo to worry about.
    if (process.stdin.isTTY) {
      const output = rl as unknown as { output?: { write: (s: string) => void } };
      const write = output.output?.write.bind(output.output);
      if (write) {
        output.output!.write = (chunk: string) => {
          if (!chunk.includes("\n")) return;
          write(chunk);
        };
      }
    }
    const answer = await rl.question("Paste your token: ");
    process.stderr.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function loginWithBrowser(
  baseUrl: string,
  tokenName: string,
): Promise<TokenResponse> {
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString("base64url");

  const { code } = await awaitLoopbackCode({
    state,
    timeoutMs: LOGIN_TIMEOUT_MS,
    onReady: (redirectUri) => {
      const authorize = new URL("/cli/authorize", baseUrl);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("token_name", tokenName);
      const url = authorize.toString();

      note(`Opening ${bold(baseUrl)} to authorize this computer.`);
      note(dim(`If your browser did not open, visit:\n  ${url}`));
      openBrowser(url);
    },
  });

  const response = await fetch(new URL("/api/cli/token", baseUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier }),
  });
  const body = (await response.json().catch(() => null)) as
    | (TokenResponse & { error?: string })
    | null;
  if (!response.ok || !body?.token) {
    throw new Error(
      body?.error ?? `Could not complete sign-in (${response.status}).`,
    );
  }
  return body;
}

export function authCommands(program: Command, global: () => GlobalOptions) {
  program
    .command("login")
    .description("Sign this computer in to Qoren")
    .option(
      "--token",
      "paste an existing token instead of opening a browser (for CI, prefer QOREN_TOKEN)",
    )
    .option("--name <name>", "label for the token, shown in Settings", "cli")
    .action((options: { token?: boolean; name: string }) =>
      run(async () => {
        const opts = global();
        const baseUrl = resolveBaseUrl(opts.apiUrl);
        const name = profileName(opts.profile);

        let token: string;
        let email: string | null = null;

        if (options.token) {
          token = await promptToken();
          if (!token) throw new Error("No token given.");
        } else {
          const result = await loginWithBrowser(baseUrl, options.name);
          token = result.token;
          email = result.user.email;
        }

        // Prove the credential works before storing it, so a bad paste fails
        // here rather than on the next unrelated command.
        const probe = new Qoren({
          baseUrl,
          token,
          userAgent: `qoren-cli/${VERSION}`,
        });
        let clients;
        try {
          clients = await probe.account.clients();
        } catch (err) {
          // A 401 here means two very different things depending on where the
          // token came from, and the generic "run login again" advice is only
          // right for one of them. After the browser flow the server issued
          // this token seconds ago, so a rejection is a server-side problem and
          // re-running will fail identically.
          if (err instanceof QorenError && err.status === 401) {
            throw new Error(
              options.token
                ? "That token was rejected. Check it was pasted whole, and that it has not been revoked."
                : `Sign-in completed, but ${baseUrl} then rejected the token it had just issued.\n` +
                  "Re-running this will not help: the fault is server side. If you run this deployment,\n" +
                  "its server log names the cause. A token was created either way, so revoke it under\n" +
                  "Settings, CLI tokens.",
            );
          }
          throw err;
        }

        saveProfile(name, {
          token,
          baseUrl,
          ...(email ? { email } : {}),
          ...(clients[0]?.slug ? { orgSlug: clients[0].slug } : {}),
        });

        emit({ ok: true, profile: name, baseUrl, email }, () => {
          note(
            `Signed in${email ? ` as ${bold(email)}` : ""} (profile ${bold(name)}).`,
          );
        });
      })(),
    );

  program
    .command("logout")
    .description("Forget the stored credentials")
    .option("--all", "forget every profile")
    .action((options: { all?: boolean }) =>
      run(async () => {
        await Promise.resolve();
        const names = options.all
          ? listProfiles()
          : [profileName(global().profile)];
        const removed = names.filter((name) => removeProfile(name));

        emit({ removed }, () => {
          note(
            removed.length === 0
              ? "You were not signed in."
              : `Signed out of ${removed.map(bold).join(", ")}.`,
          );
        });
      })(),
    );

  program
    .command("whoami")
    .description("Show who this computer is signed in as")
    .action(() =>
      run(async () => {
        const opts = global();
        const ctx = requireContext(opts);
        const stored = resolveProfile({
          ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
        });

        // Which credential is in play, and where it came from. This is local
        // knowledge, so it is gathered BEFORE the network call and reported
        // whatever the server says. The whole job of this command is to answer
        // "who am I acting as", and it used to throw on a rejected token, which
        // hid that answer exactly when it was worth having: an environment
        // variable silently overriding a good stored profile is invisible until
        // something names it. The prefix is shown so it can be matched against
        // the token list in Settings; it is not enough to authenticate with.
        const fromEnv = Boolean(process.env.QOREN_TOKEN);
        const data = {
          profile: ctx.profileName,
          baseUrl: ctx.profile.baseUrl,
          email: stored?.email ?? null,
          org: null as { slug: string; name: string } | null,
          // Never the token itself: `qoren whoami` gets pasted into bug reports.
          source: fromEnv ? "QOREN_TOKEN" : "config file",
          tokenPrefix: ctx.profile.token.slice(0, 12),
          accepted: true,
          // False when the token is valid but the org's plan does not include
          // API access. `accepted` is false then too: the server refused it.
          apiAccess: true,
        };
        let refusal: string | null = null;

        try {
          const org = (await ctx.qoren.account.clients())[0] ?? null;
          if (org) data.org = { slug: org.slug, name: org.name };
        } catch (err) {
          if (isApiAccessRequired(err) && err instanceof QorenError) {
            data.accepted = false;
            data.apiAccess = false;
            refusal = err.message;
          } else {
            if (!(err instanceof QorenError) || !err.isAuthError) throw err;
            data.accepted = false;
          }
        }

        emit(data, () => {
          details([
            ["Profile", data.profile],
            ["Server", data.baseUrl],
            ["Account", data.email ?? ""],
            ["Organization", data.org ? `${data.org.name} (${data.org.slug})` : ""],
            ["Credential", `${data.source} (${data.tokenPrefix}…)`],
            [
              "Status",
              data.accepted
                ? "accepted"
                : data.apiAccess
                  ? "REJECTED by the server"
                  : "REFUSED: your plan does not include API access",
            ],
          ]);
          if (refusal) warn(refusal);
          if (!data.accepted && fromEnv) {
            // Far and away the likeliest cause, and the hardest to spot: the
            // variable wins over a perfectly good stored login.
            warn(
              "QOREN_TOKEN is set and is overriding your stored login. Unset it to use the profile above.",
            );
          }
        });
      })(),
    );
}
