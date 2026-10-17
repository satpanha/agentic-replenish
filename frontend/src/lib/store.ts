/** Minimal observable store. Subscribers receive the new state and the keys that changed. */

export function createStore<S>(initial: S) {
  let state = initial;
  const subs: Set<(s: S, changed: Set<keyof S>) => void> = new Set();
  return {
    get: () => state,
    set(patch: Partial<S> | ((s: S) => Partial<S>)) {
      const p = typeof patch === "function" ? patch(state) : patch;
      const next = p as Record<string, unknown>, cur = state as Record<string, unknown>;
      const changed = new Set(Object.keys(next).filter((k) => next[k] !== cur[k])) as Set<keyof S>;
      if (!changed.size) return;
      state = { ...state, ...p };
      subs.forEach((f) => f(state, changed));
    },
    subscribe(fn: (s: S, changed: Set<keyof S>) => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** localStorage that never throws (private windows, blocked storage). */
export const persist = {
  read<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  write(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};
