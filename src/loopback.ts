import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

// The browser half of `qoren login`.
//
// The CLI binds an ephemeral loopback port, opens the dashboard's consent page
// pointing back at it, and waits for the redirect that carries the one-time
// code. This is the standard flow for a CLI that must not ask for a password,
// and it is deliberately loopback-only: the dashboard refuses any other target.
//
// PKCE covers the one thing loopback cannot. Any process on this machine could
// in principle bind the port first, so possession of the code is not treated as
// proof — the verifier stays in this process and only its SHA-256 goes out with
// the request, so a code intercepted on the way back is unusable without it.

export type PkcePair = { verifier: string; challenge: string };

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

const PAGE = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;
       min-height:100vh;background:#0b0d10;color:#e6e8eb}
  main{max-width:32rem;padding:2rem;text-align:center}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:0;color:#9aa4b2}
</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

export type LoopbackResult = { code: string };

/**
 * Serve one redirect on a loopback port and resolve with the code it carries.
 *
 * `onReady` receives the redirect URI once the port is known, so the caller can
 * build the authorize URL and open it. The server always shuts down: on
 * success, on a mismatched state, and on timeout.
 */
export async function awaitLoopbackCode(options: {
  state: string;
  timeoutMs: number;
  onReady: (redirectUri: string) => void | Promise<void>;
}): Promise<LoopbackResult> {
  return new Promise<LoopbackResult>((resolve, reject) => {
    let settled = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      const done = (status: number, title: string, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE(title, body));
      };

      if (!code || !state) {
        done(400, "Something went wrong", "No authorization code arrived.");
        return;
      }
      // A state mismatch means this redirect is not the one we started. Refuse
      // it rather than accepting a code we cannot account for.
      if (state !== options.state) {
        done(400, "Something went wrong", "This response did not match the request.");
        finish(() => reject(new Error("The sign-in response did not match the request.")));
        return;
      }

      done(
        200,
        "You're signed in",
        "You can close this tab and return to your terminal.",
      );
      finish(() => resolve({ code }));
    });

    function finish(action: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Let the response flush before tearing the socket down.
      setTimeout(() => server.close(), 100);
      action();
    }

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            "Timed out waiting for the browser. Run `qoren login` again, or use `qoren login --token`.",
          ),
        ),
      );
    }, options.timeoutMs);

    server.on("error", (err) => finish(() => reject(err)));

    // Port 0 = let the OS pick. 127.0.0.1 rather than localhost so we bind one
    // known interface instead of whatever the resolver returns.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        finish(() => reject(new Error("Could not open a local port.")));
        return;
      }
      void (async () => {
        try {
          await options.onReady(`http://127.0.0.1:${address.port}/callback`);
        } catch (err) {
          finish(() =>
            reject(err instanceof Error ? err : new Error(String(err))),
          );
        }
      })();
    });
  });
}

/**
 * Open a URL in the user's browser, best effort.
 *
 * Returns false when we could not, which is not an error: the caller prints the
 * URL either way, and on a headless box printing it is the whole answer.
 */
export function openBrowser(url: string): boolean {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* No browser here; the printed URL is the fallback. */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
