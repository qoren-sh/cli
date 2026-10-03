import type { Agent, AgentRuntime, HostedAgentRuntime } from "@qoren/sdk";

// Which runtimes the CLI knows, and which of them it can deploy.
//
// `custom` is a Custom agent from the Agent Designer. It shows up in listings
// and can be filtered on, but it has no environment and is never created from a
// template: `qoren designer deploy` makes one. Keeping both lists here means the
// command line and the interactive console cannot disagree about that.

/** Every runtime an agent can have, for listing and filtering. */
export const RUNTIMES: AgentRuntime[] = ["hermes", "openclaw", "codex", "custom"];

export function isHostedRuntime(runtime: string): runtime is HostedAgentRuntime {
  return runtime !== "custom" && (RUNTIMES as string[]).includes(runtime);
}

/** The runtimes `qoren agent create` can install on an environment. */
export const HOSTED_RUNTIMES: HostedAgentRuntime[] = RUNTIMES.filter(isHostedRuntime);

/** What to say when someone tries to create a Custom agent from a template. */
export const CUSTOM_CREATE_REFUSAL =
  "Custom agents are built in the Agent Designer, not from a template. Deploy one with: qoren designer deploy <design> --name <name>";

/** True for a Custom agent: no environment, so no shell, logs or doctor. */
export function isCustomAgent(agent: Pick<Agent, "runtime" | "machineId">): boolean {
  return agent.runtime === "custom" || agent.machineId === null;
}
