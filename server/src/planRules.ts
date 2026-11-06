// Subscription plans and the monthly document cap: the rules, with nothing in
// them that reads a store, so a test can read them.
//
// Cze, Nov 2026: external subscribers take CYBills at four volume levels
// (SGD a month -> documents a month). The cap is on documents READ, and what
// happens past it is deliberately gentle: a document is still FILED (nothing a
// client sent is ever lost), but no model reads it, so the practice is not
// paying for work the plan does not cover. A new month, or a higher level,
// reads again. An entity with no plan is a client from before subscriptions
// and is unlimited.

export const PLAN_LEVELS = [
  { level: '39.90', docCap: 100 },
  { level: '69.90', docCap: 300 },
  { level: '99.90', docCap: 600 },
  { level: '199.90', docCap: 1500 },
] as const;

export type Plan = { level: string; docCap: number; since: string; setBy: string };

/** Warn from this share of the cap. */
export const NEAR_SHARE = 0.8;

export function capForLevel(level: string): number {
  return PLAN_LEVELS.find((p) => p.level === level)?.docCap ?? 0;
}

/**
 * Clean what a person sent. A known level takes its cap unless a custom cap is
 * given (an agreed exception); an unknown level needs a cap of its own. Nothing
 * usable is null: never a plan with no cap, which would read as unlimited.
 */
export function cleanPlan(raw: any, by: string, now: Date = new Date()): Plan | null {
  if (!raw || typeof raw !== 'object') return null;
  const level = String(raw.level ?? '').trim();
  const custom = Math.floor(Number(raw.docCap));
  const docCap = Number.isFinite(custom) && custom > 0 ? custom : capForLevel(level);
  if (!(docCap > 0)) return null;
  return { level, docCap, since: now.toISOString(), setBy: by };
}

export type PlanState = {
  level: string;
  cap: number;
  used: number;
  /** 'ok' | 'near' (80% or more) | 'at' (exactly the cap) | 'over' (more than the cap) */
  state: 'ok' | 'near' | 'at' | 'over';
};

export function stateOf(plan: Plan | undefined | null, used: number): PlanState | null {
  if (!plan || !(plan.docCap > 0)) return null;
  const cap = plan.docCap;
  const state = used > cap ? 'over' : used === cap ? 'at' : used >= cap * NEAR_SHARE ? 'near' : 'ok';
  return { level: plan.level, cap, used, state };
}

/** Reading stops only once the plan is exceeded: the document that reaches the cap is still read. */
export function readsBlocked(s: PlanState | null): boolean {
  return !!s && s.state === 'over';
}

export const CAP_MESSAGE =
  'This month\'s document limit for your plan has been reached, so new documents are filed but not read. They can be read from next month, or when the plan is upgraded. Contact CYBM to upgrade.';

/** The month a timestamp falls in, in the practice's day: 'YYYY-MM'. */
export function monthOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}
