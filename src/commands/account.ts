import type { Command } from "commander";
import { requireContext, run, type GlobalOptions } from "../context.js";
import { bold, details, emit, note, table, warn } from "../output.js";
import { gated, parseCostWindow, renderCosts } from "./clients.js";

// The account: what the plan allows, and what is being spent against it.

export function accountCommands(program: Command, global: () => GlobalOptions) {
  const account = program.command("account").description("Account and usage");

  account
    .command("usage")
    .description("Credits, spend and standing this billing period")
    .action(() =>
      run(async () => {
        const ctx = requireContext(global());
        const usage = await ctx.qoren.account.usage();
        emit(usage, () => {
          details([
            [
              "Credits used",
              usage.unlimitedCredits
                ? "unlimited plan"
                : String(usage.creditsUsed),
            ],
            [
              "Credits left",
              usage.unlimitedCredits ? "-" : String(usage.creditsRemaining),
            ],
            ["Balance", `$${usage.creditBalanceUsd.toFixed(2)}`],
            ["Model spend", `$${usage.managedLlmUsd.toFixed(2)}`],
            ["Web operations", String(usage.webSearchesUsed)],
            ["State", usage.alertState],
            ["Period ends", String(usage.periodEnd ?? "")],
          ]);
          // These stop agents from working, so they are the point of the
          // command when they are true, not a footnote.
          if (usage.blocked) {
            warn("Out of credits: agents are stopped until you top up.");
          }
          if (usage.budgetPaused) {
            warn(
              "Your monthly budget has been reached: agents are stopped until you raise or clear it.",
            );
          }
        });
      })(),
    );

  account
    .command("spending")
    .description("Infrastructure spend per environment")
    .option("--days <n>", "window in days", "30")
    .action((options: { days: string }) =>
      run(async () => {
        const ctx = requireContext(global());
        const data = await ctx.qoren.account.spending(
          Number.parseInt(options.days, 10) || 30,
        );
        emit(data, () => {
          table(data.machines, [
            { header: "environment", value: (m) => m.machineName },
            {
              header: "model spend",
              value: (m) => `$${m.openRouterTotalUsd.toFixed(2)}`,
            },
            // "actual" vs "estimated" matters: an environment without the
            // metrics agent installed reports a guess, and presenting that as
            // a measured figure would be misleading.
            { header: "basis", value: (m) => m.costStatus },
            { header: "error", value: (m) => m.error ?? "" },
          ]);
          const total = data.machines.reduce(
            (sum, m) => sum + m.openRouterTotalUsd,
            0,
          );
          note(`Total: ${bold(`$${total.toFixed(2)}`)}`);
        });
      })(),
    );

  account
    .command("costs")
    .description("What each client cost, in credits and dollars")
    .option("--from <date>", "start of the window, ISO date (default 30 days ago)")
    .option("--to <date>", "end of the window, ISO date (default now)")
    .action((options: { from?: string; to?: string }) =>
      run(async () => {
        const window = parseCostWindow(options.from, options.to);
        const ctx = requireContext(global());
        const costs = await gated(ctx.qoren.account.costs(window));
        emit(costs, () => renderCosts(costs));
      })(),
    );

  account
    .command("options")
    .description("Sizes, regions and models your plan allows")
    .action(() =>
      run(async () => {
        const ctx = requireContext(global());
        const options = await ctx.qoren.account.options();
        emit(options, () => {
          note(bold("Sizes"));
          table(options.sizes, [
            { header: "slug", value: (s) => s.slug },
            { header: "description", value: (s) => s.description },
            {
              header: "default",
              value: (s) => (s.slug === options.defaultSize ? "yes" : ""),
            },
          ]);
          note(bold("\nRegions"));
          table(options.regions, [
            { header: "slug", value: (r) => r.slug },
            { header: "description", value: (r) => r.description },
            {
              header: "default",
              value: (r) => (r.slug === options.defaultRegion ? "yes" : ""),
            },
          ]);
          // Models arrive as plain ids, with a recommended subset alongside.
          note(bold("\nModels"));
          const recommended = new Set(options.recommendedModels);
          table(options.models, [
            { header: "model", value: (m) => m },
            {
              header: "note",
              value: (m) =>
                m === options.defaultModel
                  ? "default"
                  : recommended.has(m)
                    ? "recommended"
                    : "",
            },
          ]);
        });
      })(),
    );

  account
    .command("models")
    .description("Models an agent can run on, with prices and context windows")
    .action(() =>
      run(async () => {
        const ctx = requireContext(global());
        const models = await ctx.qoren.account.models();
        emit(models, () => {
          const price = (usd: number | null) =>
            usd == null ? "" : `$${usd.toFixed(2)}`;
          table(models, [
            { header: "model", value: (m) => m.modelId },
            { header: "name", value: (m) => m.name ?? "" },
            { header: "in $/M", value: (m) => price(m.promptUsdPerM) },
            { header: "out $/M", value: (m) => price(m.completionUsdPerM) },
            {
              header: "context",
              value: (m) =>
                m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : "",
            },
            {
              header: "note",
              value: (m) =>
                m.recommended ? "recommended" : m.custom ? "saved" : "",
            },
          ]);
        });
      })(),
    );

  account
    .command("templates")
    .description("Templates you can deploy agents from")
    .action(() =>
      run(async () => {
        const ctx = requireContext(global());
        const templates = await ctx.qoren.templates.list();
        emit(templates, () =>
          table(templates, [
            { header: "slug", value: (t) => t.name },
            { header: "description", value: (t) => t.description },
            { header: "source", value: (t) => t.source ?? "" },
          ]),
        );
      })(),
    );
}
