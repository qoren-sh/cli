import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Command } from "commander";
import type { ClientSecret } from "@qoren/sdk";
import {
  orgSlug,
  requireContext,
  run,
  type Context,
  type GlobalOptions,
} from "../context.js";
import { age, details, dim, emit, note, table } from "../output.js";
import { gated, resolveClient } from "./clients.js";

// The vault: API keys and other values agents receive by NAME at setup.
//
//   echo "$HUBSPOT_KEY" | qoren secrets set HUBSPOT_API_KEY --client Acme
//
// A secret is agency-wide, or belongs to one of your clients (--client). The
// same name can be saved once agency-wide and once per client. An agent gets
// its own client's secret first, then the agency-wide one, and never another
// client's, so client B's agent can't end up with client A's key.
//
// Values go in on stdin, from --file, or with --value (which leaves the value
// in your shell history). They never come back out except through `reveal`,
// which is audited.

/** "all clients" for an agency-wide row, else the client's name. */
export const scopeLabel = (s: Pick<ClientSecret, "customerId" | "customerName">): string =>
  s.customerId ? (s.customerName ?? s.customerId) : "all clients";

/** The agents a row is used by, two by name and the rest counted. */
export function usedByLabel(agents: { name: string }[]): string {
  if (agents.length === 0) return "none";
  const shown = agents.slice(0, 2).map((a) => a.name).join(", ");
  return agents.length > 2 ? `${shown} +${agents.length - 2}` : shown;
}

/** The rows `secrets list` prints, narrowed to one client when asked: that
 * client's own secrets plus the agency-wide ones its agents can fall back to,
 * with the agency-wide row left out where the client has its own. */
export function secretsFor(
  rows: ClientSecret[],
  customerId: string | null | undefined,
): ClientSecret[] {
  if (customerId === undefined) return rows;
  if (customerId === null) return rows.filter((r) => !r.customerId);
  const own = new Set(
    rows.filter((r) => r.customerId === customerId).map((r) => r.name),
  );
  return rows.filter(
    (r) =>
      r.customerId === customerId || (!r.customerId && !own.has(r.name)),
  );
}

/** The scope a --client / --agency pair asks for: undefined = every scope. */
async function scopeOf(
  ctx: Context,
  options: { client?: string; agency?: boolean },
): Promise<{ id: string | null; name: string } | undefined> {
  if (options.client && options.agency) {
    throw new Error("Pass --client or --agency, not both.");
  }
  if (options.agency) return { id: null, name: "all clients" };
  if (!options.client) return undefined;
  const client = await resolveClient(ctx, options.client);
  return { id: client.id, name: client.name };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

export function secretsCommands(program: Command, global: () => GlobalOptions) {
  const secrets = program
    .command("secrets")
    .alias("secret")
    .alias("vault")
    .description("Keys your agents receive by name, agency-wide or per client");

  secrets
    .command("list")
    .alias("ls")
    .description("Secret names and who they belong to. Never values")
    .option(
      "--client <client>",
      "only what an agent of this client would get (id or exact name)",
    )
    .option("--agency", "only the agency-wide secrets")
    .action((options: { client?: string; agency?: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        const scope = await scopeOf(ctx, options);
        const rows = secretsFor(
          await ctx.qoren.secrets.list(await orgSlug(ctx)),
          scope?.id,
        );
        emit(rows, () => {
          if (scope) note(dim(`As an agent of ${scope.name} sees them`));
          table(rows, [
            { header: "name", value: (s) => s.name },
            { header: "client", value: (s) => scopeLabel(s) },
            { header: "kind", value: (s) => s.kind ?? "value" },
            // Absent on a control plane older than the batched used-by list: leave the cell blank.
            { header: "used by", value: (s) => (s.usedBy ? usedByLabel(s.usedBy) : "") },
            { header: "description", value: (s) => s.description ?? "" },
            { header: "updated", value: (s) => age(s.updatedAt) },
          ]);
        });
      })(),
    );

  secrets
    .command("set <name>")
    .description("Save or replace a secret. Reads the value from stdin unless --value or --file")
    .option("--client <client>", "save it for one client only (id or exact name)")
    .option("--value <value>", "the value (stays in your shell history; prefer stdin)")
    .option("--file <path>", "store this file's contents as a file secret")
    .option("--description <text>", "a note shown beside the name")
    .action(
      (
        name: string,
        options: { client?: string; value?: string; file?: string; description?: string },
      ) =>
        run(async () => {
          const ctx = requireContext(global());
          if (options.value !== undefined && options.file) {
            throw new Error("Pass --value or --file, not both.");
          }
          let value: string;
          if (options.file) value = await readFile(options.file, "utf8");
          else if (options.value !== undefined) value = options.value;
          else if (process.stdin.isTTY) {
            throw new Error(
              "Pipe the value on stdin, or pass --file or --value.",
            );
          } else value = await readStdin();
          if (!value) throw new Error("The value is empty.");

          const scope = await scopeOf(ctx, { client: options.client });
          const saved = (await gated(
            ctx.qoren.secrets.set(await orgSlug(ctx), {
              name,
              value,
              description: options.description,
              ...(options.file
                ? { kind: "file" as const, fileExt: extname(options.file).replace(/^\./, "") || undefined }
                : {}),
              customerId: scope?.id ?? null,
            }),
          )) as ClientSecret;
          emit(saved, () =>
            details([
              ["Saved", saved.name],
              ["For", scopeLabel(saved)],
              ["Kind", saved.kind ?? "value"],
            ]),
          );
        })(),
    );

  secrets
    .command("rm <name>")
    .alias("remove")
    .description("Delete one secret. Agents that already have it keep their copy")
    .option("--client <client>", "the client's secret (id or exact name); default is the agency-wide one")
    .action((name: string, options: { client?: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const scope = await scopeOf(ctx, options);
        const result = await ctx.qoren.secrets.remove(
          await orgSlug(ctx),
          name,
          scope?.id ?? null,
        );
        emit(result, () =>
          note(`Deleted ${name.toUpperCase()} (${scope?.name ?? "all clients"}).`),
        );
      })(),
    );

  secrets
    .command("reveal <name>")
    .description("Print one value. Every reveal is recorded in the audit log")
    .option("--client <client>", "the client's secret (id or exact name); default is the agency-wide one")
    .action((name: string, options: { client?: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const scope = await scopeOf(ctx, options);
        const revealed = await ctx.qoren.secrets.reveal(
          await orgSlug(ctx),
          name,
          scope?.id ?? null,
        );
        emit(revealed, () => process.stdout.write(`${revealed.value}\n`));
      })(),
    );

  secrets
    .command("used-by <name>")
    .description("Agents that have this secret injected")
    .option("--client <client>", "the client's secret (id or exact name); default is the agency-wide one")
    .action((name: string, options: { client?: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const scope = await scopeOf(ctx, options);
        const agents = await ctx.qoren.secrets.usedBy(
          await orgSlug(ctx),
          name,
          scope?.id ?? null,
        );
        emit(agents, () =>
          table(agents, [
            { header: "id", value: (a) => a.id },
            { header: "agent", value: (a) => a.name },
            { header: "environment", value: (a) => a.machineName },
            { header: "status", value: (a) => a.status },
          ]),
        );
      })(),
    );
}
