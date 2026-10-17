const LOCALE = "en-US";
const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const oneFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const moneyFmt = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const centsFmt = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

 export const int = (n: number) => intFmt.format(Math.round(n));
 export const one = (n: number) => oneFmt.format(n);
 export const money = (n: number) => moneyFmt.format(n);
 export const cents = (n: number) => centsFmt.format(n);
 export const pct = (n: number, digits = 1) => `${(n * 100).toFixed(digits)}%`;
/** Compact money for tight spaces: $25.4k */
export const moneyShort = (n: number) => (Math.abs(n) >= 10000 ? `$${(n / 1000).toFixed(1)}k` : money(n));

/** Parse an ISO date (YYYY-MM-DD) as a local calendar date. */
export const parseDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** "Oct 16" */
export const shortDate = (d: Date) => d.toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
/** "Fri, Oct 16" */
export const dayDate = (d: Date) => d.toLocaleDateString(LOCALE, { weekday: "short", month: "short", day: "numeric" });
/** "14:32" */
export const clock = (d: Date) => d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });

export const plural = (n: number, one: string, many: string = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

/** Human list: "A, B and C" */
export const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** Forecast method names, as a planner would say them. */
export const METHOD_LABEL = (({
  seasonal_naive: "Seasonal naive (weekday)",
  moving_average: "28-day moving average",
  ses_seasonal: "Seasonal exponential smoothing",
  holt_seasonal: "Seasonal smoothing, damped trend",
  insufficient_history: "Flat mean (short history)",
}) as Record<string, string>);
