/** Shared, memoised access to the budget optimizer so pages agree on one result per budget. */
import { optimize } from "./api.js";
import { store } from "../state.js";

const cache: Map<string, Promise<import("./types.js").Optimization>> = new Map();
let stamp = (null as Date | null);

export function getOptimization(budget: number, leadTimes: Record<string, number> = {}) {
  const s = store.get();
  if (s.fetchedAt !== stamp) { cache.clear(); stamp = s.fetchedAt; }
  // service level and review period come from the engine policy, so this agrees with /api/dashboard
  const key = JSON.stringify([budget, leadTimes]);
  if (!cache.has(key)) {
    const p = optimize({ budget, lead_time_overrides: leadTimes });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return (cache.get(key) as Promise<import("./types.js").Optimization>);
}
