// Task chaining, as typed on the command line.
//
// A scheduled task can read the latest output of other tasks of the same
// agent (or its own previous run) before its prompt on every run. On the
// command line that is a repeatable `--context-from <task>`, taking a task id,
// a task name, or "self"; the control plane resolves names and "self" to ids.
// `--no-context-from` on task-set clears the list.

/** The control plane refuses more than this many. */
export const MAX_CONTEXT_FROM = 5;

export const CONTEXT_FROM_HELP =
  "read the latest output of another task of this agent before each run: " +
  "a task id, a task name, or \"self\" for this task's own previous run. " +
  `Repeat for more, up to ${MAX_CONTEXT_FROM}`;

/** Commander collector for the repeatable `--context-from`. */
export function collectContextFrom(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/**
 * The `contextFrom` field for a task write. `undefined` (no flag) leaves it
 * out, so a create reads nothing and a replace keeps what it had; `false`
 * (`--no-context-from`) clears it.
 */
export function resolveContextFrom(option: string[] | false | undefined): string[] | undefined {
  if (option === undefined) return undefined;
  if (option === false) return [];
  const refs = option.map((ref) => ref.trim()).filter(Boolean);
  if (refs.length === 0) throw new Error("--context-from needs a task id, a task name, or \"self\".");
  if (refs.length > MAX_CONTEXT_FROM)
    throw new Error(`A task can read the output of at most ${MAX_CONTEXT_FROM} tasks.`);
  return refs;
}

/** How the task table shows a chain: the names it reads, "self" for its own previous run. */
export function describeChain(
  task: { id: string; contextFrom?: string[] | null },
  tasks: readonly { id: string; name: string }[],
): string {
  return (task.contextFrom ?? [])
    .map((id) => (id === task.id ? "self" : (tasks.find((t) => t.id === id)?.name ?? id)))
    .join(", ");
}
