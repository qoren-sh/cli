import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput, type Key } from "ink";
import {
  editLine,
  emptyLine,
  moveSelection,
  scrollWindow,
  truncate,
  type LineState,
} from "./model.js";

// The console's furniture: lists, fields, key hints.
//
// Deliberately plain. A terminal is a low-resolution medium and a fleet console
// is something people keep open, so the job here is legibility over decoration:
// one accent colour for what is selected, dim for what is context, and nothing
// that moves unless something is actually happening.

export const ACCENT = "cyan";

/** A frame around a pane, titled, with the accent border when it has focus. */
export function Panel({
  title,
  focused = true,
  footer,
  children,
}: {
  title: string;
  focused?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={focused ? ACCENT : "gray"}
      paddingX={1}
    >
      <Box>
        <Text bold color={focused ? ACCENT : undefined}>
          {title}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
      {footer ? <Box>{footer}</Box> : null}
    </Box>
  );
}

export type Column<T> = {
  header: string;
  /** Fixed width in characters. The last column may omit it to take the rest. */
  width?: number;
  value: (row: T) => string;
  color?: (row: T) => string | undefined;
};

/**
 * A scrolling, selectable table.
 *
 * Selection and the scroll window are the caller's state, not this component's:
 * a pane needs to know which row is selected to act on it, and lifting that up
 * is simpler than reaching into a child for it.
 */
export function Table<T>({
  rows,
  columns,
  selected,
  height,
  focused = true,
  empty = "Nothing here yet.",
}: {
  rows: T[];
  columns: Column<T>[];
  selected: number;
  height: number;
  focused?: boolean;
  empty?: string;
}) {
  const startRef = useRef(0);
  const window = scrollWindow(rows.length, selected, height, startRef.current);
  startRef.current = window.start;

  if (rows.length === 0) {
    return (
      <Box paddingTop={1}>
        <Text dimColor>{empty}</Text>
      </Box>
    );
  }

  const cell = (text: string, width: number | undefined) =>
    width === undefined ? text : truncate(text, width).padEnd(width);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {"  "}
        {columns
          .map((c) => cell(c.header.toUpperCase(), c.width))
          .join(" ")}
      </Text>
      {rows.slice(window.start, window.end).map((row, i) => {
        const index = window.start + i;
        const isSelected = index === selected;
        return (
          <Box key={index}>
            <Text color={isSelected ? ACCENT : undefined}>
              {isSelected && focused ? "> " : "  "}
            </Text>
            {columns.map((column, c) => (
              <Text
                key={c}
                color={isSelected && focused ? ACCENT : column.color?.(row)}
                bold={isSelected && focused}
                dimColor={!isSelected && c > 0 && !column.color}
              >
                {cell(column.value(row) || "-", column.width)}
                {c < columns.length - 1 ? " " : ""}
              </Text>
            ))}
          </Box>
        );
      })}
      {rows.length > height ? (
        <Text dimColor>
          {`  ${window.start + 1}-${window.end} of ${rows.length}`}
        </Text>
      ) : null}
    </Box>
  );
}

/** A key/value block for one record. */
export function Details({ pairs }: { pairs: [string, ReactNode][] }) {
  const width = Math.max(...pairs.map(([key]) => key.length));
  return (
    <Box flexDirection="column">
      {pairs.map(([key, value]) => (
        <Box key={key}>
          <Text dimColor>{key.padEnd(width)}  </Text>
          {typeof value === "string" ? (
            <Text>{value || "-"}</Text>
          ) : (
            (value ?? <Text dimColor>-</Text>)
          )}
        </Box>
      ))}
    </Box>
  );
}

const FRAMES = ["|", "/", "-", "\\"];

/** Something is happening and we do not know for how long. */
export function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 120);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <Text color={ACCENT}>
      {FRAMES[frame]}
      {label ? ` ${label}` : ""}
    </Text>
  );
}

/**
 * A single-line text field.
 *
 * Ink has no cursor of its own to lend a component, so the caret is drawn: the
 * character under it is rendered inverse, and a caret past the end of the line
 * becomes an inverse space. Editing rules live in model.editLine, which is
 * where they can be tested.
 */
export function Field({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = "",
  mask = false,
  focused = true,
}: {
  value: LineState;
  onChange: (next: LineState) => void;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  mask?: boolean;
  focused?: boolean;
}) {
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value.value);
        return;
      }
      if (key.escape) {
        onCancel?.();
        return;
      }
      const next = editLine(value, input, key);
      if (next !== value) onChange(next);
    },
    { isActive: focused },
  );

  const text = mask ? "*".repeat(value.value.length) : value.value;
  if (!text) {
    return (
      <Text>
        {focused ? <Text inverse> </Text> : null}
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }
  const before = text.slice(0, value.cursor);
  const at = text.slice(value.cursor, value.cursor + 1);
  const after = text.slice(value.cursor + 1);
  return (
    <Text>
      {before}
      {focused ? <Text inverse>{at || " "}</Text> : at}
      {after}
    </Text>
  );
}

/** A field that owns its own buffer, for the common one-shot prompt. */
export function useField(initial = "") {
  const [line, setLine] = useState<LineState>(() => emptyLine(initial));
  return { line, setLine, value: line.value };
}

/**
 * A vertical list of choices.
 *
 * Used for every "which one?" the console asks — size, region, template, model,
 * environment — because they are all the same question, and a person who has
 * learned to pick a size has learned to pick a template.
 */
export function Choices<T>({
  items,
  selected,
  render,
  height = 10,
  hint,
}: {
  items: T[];
  selected: number;
  render: (item: T) => { label: string; detail?: string };
  height?: number;
  hint?: (item: T) => string | undefined;
}) {
  const startRef = useRef(0);
  const window = scrollWindow(items.length, selected, height, startRef.current);
  startRef.current = window.start;

  if (items.length === 0) return <Text dimColor>Nothing to choose from.</Text>;

  return (
    <Box flexDirection="column">
      {items.slice(window.start, window.end).map((item, i) => {
        const index = window.start + i;
        const isSelected = index === selected;
        const { label, detail } = render(item);
        return (
          <Box key={index}>
            <Text color={isSelected ? ACCENT : undefined} bold={isSelected}>
              {isSelected ? "> " : "  "}
              {label}
            </Text>
            {detail ? <Text dimColor>{`  ${detail}`}</Text> : null}
            {hint?.(item) ? <Text color="green">{`  ${hint(item)}`}</Text> : null}
          </Box>
        );
      })}
      {items.length > height ? (
        <Text dimColor>
          {`  ${window.start + 1}-${window.end} of ${items.length}`}
        </Text>
      ) : null}
    </Box>
  );
}

/** Move a selection with the arrow keys, j/k, or page keys. Returns the new
 * index, or null when the keystroke was not navigation. */
export function navigate(
  count: number,
  current: number,
  input: string,
  key: Key,
  page = 10,
): number | null {
  if (key.downArrow || input === "j") return moveSelection(count, current, 1);
  if (key.upArrow || input === "k") return moveSelection(count, current, -1);
  if (key.pageDown) return moveSelection(count, current, page);
  if (key.pageUp) return moveSelection(count, current, -page);
  if (key.home || input === "g") return 0;
  if (key.end || input === "G") return Math.max(0, count - 1);
  return null;
}

/** The key hints along the bottom of a pane. */
export function Hints({ keys }: { keys: [string, string][] }) {
  return (
    <Text dimColor>
      {keys.map(([key, label], i) => (
        <Text key={key}>
          {i > 0 ? "  " : ""}
          <Text color={ACCENT}>{key}</Text> {label}
        </Text>
      ))}
    </Text>
  );
}

/** Whatever the pane wants to say about its own state, in one line. */
export function StatusLine({
  error,
  refreshing,
  children,
}: {
  error?: string | null;
  refreshing?: boolean;
  children?: ReactNode;
}) {
  if (error) {
    return (
      <Text color="red" wrap="truncate-end">
        {error}
      </Text>
    );
  }
  if (refreshing) return <Spinner label="refreshing" />;
  return <>{children ?? null}</>;
}
