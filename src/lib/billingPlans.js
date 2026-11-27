// The billing plans an entity has recorded (rules in billingPlan.js), and the
// read that drafts one off a quotation.
import { useEffect, useState } from 'react';
import { blobStore } from '@/lib/blobStore';
import { cleanPlan } from '@/lib/billingPlan';
import { notifyBillsChanged, updateBill } from '@/lib/bills';

const KEY = 'cybills.billing-plans.v1';
export const BILLING_PLANS_EVENT = 'cybills:billing-plans-changed';
const emit = () => window.dispatchEvent(new Event(BILLING_PLANS_EVENT));
// This entity's own agreements: never inherited from another's.
const store = blobStore(KEY, { plans: [] }, emit, { perOrg: true, inheritLegacy: false });

// Whether the server has said what this entity's plans are yet.
export const billingPlansReady = () => store.ready();

export const getBillingPlans = () => {
  const plans = store.get()?.plans;
  return Array.isArray(plans) ? plans : [];
};

export function saveBillingPlan(raw) {
  const plan = cleanPlan(raw);
  if (!plan.id) plan.id = `plan_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const others = getBillingPlans();
  const at = others.findIndex((p) => p.id === plan.id);
  store.set({ plans: at === -1 ? [...others, plan] : others.map((p) => (p.id === plan.id ? plan : p)) });
  emit();
  return plan;
}

export function deleteBillingPlan(id) {
  store.set({ plans: getBillingPlans().filter((p) => p.id !== id) });
  emit();
}

/**
 * Save a quotation or agreement to a plan: out of the Costs lists and shown
 * under the plan on Billing plans. A plan with no paper of its own takes this one
 * as its source.
 */
export async function saveDocumentToPlan(docId, plan) {
  await updateBill(docId, { status: 'archived', billingPlanId: plan.id });
  if (!plan.sourceBillId) saveBillingPlan({ ...plan, sourceBillId: docId });
  notifyBillsChanged();
}

/** Put a saved document back in the Costs inbox. The plan itself stays. */
export async function moveDocumentBackToCosts(docId) {
  await updateBill(docId, { status: 'new', billingPlanId: '' });
  notifyBillsChanged();
}

/** The plans, re-read when they change or arrive from the server. */
export function useBillingPlans() {
  const [, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((n) => n + 1);
    window.addEventListener(BILLING_PLANS_EVENT, sync);
    return () => window.removeEventListener(BILLING_PLANS_EVENT, sync);
  }, []);
  return getBillingPlans();
}
