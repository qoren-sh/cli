import type { Command } from "commander";
import type {
  CreateTriggerInput,
  WebhookDelivery,
  WebhookSourceName,
  WebhookTrigger,
} from "@qoren/sdk";
import { requireContext, run, type GlobalOptions } from "../context.js";
import {
  age,
  bold,
  details,
  dim,
  emit,
  note,
  statusColor,
  table,
  warn,
} from "../output.js";

// Webhook triggers: what wakes an agent when you are not there.
//
// The shape of the whole thing in one line:
//
//   qoren webhook create <agent> --name "Bookings" --source cal \
//     --event BOOKING_CREATED --rules "Add the attendee to the CRM and brief me."
//
// That prints a URL and a secret, once. Paste both into cal.com's webhook
// settings and the agent starts getting bookings.
//
// `deliveries` is the command you will actually live in: it says whether an
// event arrived, whether it was acted on, and if not, why not.

const SOURCES: WebhookSourceName[] = [
  "cal",
  "github",
  "stripe",
  "generic",
  "none",
];

function triggerTable(rows: WebhookTrigger[]): void {
  table(rows, [
    { header: "id", value: (t) => t.id },
    { header: "name", value: (t) => t.name },
    { header: "source", value: (t) => t.source },
    { header: "status", value: (t) => statusColor(t.status) },
    { header: "events", value: (t) => t.events.join(", ") || "all" },
    { header: "autonomy", value: (t) => t.autonomy },
    { header: "deliveries", value: (t) => String(t.deliveryCount) },
    { header: "last", value: (t) => age(t.lastDeliveryAt) },
  ]);
}

function deliveryTable(rows: WebhookDelivery[]): void {
  table(rows, [
    { header: "id", value: (d) => d.id },
    { header: "event", value: (d) => d.eventType },
    { header: "status", value: (d) => statusColor(d.status) },
    { header: "summary", value: (d) => d.summary ?? d.error ?? "" },
    { header: "when", value: (d) => age(d.createdAt) },
  ]);
}

/** Print the URL and secret with the one instruction that matters: this is the
 * only time either is readable. Goes to stderr via `note` so `--json` still
 * pipes clean data — a script storing the secret reads it from the JSON. */
function printSecret(
  value: { url: string; secret: string; signatureHeader: string | null },
  what: string,
): void {
  note(`${what}. Copy both of these into your webhook settings now:`);
  details([
    ["URL", value.url],
    ["Secret", value.secret],
    ...(value.signatureHeader
      ? ([["Signature header", value.signatureHeader]] as [string, string][])
      : []),
  ]);
  warn("Neither is readable again. Lose them and you rotate.");
  if (value.url.startsWith("/")) {
    warn(
      "That URL has no host: the control plane has no public URL configured. Fix that, then rotate to get a complete one.",
    );
  }
}

export function webhookCommands(
  program: Command,
  global: () => GlobalOptions,
) {
  const webhook = program
    .command("webhook")
    .alias("webhooks")
    .alias("trigger")
    .description("Let an outside service wake an agent");

  webhook
    .command("sources")
    .description("Services Qoren can receive webhooks from")
    .action(() =>
      run(async () => {
        const ctx = requireContext(global());
        const sources = await ctx.qoren.webhooks.sources();
        emit(sources, () =>
          table(sources, [
            { header: "source", value: (s) => s.source },
            { header: "name", value: (s) => s.label },
            { header: "verified", value: (s) => (s.verified ? "yes" : "no") },
            {
              header: "known events",
              value: (s) => (s.events.length ? String(s.events.length) : "any"),
            },
          ]),
        );
      })(),
    );

  webhook
    .command("ls <agentId>")
    .alias("list")
    .description("List an agent's triggers")
    .action((agentId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const triggers = await ctx.qoren.webhooks.list(agentId);
        emit(triggers, () =>
          triggers.length
            ? triggerTable(triggers)
            : note(
                `No triggers yet. ${dim(`qoren webhook create ${agentId} --name … --source cal`)}`,
              ),
        );
      })(),
    );

  webhook
    .command("get <id>")
    .description("Show one trigger")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const t = await ctx.qoren.webhooks.get(id);
        emit(t, () =>
          details([
            ["Id", t.id],
            ["Name", t.name],
            ["Agent", t.agentSlug ?? t.agentId],
            ["Source", t.source],
            ["Status", statusColor(t.status)],
            ["Events", t.events.join(", ") || "all"],
            ["Autonomy", t.autonomy],
            ["Rules", t.instructions ?? ""],
            ["Limit", `${t.maxPerHour}/hour`],
            ["Deliveries", `${t.deliveryCount} (${t.failureCount} failed)`],
            ["Last delivery", t.lastDeliveryAt ?? "never"],
          ]),
        );
      })(),
    );

  webhook
    .command("create <agentId>")
    .description("Create a trigger and print its URL and secret")
    .requiredOption("--name <name>", "what this trigger is for")
    .option(`--source <source>`, SOURCES.join(" | "), "cal")
    .option(
      "--event <name...>",
      "only act on these events (repeatable; omit for all)",
    )
    .option("--rules <text>", "what the agent should do when this fires")
    .option("--propose", "let the agent only propose actions, not take them")
    .option("--max-per-hour <n>", "paid turns per hour before throttling")
    .option("--secret <secret>", "the secret the sender already has")
    .option("--header <name>", "custom source: header carrying the signature")
    .option("--encoding <encoding>", "custom source: hex | base64")
    .option("--prefix <prefix>", "custom source: signature prefix, e.g. sha256=")
    .option("--event-path <path>", "custom source: path to the event name")
    .action(
      (
        agentId: string,
        options: {
          name: string;
          source: string;
          event?: string[];
          rules?: string;
          propose?: boolean;
          maxPerHour?: string;
          secret?: string;
          header?: string;
          encoding?: string;
          prefix?: string;
          eventPath?: string;
        },
      ) =>
        run(async () => {
          const ctx = requireContext(global());
          const body: CreateTriggerInput = {
            name: options.name,
            source: options.source as WebhookSourceName,
            ...(options.event ? { events: options.event } : {}),
            ...(options.rules !== undefined
              ? { instructions: options.rules }
              : {}),
            ...(options.propose ? ({ autonomy: "propose" } as const) : {}),
            ...(options.maxPerHour !== undefined
              ? { maxPerHour: Number(options.maxPerHour) }
              : {}),
            ...(options.secret !== undefined
              ? { secret: options.secret }
              : {}),
            ...(options.header !== undefined
              ? { headerName: options.header }
              : {}),
            ...(options.encoding !== undefined
              ? { encoding: options.encoding as "hex" | "base64" }
              : {}),
            ...(options.prefix !== undefined
              ? { signaturePrefix: options.prefix }
              : {}),
            ...(options.eventPath !== undefined
              ? { eventPath: options.eventPath }
              : {}),
          };
          const created = await ctx.qoren.webhooks.create(agentId, body);
          emit(created, () => {
            printSecret(created, `Trigger ${bold(options.name)} created`);
            if (!options.event?.length) {
              warn(
                "This trigger fires on every event the source sends, and each one is a paid agent turn. Narrow it with --event.",
              );
            }
          });
        })(),
    );

  webhook
    .command("rules <id> <text>")
    .description("Rewrite what the agent should do when this trigger fires")
    .action((id: string, text: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const t = await ctx.qoren.webhooks.update(id, { instructions: text });
        emit(t, () => note(`Updated the rules for ${bold(t.name)}.`));
      })(),
    );

  webhook
    .command("events <id> [names...]")
    .description("Set which events this trigger acts on (none = all)")
    .action((id: string, names: string[]) =>
      run(async () => {
        const ctx = requireContext(global());
        const t = await ctx.qoren.webhooks.update(id, { events: names });
        emit(t, () =>
          note(
            names.length
              ? `${bold(t.name)} now acts on ${names.join(", ")}.`
              : `${bold(t.name)} now acts on every event the source sends.`,
          ),
        );
      })(),
    );

  webhook
    .command("pause <id>")
    .description("Stop deliveries without changing the URL")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const t = await ctx.qoren.webhooks.update(id, { status: "paused" });
        emit(t, () =>
          note(`${bold(t.name)} is paused. Its URL still answers, and ignores.`),
        );
      })(),
    );

  webhook
    .command("resume <id>")
    .description("Start accepting deliveries again")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const t = await ctx.qoren.webhooks.update(id, { status: "active" });
        emit(t, () => note(`${bold(t.name)} is live again.`));
      })(),
    );

  webhook
    .command("rotate <id>")
    .description("Issue a new URL and secret, invalidating the old pair")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const rotated = await ctx.qoren.webhooks.rotate(id);
        emit(rotated, () => {
          printSecret(rotated, "Rotated");
          warn(
            "The old URL now 404s, so the sender stops working until you paste these in.",
          );
        });
      })(),
    );

  webhook
    .command("test <id>")
    .description("Send a sample event through the real path")
    .option("--event <name>", "event name to simulate")
    .action((id: string, options: { event?: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const delivery = await ctx.qoren.webhooks.test(
          id,
          options.event !== undefined ? { eventType: options.event } : {},
        );
        emit(delivery, () =>
          note(
            `Delivery ${bold(delivery.id)} is ${delivery.status}. ${dim(
              `qoren webhook delivery ${id} ${delivery.id}`,
            )}`,
          ),
        );
      })(),
    );

  webhook
    .command("deliveries <id>")
    .alias("log")
    .description("What this trigger has received, newest first")
    .option("--limit <n>", "how many to show", "20")
    .action((id: string, options: { limit: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const rows = await ctx.qoren.webhooks.deliveries(
          id,
          Number(options.limit),
        );
        emit(rows, () =>
          rows.length
            ? deliveryTable(rows)
            : note("Nothing has arrived at this trigger yet."),
        );
      })(),
    );

  webhook
    .command("delivery <id> <deliveryId>")
    .description("One delivery: the payload, the prompt, and the agent's reply")
    .action((id: string, deliveryId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const d = await ctx.qoren.webhooks.delivery(id, deliveryId);
        emit(d, () => {
          details([
            ["Id", d.delivery.id],
            ["Event", d.delivery.eventType],
            ["Status", statusColor(d.delivery.status)],
            ["Summary", d.delivery.summary ?? ""],
            ["Error", d.delivery.error ?? ""],
            ["Job", d.delivery.jobId ?? "never reached the agent"],
            ["Received", d.delivery.createdAt],
            ["Finished", d.delivery.finishedAt ?? ""],
          ]);
          if (d.payload) {
            note("Payload");
            process.stdout.write(`${d.payload}\n`);
          }
          if (d.agentResult) {
            note("The agent replied");
            process.stdout.write(`${d.agentResult}\n`);
          }
        });
      })(),
    );

  webhook
    .command("replay <id> <deliveryId>")
    .description("Run a past delivery's payload through the agent again")
    .action((id: string, deliveryId: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const replayed = await ctx.qoren.webhooks.replay(id, deliveryId);
        emit(replayed, () =>
          note(`Replayed as delivery ${bold(replayed.id)}.`),
        );
      })(),
    );

  webhook
    .command("rm <id>")
    .alias("delete")
    .description("Delete a trigger and its delivery log")
    .action((id: string) =>
      run(async () => {
        const ctx = requireContext(global());
        const result = await ctx.qoren.webhooks.remove(id);
        emit(result, () =>
          note(`Removed ${bold(result.removed)}. Its URL now 404s.`),
        );
      })(),
    );
}
