// Deriving an agent's machine identity from its display name.
//
// The slug is permanent — it becomes the agent's Unix user — while the name is
// just a label someone can change later. Nobody should have to type both, so
// every place that offers to create an agent derives one the same way: the
// command line, and the interactive console's deploy form. One function, so a
// name that works in one cannot be refused by the other.

/** A safe token derived from a display name, or "" when nothing survives. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
