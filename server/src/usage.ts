import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId } from './workspace.js';
import { env } from './env.js';

// AI API spend, recorded per call and attributed to the client entity the
// document was uploaded for. There is no billing API to read from, so this is
// the only record of what an extraction cost: every model call — Claude or
// OpenAI — writes its token usage here, priced with the published per-model
// rates below. The Practice → Clients page reads the aggregates (today /
// month-to-date).

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
  // GPT-5.6. These MUST stay listed explicitly: rateFor falls back to the
  // longest matching prefix, and 'gpt-5' is a prefix of every 5.6 id — so
  // without a row of its own, Luna would bill at gpt-5's $1.25/$10 instead of
  // its own $0.20/$1.20.
  'gpt-5.6': { input: 4, output: 20 }, // the bare alias routes to Sol
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
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
