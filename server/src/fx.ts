// The day's exchange rate, for the few places CYBills has to convert money it
// was not given a figure for: a bill posted into a Xero that has no
// multi-currency (xero.ts), and a foreign receipt on an expense claim that
// prints no figure in the claim's currency (claims.ts).
//
// CYBills holds no rates of its own, and Xero's API publishes none, so this
// asks the ECB reference rates (Frankfurter; `FX_RATES_URL` points elsewhere)
// for the document's own date. A weekend or holiday answers with the last
// working day's, which is what "the rate of the day" means for one. Rates are
// returned the way a document prints them: units of `to` per 1 `from`.
//
// The ECB publishes about thirty currencies, and a receipt from Colombo is not
// in them: an LKR 1,352,461.54 cabin rental went onto a claim as 1.35 million
// SGD, because "no rate" meant "count it as printed". So a currency the ECB
// does not carry is asked of a second, wider daily source (fawazahmed0's
// currency-api, dated, no key; `FX_FALLBACK_URL` is its template with `{date}`
// and `{from}`, empty switches it off). Only where the first had no answer,
// and only by default where `FX_RATES_URL` is not overridden — a deploy that
// points at its own rates has said where its rates come from.
//
// A dated answer never changes, so it is cached for the life of the process;
// `peekDayRate` reads that cache synchronously for the code paths (a claim's
// live items) that cannot wait on the network, after `warmDayRates` has asked.

const cache = new Map<string, number>();
const inflight = new Map<string, Promise<number>>();

const norm = (c: unknown) => String(c ?? '').trim().toUpperCase();
function dayOf(date: unknown): string {
  const today = new Date().toISOString().slice(0, 10);
  const d = String(date ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today ? d : 'latest';
}
const keyOf = (from: string, to: string, day: string) => `${from}>${to}@${day}`;

const FALLBACK = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date}/v1/currencies/{from}.min.json';
function fallbackTemplate(): string {
  const set = process.env.FX_FALLBACK_URL;
  if (set != null) return set.trim();
  return process.env.FX_RATES_URL ? '' : FALLBACK;
}

// The wider source: `{ date, <from>: { <to>: rate, … } }`, codes in lower case.
async function fallbackRate(from: string, to: string, day: string): Promise<number> {
  const template = fallbackTemplate();
  if (!template) return 0;
  const url = template.replace('{date}', day).replace('{from}', from.toLowerCase());
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return 0;
    const rate = Number((await res.json())?.[from.toLowerCase()]?.[to.toLowerCase()]);
    return rate > 0 ? rate : 0;
  } catch (err) {
    console.error('[fx] fallback rate lookup failed', from, to, day, err);
    return 0;
  }
}

export async function dayRate(fromCcy: string, toCcy: string, date: unknown): Promise<number> {
  const from = norm(fromCcy);
  const to = norm(toCcy);
  if (!from || !to) return 0;
  if (from === to) return 1;
  const day = dayOf(date);
  const key = keyOf(from, to, day);
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const root = String(process.env.FX_RATES_URL || 'https://api.frankfurter.app').replace(/\/+$/, '');
  const ask = (async () => {
    try {
      const res = await fetch(`${root}/${day}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      let rate = res.ok ? Number((await res.json())?.rates?.[to]) : 0;
      if (!(rate > 0)) rate = await fallbackRate(from, to, day);
      if (!(rate > 0)) return 0;
      if (day !== 'latest') cache.set(key, rate);
      return rate;
    } catch (err) {
      console.error('[fx] exchange rate lookup failed', from, to, day, err);
      return 0;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, ask);
  return ask;
}

// The cached rate, or 0 when nobody has asked for it yet (or it failed).
export function peekDayRate(fromCcy: string, toCcy: string, date: unknown): number {
  const from = norm(fromCcy);
  const to = norm(toCcy);
  if (!from || !to) return 0;
  if (from === to) return 1;
  return cache.get(keyOf(from, to, dayOf(date))) ?? 0;
}

// Ask for several at once, so a synchronous reader finds them cached.
export async function warmDayRates(wants: Array<{ from: string; to: string; date: unknown }>): Promise<void> {
  const seen = new Set<string>();
  const asks: Promise<number>[] = [];
  for (const w of wants) {
    const from = norm(w.from);
    const to = norm(w.to);
    if (!from || !to || from === to) continue;
    const key = keyOf(from, to, dayOf(w.date));
    if (seen.has(key) || cache.has(key)) continue;
    seen.add(key);
    asks.push(dayRate(from, to, w.date));
  }
  await Promise.all(asks);
}
