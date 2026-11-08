import { Router, type Request, type Response } from 'express';
import { googleEnabled } from './env.js';
import { memberForSession, canAccessOrg } from './users.js';
import { workspaceId } from './workspace.js';
import { listBills, bookRevision } from './store.js';
import { practiceDayKey } from './usage.js';
import {
  dataScopeForOrg,
  listOrganisations,
  organisationForScope,
  setOrganisationPlan,
} from './organisations.js';
import { CAP_MESSAGE, SUSPENDED_MESSAGE, PLAN_LEVELS, cleanPlan, monthOf, readsBlocked, stateOf, type PlanState } from './planRules.js';

/**
 * Documents counted against an entity's plan this month, and the gate that
 * stops reading once the plan is exceeded. Rules: planRules.ts.
 *
 * A document counts when it was CREATED this month (the practice's month, not
 * the server's) and is a real document of the entity's: not deleted, not
 * merged away (the combined document is the cost), not a Dext-import row (a
 * migration is not a month's work) and not a link placeholder that never got a
 * file. Counted from the book, never from usage rows: one document makes
 * several model calls, and a re-read makes none that is new.
 */
const memo = new Map<string, { rev: number; month: string; n: number }>();

export function documentsThisMonth(scope: string, now: Date = new Date()): number {
  const month = monthOf(practiceDayKey(now));
  const rev = bookRevision();
  const hit = memo.get(scope);
  if (hit && hit.rev === rev && hit.month === month) return hit.n;
  let n = 0;
  for (const b of listBills(scope)) {
    if (b.status === 'deleted' || b.status === 'merged') continue;
    if ((b as any).dextId) continue;
    if (b.emailLink && (b.emailLink.status === 'awaiting_trust' || b.emailLink.status === 'failed')) continue;
    if (monthOf(practiceDayKey(new Date(b.createdAt))) !== month) continue;
    n += 1;
  }
  memo.set(scope, { rev, month, n });
  return n;
}

/** The plan and this month's count for an entity, or null when it has no plan (unlimited). */
export function planStateFor(ws: string, realOrgId: string, now: Date = new Date()): PlanState | null {
  const scope = dataScopeForOrg(realOrgId);
  const org = organisationForScope(ws, scope);
  return stateOf(org?.plan, org?.plan ? documentsThisMonth(scope, now) : 0);
}

/** The words to refuse a read with, or null when reading is allowed. */
export function capRefusal(ws: string, realOrgId: string): string | null {
  try {
    const state = planStateFor(ws, realOrgId);
    if (!readsBlocked(state)) return null;
    return state?.state === 'suspended' ? SUSPENDED_MESSAGE : CAP_MESSAGE;
  } catch (err) {
    // A counting fault must never stop a client's documents being read.
    console.error('[plan] could not count documents; allowing the read', err);
    return null;
  }
}

/** Gate for a browser read route: answers 402 and returns true when reading is blocked. */
export function refuseIfOverPlan(req: Request, res: Response): boolean {
  const refusal = capRefusal(workspaceId(req), (req.header('X-Org-Id') || '').trim());
  if (!refusal) return false;
  res.status(402).json({ error: 'plan_cap_reached', message: refusal });
  return true;
}

export const planRouter = Router();

// GET /api/plan — the open entity's plan and this month's count, for the banner.
// Anyone signed in to the entity may read its own; there is nothing else in it.
planRouter.get('/', (req, res) => {
  const ws = workspaceId(req);
  const realOrgId = (req.header('X-Org-Id') || '').trim();
  res.json({ plan: planStateFor(ws, realOrgId), levels: PLAN_LEVELS });
});

// PUT /api/plan/:id — set or clear an entity's plan. The practice's alone: it is
// a commercial term, and a client's own admin must not be able to raise it.
planRouter.put('/:id', (req: Request, res: Response) => {
  const ws = workspaceId(req);
  const me = memberForSession(req);
  if (googleEnabled && !(me?.practice && !me.deactivated)) {
    return res.status(403).json({ error: 'not_practice_team', message: 'Only the practice team can set a plan.' });
  }
  const id = String(req.params.id);
  const org = listOrganisations(ws).find((o) => o.id === id);
  if (!org || (googleEnabled && me && !canAccessOrg(me, org.id))) return res.status(404).json({ error: 'not_found' });

  if (req.body?.clear === true) {
    setOrganisationPlan(ws, id, null);
    return res.json({ ok: true, plan: null });
  }
  const plan = cleanPlan(req.body, me?.email || '');
  if (!plan) return res.status(400).json({ error: 'invalid_plan', message: 'Choose a level, or give a document limit above zero.' });
  setOrganisationPlan(ws, id, plan);
  res.json({ ok: true, plan: planStateFor(ws, id) });
});
