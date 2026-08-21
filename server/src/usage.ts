import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId } from './workspace.js';
import { env } from './env.js';

// Claude API spend, recorded per call and attributed to the client entity the
// document was uploaded for. There is no billing API to read from, so this is
// the only record of what an extraction cost: every Anthropic call writes its
// token usage here, priced with the published per-model rates below. The
// Practice → Clients page reads the aggregates (today / month-to-date).

export type UsageEvent = {
  id: string;
  workspaceId: string;
  organisationId: string; // the client entity the call was made for ('' = unknown)
  ts: string; // ISO timestamp
  feature: string; // 'extract' | 'summarize' | …
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

// Published Claude API list prices, USD per million tokens (input / output).
// Cache writes bill at 1.25x input, cache reads at 0.1x input. Override per
// deploy with ANTHROPIC_PRICES='{"claude-sonnet-5":{"input":2,"output":10}}'
// when a rate changes (or an intro rate applies) before this table is updated.
const LIST_PRICES: Record<string, { input: number; output: number }> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

function overrides(): Record<string, { input: number; output: number }> {
  if (!env.ANTHROPIC_PRICES.trim()) return {};
  try {
    const parsed = JSON.parse(env.ANTHROPIC_PRICES);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    console.error('[usage] ANTHROPIC_PRICES is not valid JSON — ignoring');
    return {};
  }
}

// The rate for a model id. Dated snapshots ("…-20251001") fall back to the base
// id, and an unknown model to the Sonnet tier — an unpriced call would
// otherwise silently read as free.
export function rateFor(model: string): { input: number; output: number } {
  const id = String(model || '').trim();
  const table = { ...LIST_PRICES, ...overrides() };
  if (table[id]) return table[id];
  const base = Object.keys(table).find((k) => id.startsWith(k));
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

// Record one Anthropic call. Best-effort by design: a failure to write the
// usage row must never fail the extraction the user is waiting on.
export function recordUsage(
  req: Request,
  entry: { feature: string; model: string; usage: unknown }
): void {
  try {
    const u = (entry.usage ?? {}) as Record<string, unknown>;
    const event: UsageEvent = {
      id: `use_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      workspaceId: workspaceId(req),
      organisationId: (req.header('X-Org-Id') || '').trim(),
      ts: new Date().toISOString(),
      feature: entry.feature,
      model: entry.model,
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheWriteTokens: num(u.cache_creation_input_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
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

export type UsageWindow = { today: UsageTotals; monthToDate: UsageTotals };
const emptyWindow = (): UsageWindow => ({ today: emptyTotals(), monthToDate: emptyTotals() });

// Today's and this month's spend, split by organisation. One pass over the
// window so the Clients page is a single read.
export function usageSummary(ws: string): {
  totals: UsageWindow;
  byOrganisation: Record<string, UsageWindow>;
  unattributed: UsageWindow;
  timezone: string;
} {
  const now = new Date();
  const today = dayKey(now);
  const month = today.slice(0, 7);
  const totals = emptyWindow();
  const byOrganisation: Record<string, UsageWindow> = {};
  const unattributed = emptyWindow();

  for (const e of loadCollection<UsageEvent>(COLLECTION)) {
    if (e.workspaceId !== ws) continue;
    const key = dayKey(new Date(e.ts));
    if (!key.startsWith(month)) continue; // month-to-date is the widest window read
    const bucket = e.organisationId
      ? (byOrganisation[e.organisationId] ??= emptyWindow())
      : unattributed;
    add(bucket.monthToDate, e);
    add(totals.monthToDate, e);
    if (key === today) {
      add(bucket.today, e);
      add(totals.today, e);
    }
  }
  return { totals, byOrganisation, unattributed, timezone: env.PRACTICE_TIMEZONE };
}
