import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { QorenError } from "@qoren/sdk";
import { isApiAccessRequired, isOrgDeleting, type Context } from "../context.js";
import { refreshDelay } from "./model.js";

// Talking to the control plane from a long-lived process.
//
// A command runs once and exits, so it can afford to be naive about fetching. A
// console stays open for an hour, so it cannot: it has to refresh without being
// asked, stop refreshing what nobody is looking at, and never let a request
// that was in flight when the reader moved on write into the pane they moved
// to. All of that lives here, so the panes stay declarative.

const SessionContext = createContext<Context | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: Context;
  children: ReactNode;
}) {
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

/** The authenticated client, the profile behind it, and who it belongs to. */
export function useSession(): Context {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside a SessionProvider");
  return ctx;
}

/** Whatever a failed request actually means, as one sentence. */
export function describeError(err: unknown): string {
  if (err instanceof QorenError) {
    // Before isAuthError: a 403, but the plan is the problem, not the token.
    if (isApiAccessRequired(err)) return err.message;
    if (isOrgDeleting(err)) return err.message;
    if (err.isAuthError) {
      return "Your credentials were rejected. Quit and run `qoren login` again.";
    }
    if (err.isPaymentRequired) {
      return "This action needs an active plan.";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export type Resource<T> = {
  data: T | null;
  error: string | null;
  /** True only for the very first load; a background refresh never blanks the
   * pane, because a list that flickers to "loading" every few seconds is worse
   * than a list that is a few seconds stale. */
  loading: boolean;
  refreshing: boolean;
  reload: () => void;
};

export type ResourceOptions<T> = {
  /** Stop fetching entirely — the pane is off screen, or a form has the floor. */
  active?: boolean;
  /** How long to wait before refetching. Given the last value so a pane can
   * poll hard while something is mid-flight and slowly otherwise. Return 0 to
   * fetch once and never again. */
  interval?: (data: T | null) => number;
};

/**
 * Load something, keep it fresh, and hand back what is known right now.
 *
 * `load` is re-run whenever `key` changes, which is how a pane switches to a
 * different environment's agents without a stale list showing through. An
 * AbortSignal is passed so an in-flight request is dropped rather than raced.
 */
export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  options: ResourceOptions<T> = {},
): Resource<T> {
  const { active = true, interval } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Held in refs so changing them does not restart the fetch effect: `load` is
  // an inline closure at every call site and would otherwise re-fire forever.
  const loadRef = useRef(load);
  loadRef.current = load;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;
  // The interval callback needs the value the last fetch produced, and reading
  // `data` from the effect's closure would pin it to whatever it was at setup.
  const dataRef = useRef<T | null>(null);
  dataRef.current = data;

  // A key change means the pane is now showing something else, so the old
  // value must not linger under the new heading.
  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(true);
  }, [key]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let cancelled = false;

    const tick = async (first: boolean) => {
      if (!first) setRefreshing(true);
      try {
        const value = await loadRef.current(controller.signal);
        if (cancelled) return;
        setData(value);
        setError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        // Keep whatever was on screen: a transient failure should read as a
        // warning next to stale data, not as an empty pane.
        setError(describeError(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
      if (cancelled) return;
      const wait = intervalRef.current?.(dataRef.current) ?? 0;
      if (wait > 0) timer = setTimeout(() => void tick(false), wait);
    };

    void tick(true);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [key, active, nonce]);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  return { data, error, loading, refreshing, reload };
}

/** The usual cadence: poll hard while anything in the list is mid-flight, and
 * slowly when the fleet is at rest. */
export const statusPaced =
  <T,>(statuses: (data: T) => string[]) =>
  (data: T | null): number =>
    refreshDelay(data ? statuses(data) : []);
