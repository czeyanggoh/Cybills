import { readSetting } from './settings.js';

// A supplier's BILLING PLAN, server-side: what its quotation or agreement says
// the invoices will be made of, applied to an emailed, WhatsApp'd or Drive
// document by the background read, and asked before an unattended publish.
//
// The rules are NOT written here: they are the pure module the document page and
// the upload read too (src/lib/billingPlan.js), loaded by path the way
// prepayment.ts loads its own, so a bill is split the same whichever road it
// arrived by.

export const BILLING_PLANS_KEY = 'cybills.billing-plans.v1';

export type BillingMatch = {
  status: 'match' | 'applied' | 'mismatch' | 'outside' | 'ambiguous';
  reason?: string;
};

type Rules = {
  matchBillingPlan: (doc: unknown, plans: unknown[], opts?: { printedTax?: unknown }) => BillingMatch | null;
  billingPlanPatch: (match: BillingMatch | null) => Record<string, unknown>;
  billingPlanStatus: (doc: unknown, plans: unknown[]) => BillingMatch | null;
  planMayWriteLines: (rows: unknown, total: unknown) => boolean;
};

let rules: Rules | null = null;
let tried = false;

async function loadBillingPlanRules(): Promise<Rules | null> {
  if (tried) return rules;
  tried = true;
  try {
    const url = new URL('../../src/lib/billingPlan.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<Rules>;
    rules =
      typeof mod?.matchBillingPlan === 'function' && typeof mod?.billingPlanStatus === 'function'
        ? (mod as Rules)
        : null;
  } catch (e) {
    console.error('[billing-plan] rules unavailable', e);
    rules = null;
  }
  return rules;
}

export function billingPlansFor(ws: string, orgId: string): unknown[] {
  const blob = readSetting<{ plans?: unknown }>(ws, BILLING_PLANS_KEY, orgId);
  return Array.isArray(blob?.plans) ? blob.plans : [];
}

/**
 * The fields a supplier's billing plan writes onto a document just read, or null
 * where it writes nothing: no plan, an invoice that disagrees with it, or rows
 * already on the document that add up (somebody's breakdown).
 *
 * `doc` is the document as it will stand after the read; `existingLines` are the
 * rows it held BEFORE it; `printedTax` the GST on the paper where the document
 * records less (tax nobody may claim).
 */
export async function billingPlanPatchFor(
  ws: string,
  orgId: string,
  doc: Record<string, unknown>,
  { existingLines, printedTax }: { existingLines: unknown; printedTax?: unknown }
): Promise<Record<string, unknown> | null> {
  const plans = billingPlansFor(ws, orgId);
  if (!plans.length) return null;
  const r = await loadBillingPlanRules();
  if (!r) return null;
  if (!r.planMayWriteLines(existingLines, doc.total)) return null;
  const match = r.matchBillingPlan(doc, plans, { printedTax });
  return match?.status === 'match' ? r.billingPlanPatch(match) : null;
}

/**
 * Why a document may not be published unattended on its plan's account, or '':
 * the supplier has a plan and this document is not coded from it, whether it
 * disagrees with the plan or merely has not had it applied.
 */
export async function billingPlanHold(ws: string, orgId: string, doc: unknown): Promise<string> {
  const plans = billingPlansFor(ws, orgId);
  if (!plans.length) return '';
  const r = await loadBillingPlanRules();
  if (!r) return '';
  const status = r.billingPlanStatus(doc, plans);
  if (!status || status.status === 'applied') return '';
  return status.status === 'match' ? 'billing_plan_not_applied' : 'billing_plan_mismatch';
}
