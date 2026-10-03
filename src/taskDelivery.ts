// Where a scheduled task's results go, as typed on the command line.
//
// `--delivery` picks the policy by name; `--deliver-to` names one chat and
// implies the "chat" policy, which is how an owner points a task at a Telegram
// group or a Slack channel. The target is checked here with the same pattern
// the control plane uses, so a typo fails before a request is made, with the
// accepted forms spelled out, instead of as a bare 400.

import type { ScheduledTaskDeliveryPolicy } from "@qoren/sdk";

export const DELIVERY_POLICIES: readonly ScheduledTaskDeliveryPolicy[] = [
  "activity-only",
  "all-channels",
  "chat",
];

/**
 * A chat target: `platform`, `platform:chatId` or `platform:chatId:threadId`.
 * Kept in step with the control plane's check (and @qoren/sdk's
 * CHAT_TARGET_PATTERN); copied rather than imported so this CLI still runs
 * against an older published SDK.
 */
export const CHAT_TARGET_RE =
  /^[a-z][a-z0-9_-]{0,31}(:[A-Za-z0-9_@.+-]{1,128}(:[A-Za-z0-9_.-]{1,64})?)?$/;

export const DELIVERY_HELP =
  "activity-only, all-channels (every chat channel, Hermes only), or chat (needs --deliver-to)";

export const DELIVER_TO_HELP =
  "send each run's result to one chat (sets --delivery chat): " +
  "PLATFORM for that platform's home channel (Hermes only), " +
  "PLATFORM:CHAT_ID for one chat, or PLATFORM:CHAT_ID:THREAD_ID for a thread or topic in it, " +
  "e.g. telegram:-1001234567890, telegram:-1001234567890:42, slack:C0123ABC. " +
  "PLATFORM must be one of the agent's connected chat channels";

export type DeliveryFields = {
  deliveryPolicy?: ScheduledTaskDeliveryPolicy;
  deliveryTarget?: string | null;
};

function badTarget(target: string): Error {
  return new Error(
    `"${target}" is not a chat target. Use PLATFORM, PLATFORM:CHAT_ID or PLATFORM:CHAT_ID:THREAD_ID, ` +
      "for example telegram:-1001234567890 or slack:C0123ABC (lowercase platform name, no spaces).",
  );
}

/**
 * The delivery fields for a task write, from `--delivery` / `--deliver-to`.
 * With neither flag, a create leaves delivery to the server's default and a
 * replace (given the task as it stands) keeps what it had, target included.
 */
export function resolveDelivery(
  options: { delivery?: string; deliverTo?: string },
  existing?: {
    deliveryPolicy: ScheduledTaskDeliveryPolicy;
    deliveryTarget?: string | null;
  },
): DeliveryFields {
  const { delivery, deliverTo } = options;
  if (delivery !== undefined && !DELIVERY_POLICIES.includes(delivery as ScheduledTaskDeliveryPolicy))
    throw new Error(`--delivery must be one of ${DELIVERY_POLICIES.join(", ")}.`);

  if (deliverTo !== undefined) {
    const target = deliverTo.trim();
    if (!CHAT_TARGET_RE.test(target)) throw badTarget(deliverTo);
    if (delivery !== undefined && delivery !== "chat")
      throw new Error(`--deliver-to sends to one chat, so it cannot be combined with --delivery ${delivery}.`);
    return { deliveryPolicy: "chat", deliveryTarget: target };
  }

  if (delivery === "chat") {
    if (existing?.deliveryPolicy === "chat" && existing.deliveryTarget)
      return { deliveryPolicy: "chat", deliveryTarget: existing.deliveryTarget };
    throw new Error("--delivery chat needs --deliver-to <target>, for example --deliver-to telegram:-1001234567890.");
  }
  if (delivery !== undefined)
    return { deliveryPolicy: delivery as ScheduledTaskDeliveryPolicy, deliveryTarget: null };

  if (existing)
    return {
      deliveryPolicy: existing.deliveryPolicy,
      deliveryTarget: existing.deliveryPolicy === "chat" ? (existing.deliveryTarget ?? null) : null,
    };
  return {};
}

/** How the task table shows delivery: the policy, or the chat it posts to. */
export function describeDelivery(task: {
  deliveryPolicy: string;
  deliveryTarget?: string | null;
}): string {
  if (task.deliveryPolicy === "chat")
    return task.deliveryTarget ? `chat ${task.deliveryTarget}` : "chat";
  return task.deliveryPolicy;
}
