import type { Command } from "commander";
import {
  QorenError,
  type AgencyClient,
  type ClientCosts,
  type ClientHologramLink,
  type CostsByKind,
  type Machine,
} from "@qoren/sdk";
import { requireContext, run, type Context, type GlobalOptions } from "../context.js";
import { age, bold, details, dim, emit, note, table } from "../output.js";

// Agency clients: the businesses an agency runs environments and agents for.
//
// The API calls them customers; this CLI never says so. Everything here is
// gated per account upstream, and an account without the feature is told so
// in one sentence rather than being sent to sign in again.

/** The upstream refusal for an account without clients. */
export const CLIENTS_DISABLED = "Clients are not enabled for this account.";

/**
 * The feature refusal as a plain failure; any other error untouched.
 *
 * A bare 403 exits 3 ("sign in again"), which is the wrong advice here: the
 * credential is fine, the account just does not have the feature. The message
 * is the server's own, so it stays one clean sentence.
 */
export function clientsGateError(err: unknown): unknown {
  if (
    err instanceof QorenError &&
    err.status === 403 &&
    // The Custom agent routes say so with a code; the older client routes
    // only in words.
    (err.code === "agency_clients_disabled" ||
      /clients are not enabled/i.test(err.message))
  ) {
    return new Error(err.message || CLIENTS_DISABLED);
  }
  return err;
}

/** Await a gated call, reporting the feature refusal cleanly. */
export async function gated<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    throw clientsGateError(err);
  }
}

/**
 * Pick one client by id or exact name. Ids win, then active names (unique
 * upstream), then an archived name when only one matches. Pure so the rules
 * are testable without a control plane.
 */
export function matchClient(
  clients: AgencyClient[],
  ref: string,
): AgencyClient {
  const byId = clients.find((c) => c.id === ref);
  if (byId) return byId;
  const named = clients.filter((c) => c.name === ref);
  const active = named.filter((c) => c.archivedAt === null);
  if (active.length === 1 && active[0]) return active[0];
  if (active.length === 0 && named.length === 1 && named[0]) return named[0];
  if (named.length > 1) {
    throw new Error(
      `More than one client is named "${ref}". Use its id (see qoren clients list --archived).`,
    );
  }
  throw new Error(
    `No client has the id or name "${ref}". Run qoren clients list to see them.`,
  );
}

/** Look a client up by id or exact name, archived ones included. */
export async function resolveClient(
  ctx: Context,
  ref: string,
): Promise<AgencyClient> {
  const clients = await gated(
    ctx.qoren.clients.list({ includeArchived: true }),
  );
  return matchClient(clients, ref);
}

/** Pick one environment by id or exact name. */
export function matchEnvironment(machines: Machine[], ref: string): Machine {
  const byId = machines.find((m) => m.id === ref);
  if (byId) return byId;
  const named = machines.filter((m) => m.name === ref);
  if (named.length === 1 && named[0]) return named[0];
  if (named.length > 1) {
    throw new Error(
      `More than one environment is named "${ref}". Use its id (see qoren env ls).`,
    );
  }
  throw new Error(
    `No environment has the id or name "${ref}". Run qoren env ls to see them.`,
  );
}

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The window for `qoren account costs`, as unix ms.
 *
 * Accepts any ISO date or date-time. A bare date for --to means the whole of
 * that day (UTC), because "--to 2026-09-30" read as midnight would silently
 * leave the 30th out. With nothing given, the last 30 days.
 */
export function parseCostWindow(
  from: string | undefined,
  to: string | undefined,
  now: number = Date.now(),
): { from: number; to: number } {
  const parse = (value: string, flag: string): number => {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new Error(
        `${flag} must be an ISO date such as 2026-09-01, not "${value}".`,
      );
    }
    return ms;
  };
  const end =
    to === undefined
      ? now
      : parse(to, "--to") + (DATE_ONLY.test(to.trim()) ? DAY_MS : 0);
  const start = from === undefined ? end - 30 * DAY_MS : parse(from, "--from");
  if (start >= end) throw new Error("--from must be before --to.");
  return { from: start, to: end };
}

export type CostRow = { label: string; credits: number; total?: boolean };

/**
 * The rows `qoren account costs` prints: each client by spend, then the
 * environments with no client, then account-level spend, then spend from
 * before cost tracking (only when there is some), then the total.
 */
export function costRows(costs: ClientCosts): CostRow[] {
  const named = costs.customers
    .filter((c) => c.customerId !== null)
    .map((c) => ({ label: c.name ?? c.customerId ?? "", credits: c.credits }))
    .sort((a, b) => b.credits - a.credits);
  const unassigned = costs.customers
    .filter((c) => c.customerId === null)
    .reduce((sum, c) => sum + c.credits, 0);
  return [
    ...named,
    { label: "No client", credits: unassigned },
    { label: "Account", credits: costs.account.credits },
    ...(costs.beforeTracking.credits > 0
      ? [{ label: "Before client tracking", credits: costs.beforeTracking.credits }]
      : []),
    { label: "Total", credits: costs.totalCredits, total: true },
  ];
}

/** The categories, in the order the console lists them. */
const CATEGORIES: { key: keyof CostsByKind; label: string }[] = [
  { key: "environment", label: "Hosting" },
  { key: "llm", label: "Models" },
  { key: "webSearch", label: "Web search" },
  { key: "runs", label: "Custom agent runs" },
  { key: "tools", label: "Custom agent tools" },
];

/**
 * The whole window by category: every client, no client, the account line
 * and spend from before tracking. Categories with no spend are left out.
 */
export function categoryRows(costs: ClientCosts): CostRow[] {
  const all = [
    ...costs.customers.map((c) => c.byKind),
    costs.account.byKind,
    costs.beforeTracking.byKind,
  ];
  return CATEGORIES.map(({ key, label }) => ({
    label,
    credits: all.reduce((sum, b) => sum + b[key], 0),
  })).filter((r) => r.credits > 0);
}

/** Credits to two decimal places at most, without trailing zeros. */
export const formatCredits = (credits: number): string =>
  String(Math.round(credits * 100) / 100);

/** Dollars are credits / 1000. */
export const formatDollars = (credits: number): string =>
  `$${(credits / 1000).toFixed(2)}`;

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Print a costs response as tables plus the caveats a reader needs. */
export function renderCosts(costs: ClientCosts): void {
  note(dim(`${day(costs.from)} to ${day(costs.to)}`));
  costTable(costRows(costs), "client");
  const categories = categoryRows(costs);
  if (categories.length > 0) {
    process.stdout.write("\n");
    costTable(categories, "category");
  }
  if (costs.trackingSince === null) {
    note(dim("No spend has been attributed to clients yet."));
  } else if (costs.trackingSince > costs.from) {
    note(
      dim(
        `Spend is broken down by client from ${day(costs.trackingSince)}; earlier spend is under "Before client tracking".`,
      ),
    );
  }
  if (costs.beforeTracking.estimated) {
    note(
      dim(
        "Model spend from before client tracking is estimated from the raw model cost.",
      ),
    );
  }
  if (costs.pendingSettlements > 0) {
    note(
      dim(
        `${String(costs.pendingSettlements)} ${costs.pendingSettlements === 1 ? "charge is" : "charges are"} still settling and not included above.`,
      ),
    );
  }
  note(dim("Mailbox charges and the plan fee are not included; see Clients in the console."));
}

function costTable(rows: CostRow[], header: string): void {
  table(rows, [
    {
      header,
      value: (r) => (r.total ? bold(r.label) : r.label),
    },
    {
      header: "credits",
      value: (r) => {
        const text = formatCredits(r.credits);
        return r.total ? bold(text) : text;
      },
    },
    {
      header: "dollars",
      value: (r) => {
        const text = formatDollars(r.credits);
        return r.total ? bold(text) : text;
      },
    },
  ]);
}

function clientTable(rows: AgencyClient[], showStatus: boolean): void {
  table(rows, [
    { header: "id", value: (c) => c.id },
    { header: "name", value: (c) => c.name },
    { header: "email", value: (c) => c.contactEmail ?? "" },
    { header: "environments", value: (c) => String(c.environmentCount) },
    { header: "agents", value: (c) => String(c.agentCount) },
    ...(showStatus
      ? [
          {
            header: "status",
            value: (c: AgencyClient) => (c.archivedAt ? "archived" : "active"),
          },
        ]
      : []),
    { header: "age", value: (c) => age(c.createdAt) },
  ]);
}

function clientDetails(c: AgencyClient): void {
  details([
    ["Id", c.id],
    ["Name", c.name],
    ["Email", c.contactEmail ?? ""],
    ["Notes", c.notes ?? ""],
    ["Environments", String(c.environmentCount)],
    ["Agents", String(c.agentCount)],
    ["Status", c.archivedAt ? `archived ${c.archivedAt}` : "active"],
  ]);
}

export function clientsCommands(program: Command, global: () => GlobalOptions) {
  const clients = program
    .command("clients")
    .alias("client")
    .description("Manage the clients your environments are run for");

  clients
    .command("list")
    .alias("ls")
    .description("List your clients")
    .option("--archived", "include archived clients")
    .action((options: { archived?: boolean }) =>
      run(async () => {
        const ctx = requireContext(global());
        const rows = await gated(
          ctx.qoren.clients.list({ includeArchived: options.archived === true }),
        );
        emit(rows, () => clientTable(rows, options.archived === true));
      })(),
    );

  clients
    .command("create <name>")
    .description("Add a client")
    .option("--email <email>", "contact email")
    .option("--notes <notes>", "free-form notes")
    .action((name: string, options: { email?: string; notes?: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const created = await gated(
          ctx.qoren.clients.create({
            name,
            ...(options.email !== undefined
              ? { contactEmail: options.email }
              : {}),
            ...(options.notes !== undefined ? { notes: options.notes } : {}),
          }),
        );
        emit(created, () => {
          clientDetails(created);
          note(
            `Client ${bold(created.name)} added. Assign an environment with qoren env assign <environment> ${created.id}.`,
          );
        });
      })(),
    );

  clients
    .command("rename <client> <name>")
    .description("Rename a client (by id or current name)")
    .action((ref: string, name: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const client = await resolveClient(ctx, ref);
        const updated = await gated(
          ctx.qoren.clients.update(client.id, { name }),
        );
        emit(updated, () => note(`Renamed to ${bold(updated.name)}.`));
      })(),
    );

  clients
    .command("archive <client>")
    .description(
      "Archive a client (by id or name); its environments must be unassigned first",
    )
    .action((ref: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const client = await resolveClient(ctx, ref);
        const archived = await gated(ctx.qoren.clients.archive(client.id));
        emit(archived, () =>
          note(`Client ${bold(archived.name)} archived. Its cost history is kept.`),
        );
      })(),
    );

  clients
    .command("hologram <client>")
    .description(
      "Show, create or revoke a client's public hologram link (account owners only)",
    )
    .option("--new", "create the link, or replace it (the old URL stops working)")
    .option("--revoke", "switch the link off")
    .action((ref: string, options: { new?: boolean; revoke?: boolean }) =>
      run(async () => {
        if (options.new && options.revoke) {
          throw new Error("Use --new or --revoke, not both.");
        }
        const ctx = requireContext(global());
        const client = await resolveClient(ctx, ref);
        const link = await gated(
          options.revoke
            ? ctx.qoren.clients.revokeHologramLink(client.id)
            : options.new
              ? ctx.qoren.clients.createHologramLink(client.id)
              : ctx.qoren.clients.hologramLink(client.id),
        );
        emit(link, () => hologramDetails(client, link, options.revoke === true));
      })(),
    );
}

/** What `qoren clients hologram` prints. The URL alone goes to stdout, so it can be piped. */
export function hologramDetails(
  client: AgencyClient,
  link: ClientHologramLink,
  revoked: boolean,
): void {
  if (!link.active) {
    note(
      revoked
        ? `The hologram link for ${bold(client.name)} is off. Its URL no longer works.`
        : `${bold(client.name)} has no hologram link. Create one with qoren clients hologram ${client.id} --new.`,
    );
    return;
  }
  if (link.url) process.stdout.write(`${link.url}\n`);
  else
    note(
      `The link for ${bold(client.name)} is on, but its URL cannot be shown again. Replace it with --new to get a new URL.`,
    );
  note(
    dim(
      `Anyone with this URL sees ${client.name}'s environments and agents, live, without signing in. Created ${link.createdAt ?? ""}.`,
    ),
  );
}
