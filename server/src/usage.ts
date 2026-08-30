import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId } from './workspace.js';
import { env } from './env.js';

// AI API spend, recorded per call and attributed to the client entity the
// document was uploaded for. There is no billing API to read from, so this is
// the only record of what an extraction cost: every model call — Claude or
// OpenAI — writes its token usage here, priced with the published per-model
// rates below. The Practice → Clients page reads the aggregates, totalled over
// whichever period it is showing (see resolveRange).

export type UsageEvent = {
  id: string;
  workspaceId: string;
  organisationId: string; // the client entity the call was made for ('' = unknown)
  ts: string; // ISO timestamp
  feature: string; // 'extract' | 'summarize' | …
  provider: string; // 'claude' | 'openai' ('' on rows written before the toggle)
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
};

const COLLECTION = 'apiUsage';
// Usage rows are small but written on every extraction, so the file is pruned
// to a rolling window — long enough for a year-on-year look, short enough that
// the JSON store stays a sensible size.
const RETAIN_DAYS = 400;

// Published list prices, USD per million tokens (input / output), for both
// readers. Cache reads bill at 0.1x input on either provider; Anthropic bills
// cache WRITES at 1.25x input while OpenAI writes them free (which is why the
// OpenAI path reports zero cache-write tokens rather than being priced at 0
// here). Override per deploy with
// LLM_PRICES='{"gpt-5":{"input":1.25,"output":10}}' when a rate changes (or an
// intro rate applies) before this table is updated.
const LIST_PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o4-mini': { input: 1.1, output: 4.4 },
};

// LLM_PRICES is the provider-neutral override; ANTHROPIC_PRICES predates it and
// still works. Both are merged, LLM_PRICES last.
function overrides(): Record<string, { input: number; output: number }> {
  const merged: Record<string, { input: number; output: number }> = {};
  for (const [name, raw] of [
    ['ANTHROPIC_PRICES', env.ANTHROPIC_PRICES],
    ['LLM_PRICES', env.LLM_PRICES],
  ] as const) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') Object.assign(merged, parsed);
    } catch {
      console.error(`[usage] ${name} is not valid JSON — ignoring`);
    }
  }
  return merged;
}

// The rate for a model id. Dated snapshots ("…-20251001", "gpt-5-2025-08-07")
// fall back to the base id, and an unknown model to the Sonnet tier — an
// unpriced call would otherwise silently read as free. Longest prefix wins, so
// "gpt-5-mini-2025-08-07" is priced as gpt-5-mini and not as the dearer gpt-5.
export function rateFor(model: string): { input: number; output: number } {
  const id = String(model || '').trim();
  const table = { ...LIST_PRICES, ...overrides() };
  if (table[id]) return table[id];
  const base = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((k) => id.startsWith(k));
  return base ? table[base] : { input: 3, output: 15 };
}

export function priceOf(
  model: string,
  t: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number }
): number {
  const rate = rateFor(model);
  const perToken = rate.input / 1_000_000;
  return (
    t.inputTokens * perToken +
    (t.cacheWriteTokens ?? 0) * perToken * 1.25 +
    (t.cacheReadTokens ?? 0) * perToken * 0.1 +
    t.outputTokens * (rate.output / 1_000_000)
  );
}

// The published rates, for the UI to show what the estimate is built from.
export function priceTable(): Array<{ model: string; input: number; output: number }> {
  const table = { ...LIST_PRICES, ...overrides() };
  return Object.entries(table).map(([model, r]) => ({ model, ...r }));
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

// Record one model call. Token counts arrive already normalised across
// providers (see llm.ts), so this stays provider-agnostic. Best-effort by
// design: a failure to write the usage row must never fail the extraction the
// user is waiting on.
export function recordUsage(
  req: Request,
  entry: {
    feature: string;
    provider: string;
    model: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheWriteTokens: number;
      cacheReadTokens: number;
    };
  }
): void {
  try {
    const u = entry.usage ?? { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
    const event: UsageEvent = {
      id: `use_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      workspaceId: workspaceId(req),
      organisationId: (req.header('X-Org-Id') || '').trim(),
      ts: new Date().toISOString(),
      feature: entry.feature,
      provider: entry.provider,
      model: entry.model,
      inputTokens: num(u.inputTokens),
      outputTokens: num(u.outputTokens),
      cacheWriteTokens: num(u.cacheWriteTokens),
      cacheReadTokens: num(u.cacheReadTokens),
      costUsd: 0,
    };
    event.costUsd = priceOf(event.model, event);
    const items = loadCollection<UsageEvent>(COLLECTION);
    items.push(event);
    const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
    const kept = items.filter((e) => Date.parse(e.ts) >= cutoff);
    saveCollection(COLLECTION, kept.length === items.length ? items : kept);
  } catch (err) {
    console.error('[usage] could not record API usage', err);
  }
}

// Day / month keys in the practice's own timezone, so "today" means today in
// Singapore rather than wherever UTC happens to be.
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.PRACTICE_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function dayKey(d: Date): string {
  try {
    return dayFormatter.format(d); // YYYY-MM-DD
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export type UsageTotals = { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
const emptyTotals = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

function add(t: UsageTotals, e: UsageEvent): void {
  t.calls += 1;
  t.inputTokens += e.inputTokens + e.cacheWriteTokens + e.cacheReadTokens;
  t.outputTokens += e.outputTokens;
  t.costUsd += e.costUsd;
}

// --- The window being priced --------------------------------------------------
//
// "What has this client cost me?" is asked over a period — this month, last
// month, the week so far — so the page picks one and everything on it is
// totalled over that. The vocabulary of presets lives in the browser's own
// module (src/lib/usageRange.js); resolving one into dates lives HERE, because
// a week starts and a day rolls over in the practice's timezone, which the
// browser asking may not be in. A key nobody recognises resolves to this month
// rather than to nothing, so a stale bookmark still shows a page.

export type ResolvedRange = { key: string; from: string; to: string };

// Day arithmetic on 'YYYY-MM-DD' keys, done in UTC so it never crosses a
// timezone: these are already the practice's own days, not instants.
function shiftDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const pad = (n: number) => String(n).padStart(2, '0');
const startOfMonth = (key: string) => `${key.slice(0, 7)}-01`;
// The last day of a month, as the day before the first of the next one — which
// is right in February and in a leap year without knowing either.
function endOfMonth(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  return shiftDays(nextMonth, -1);
}
// Monday, the way a working week is counted here.
function startOfWeek(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return shiftDays(key, -((dow + 6) % 7));
}
function startOfQuarter(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
}

const isDayKey = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '').trim());

export function resolveRange(
  input: { range?: unknown; from?: unknown; to?: unknown } = {},
  today: string = dayKey(new Date())
): ResolvedRange {
  const key = String(input.range ?? '').trim() || 'month';
  const from = String(input.from ?? '').trim();
  const to = String(input.to ?? '').trim();
  const at = (k: string, f: string, t: string): ResolvedRange => ({ key: k, from: f, to: t });

  switch (key) {
    case 'today':
      return at(key, today, today);
    case 'yesterday':
      return at(key, shiftDays(today, -1), shiftDays(today, -1));
    case 'week':
      return at(key, startOfWeek(today), today);
    case 'last-week': {
      const start = shiftDays(startOfWeek(today), -7);
      return at(key, start, shiftDays(start, 6));
    }
    case 'last-month': {
      const start = startOfMonth(shiftDays(startOfMonth(today), -1));
      return at(key, start, endOfMonth(start));
    }
    case 'last-30':
      return at(key, shiftDays(today, -29), today);
    case 'quarter':
      return at(key, startOfQuarter(today), today);
    case 'year':
      return at(key, `${today.slice(0, 4)}-01-01`, today);
    case 'custom': {
      // Either end may be left blank — a start with no end means "since then".
      // Dates the wrong way round are read as the range they describe rather
      // than refused: nobody means an empty window by typing them.
      const a = isDayKey(from) ? from : startOfMonth(today);
      const b = isDayKey(to) ? to : today;
      return a <= b ? at(key, a, b) : at(key, b, a);
    }
    default:
      return at('month', startOfMonth(today), today);
  }
}

export type UsageWindow = { today: UsageTotals; range: UsageTotals };
const emptyWindow = (): UsageWindow => ({ today: emptyTotals(), range: emptyTotals() });

// What the chosen window cost, split by organisation, with today alongside it —
// today is what is running right now and is worth seeing whatever period is
// being reviewed. One pass over the file so the Clients page is a single read.
export function usageSummary(
  ws: string,
  rangeInput: { range?: unknown; from?: unknown; to?: unknown } = {}
): {
  totals: UsageWindow;
  byOrganisation: Record<string, UsageWindow>;
  unattributed: UsageWindow;
  timezone: string;
  window: ResolvedRange;
  retainedFrom: string;
} {
  const today = dayKey(new Date());
  const window = resolveRange(rangeInput, today);
  const totals = emptyWindow();
  const byOrganisation: Record<string, UsageWindow> = {};
  const unattributed = emptyWindow();

  for (const e of loadCollection<UsageEvent>(COLLECTION)) {
    if (e.workspaceId !== ws) continue;
    const key = dayKey(new Date(e.ts));
    const inRange = key >= window.from && key <= window.to;
    if (!inRange && key !== today) continue;
    const bucket = e.organisationId
      ? (byOrganisation[e.organisationId] ??= emptyWindow())
      : unattributed;
    if (inRange) {
      add(bucket.range, e);
      add(totals.range, e);
    }
    if (key === today) {
      add(bucket.today, e);
      add(totals.today, e);
    }
  }
  return {
    totals,
    byOrganisation,
    unattributed,
    timezone: env.PRACTICE_TIMEZONE,
    window,
    // Rows older than this were pruned, so a range reaching past it is showing
    // less than it asks for — the page says so rather than reporting a quiet $0.
    retainedFrom: shiftDays(today, -RETAIN_DAYS),
  };
}
