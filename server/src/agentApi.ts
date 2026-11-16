import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from './env.js';
import { keyMatches } from './inboundKey.js';
import { WORKSPACE_ID } from './workspace.js';
import { listOrganisations, publishTargetFor, type Organisation } from './organisations.js';
import { memberByEmail, canAccessOrg, type User } from './users.js';
import { costComplete, getBillById, itemIdFor, listBills, type Bill } from './store.js';
import { claimMembership } from './claims.js';
import { shareToken } from './shareLinks.js';
import { accountsForOrg, gstRegisteredFor, postingCodesFrom, taxRatesForOrg } from './xero.js';

// The agent API: everything a person does by hand with expense claims and cost
// documents, for a machine caller (CYWorkspace's `cybillsClaims` function, which
// the cyws MCP connector reaches). Contract and examples: deploy/AGENT-API.md.
//
// It adds NO rules of its own. Each action is answered by the SAME route the
// app's pages call — /api/costs/bills, /api/claims/*, /api/xero/* — over
// loopback, signed in as the PERSON the caller names (`acting_email`). So who
// may add to a claim, approve one or publish to Xero is decided exactly as it
// is for a click, by the same code: a second copy of those rules here would be
// the one that drifts. What this file does is (1) prove the caller (X-API-Key,
// the key CYWS already uses on /api/payments), (2) resolve the entity from the
// Xero tenant the caller names and check the person may open it, (3) shape the
// answers, and (4) hold every Xero action at a dry run unless `confirm: true`.
//
// Never here: permanent delete of anything. Archive is offered.

export const agentRouter = Router();

type Ctx = { org: Organisation; member: User; cookie: string };
type Answer = { status: number; body: any };

const SESSION_COOKIE = 'cyb_session';
const LOOPBACK = () => `http://127.0.0.1:${env.PORT}`;

class AgentError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

// Every entity a tenant reaches: linked to it, or a bridge entity whose claims
// post into it. `org_id` picks one when there are several.
function entitiesFor(tenantId: string): Organisation[] {
  const want = norm(tenantId);
  if (!want) return [];
  return listOrganisations(WORKSPACE_ID).filter((o) => {
    if (norm(o.tenantId) === want) return true;
    const target = publishTargetFor(WORKSPACE_ID, o);
    return Boolean(target) && norm(target!.tenantId) === want;
  });
}

function contextFor(req: Request): Ctx {
  const b = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) };
  const tenantId = String(b.tenant_id ?? '').trim();
  if (!tenantId) throw new AgentError(400, 'tenant_id_required', 'Name the Xero tenant (tenant_id) whose CYBills book to work in.');
  const entities = entitiesFor(tenantId);
  if (!entities.length) throw new AgentError(404, 'no_entity', 'No CYBills entity is linked to that Xero tenant.');
  const wanted = String(b.org_id ?? '').trim();
  let org = entities[0];
  if (wanted) {
    const hit = entities.find((o) => o.id === wanted);
    if (!hit) throw new AgentError(404, 'no_entity', 'That org_id is not one of this tenant\'s CYBills entities.', { entities: entities.map((o) => ({ id: o.id, name: o.name })) });
    org = hit;
  } else if (entities.length > 1) {
    throw new AgentError(409, 'which_entity', 'This tenant has several CYBills entities; name one with org_id.', { entities: entities.map((o) => ({ id: o.id, name: o.name })) });
  }
  const email = norm(b.acting_email);
  if (!email) throw new AgentError(400, 'acting_email_required', 'Name the person (acting_email) the action is done as.');
  const member = memberByEmail(WORKSPACE_ID, email);
  if (!member || member.deactivated || member.removed || member.pending) {
    throw new AgentError(403, 'not_a_member', 'That address is not an active CYBills user.');
  }
  if (!canAccessOrg(member, org.id)) throw new AgentError(403, 'no_client_access', `${member.email} cannot open ${org.name} in CYBills.`);
  // A five-minute session for that person, used only for the loopback calls
  // below; it never leaves this process. With no session secret the app runs
  // sessionless (dev), where nobody can be acted as — so nothing is done.
  if (!env.SESSION_SECRET) throw new AgentError(503, 'not_configured', 'SESSION_SECRET is not set, so no person can be acted as.');
  const token = jwt.sign({ sub: member.id, email: member.email, name: member.name }, env.SESSION_SECRET, { expiresIn: 300 });
  return { org, member, cookie: `${SESSION_COOKIE}=${token}` };
}

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${LOOPBACK()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: ctx.cookie, 'X-Org-Id': ctx.org.id },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function must(ctx: Ctx, method: string, path: string, body?: unknown): Promise<any> {
  const r = await call(ctx, method, path, body);
  if (r.status >= 400) {
    throw new AgentError(r.status, String(r.body?.error || 'refused'), String(r.body?.message || r.body?.error || `CYBills answered ${r.status}`), { cybills: r.body });
  }
  return r.body;
}

// ── Shapes ──────────────────────────────────────────────────────────────────

const INBOX = new Set(['new', 'viewed', 'review', 'ready']);

// Where a document stands, in the words the Costs tabs use.
export function costState(b: Pick<Bill, 'status' | 'xeroInvoiceId'> & { claim?: unknown }, complete: boolean): string {
  if (b.claim) return 'in_expense_claim';
  if (b.xeroInvoiceId) return 'published';
  if (b.status === 'processing') return 'processing';
  if (b.status === 'archived' || b.status === 'merged') return 'archived';
  if (INBOX.has(b.status)) return complete ? 'ready' : 'to_review';
  return b.status;
}

const STATE_FILTERS: Record<string, (s: string) => boolean> = {
  unpublished: (s) => s === 'ready' || s === 'to_review',
  ready: (s) => s === 'ready',
  to_review: (s) => s === 'to_review',
  archived: (s) => s === 'archived',
  in_expense_claim: (s) => s === 'in_expense_claim',
  published: (s) => s === 'published',
  processing: (s) => s === 'processing',
};

const money = (v: unknown) => (v == null || v === '' ? null : Number(Number(v).toFixed(2)));

function costRow(b: any, claim: { id: string; name: string } | null) {
  const complete = costComplete(b as Bill);
  return {
    id: b.id,
    item_id: b.displayId || itemIdFor(b.id),
    supplier: b.supplier || '',
    date: b.date || '',
    category: b.category || '',
    currency: b.currency || '',
    amount: money(b.total),
    tax: money(b.tax),
    base_currency: b.baseCurrency || '',
    base_total: money(b.baseTotal),
    fx_rate: b.exchangeRate ?? null,
    fx_rate_type: b.exchangeRate ? 'document' : '',
    description: b.description || '',
    invoice_number: b.invoiceNumber || '',
    billed_to: b.billedTo || '',
    owner: b.owner || b.createdBy || '',
    uploaded_by: b.createdBy || '',
    state: costState({ ...b, claim }, complete),
    status: b.status,
    claim_id: claim?.id || null,
    claim_name: claim?.name || null,
    xero_invoice_id: b.xeroInvoiceId || null,
    file_url: b.storageKey ? `${env.APP_ORIGIN || ''}/api/costs/bills/${encodeURIComponent(b.id)}/file?s=${shareToken(b.id)}` : null,
  };
}

function claimState(c: any): string {
  if (c.deleted) return 'deleted';
  if (c.archived) return 'archived';
  if (String(c.xeroStatus || '').toUpperCase() === 'PAID') return 'paid';
  if (c.xeroInvoiceId) return 'published';
  return c.approvalStatus || 'draft';
}

const claimTotal = (c: any) => Number((c.transactions || []).reduce((n: number, t: any) => n + Number(t.total || 0), 0).toFixed(2));

function claimItem(t: any, bill: any) {
  return {
    id: String(t.itemId),
    item_id: t.displayId || bill?.displayId || itemIdFor(String(t.itemId)),
    supplier: t.supplier,
    date: t.date,
    category: t.category,
    description: t.description || '',
    total: money(t.total),
    tax: money(t.tax),
    orig_currency: t.origCurrency || '',
    orig_total: t.origTotal ? Number(t.origTotal) : null,
    fx_rate: t.fxRate ? Number(t.fxRate) : null,
    fx_rate_type: t.fxSource || '',
    owner: bill?.owner || bill?.createdBy || '',
  };
}

function claimSummary(c: any, orgId: string, withItems: boolean) {
  const out: Record<string, unknown> = {
    id: c.id,
    claim_no: c.reference || c.number || '',
    name: c.name,
    claim_for: c.claimFor,
    claim_date: c.claimDate,
    end_date: c.endDate,
    currency: c.currency,
    total: claimTotal(c),
    item_count: (c.transactions || []).length,
    status: claimState(c),
    approver: c.approver || '',
    paid: String(c.xeroStatus || '').toUpperCase() === 'PAID',
    paid_date: c.xeroPaidDate || null,
    xero_invoice_id: c.xeroInvoiceId || null,
    auto: Boolean(c.auto),
  };
  if (withItems) {
    out.items = (c.transactions || []).map((t: any) => claimItem(t, getBillById(orgId, String(t.itemId))));
    out.history = (c.history || []).map((h: any) => ({ at: h.at, by: h.by, text: h.text }));
  }
  return out;
}

async function allClaims(ctx: Ctx): Promise<any[]> {
  return (await must(ctx, 'GET', '/api/claims')).claims || [];
}
async function oneClaim(ctx: Ctx, id: string): Promise<any> {
  const c = (await allClaims(ctx)).find((x) => x.id === id);
  if (!c) throw new AgentError(404, 'claim_not_found', 'No such expense claim in this entity (or not visible to that person).');
  return c;
}

// Resolve item ids people use (261029000237) to the documents themselves.
function billsFor(ctx: Ctx, ids: unknown): Bill[] {
  const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  if (!list.length) throw new AgentError(400, 'item_ids_required', 'Name the documents with item_ids.');
  const missing: string[] = [];
  const out: Bill[] = [];
  for (const id of list) {
    const b = getBillById(ctx.org.id, id);
    if (!b) missing.push(id);
    else if (!out.some((x) => x.id === b.id)) out.push(b);
  }
  if (missing.length) throw new AgentError(404, 'item_not_found', `Not found in ${ctx.org.name}: ${missing.join(', ')}`);
  return out;
}

const asTxn = (b: Bill) => ({
  itemId: b.id,
  displayId: b.displayId,
  date: b.date || '—',
  supplier: b.supplier || 'Unknown supplier',
  category: b.category || 'Uncategorised',
  description: b.description || '',
  net: '0.00',
  tax: '0.00',
  total: '0.00', // the claim restates every line from the live document
});

// Where each document sits now, for the "before" half of a write's answer.
function membershipOf(ctx: Ctx, bills: Bill[]) {
  const on = claimMembership(ctx.org.id);
  return bills.map((b) => ({ id: b.id, item_id: b.displayId || itemIdFor(b.id), claim_id: on.get(b.id)?.id || null, claim_name: on.get(b.id)?.name || null }));
}

// ── Actions ─────────────────────────────────────────────────────────────────

type Handler = (ctx: Ctx, b: any) => Promise<unknown>;

const page = (b: any) => ({
  offset: Math.max(0, Number(b.offset) || 0),
  limit: Math.min(200, Math.max(1, Number(b.limit) || 50)),
});

const READ: Record<string, Handler> = {
  async list_costs(ctx, b) {
    const rows = ((await must(ctx, 'GET', '/api/costs/bills')).bills || []) as any[];
    const supplier = norm(b.supplier);
    const owner = norm(b.owner);
    const state = String(b.status ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (state && !STATE_FILTERS[state]) throw new AgentError(400, 'bad_status', `status is one of ${Object.keys(STATE_FILTERS).join(', ')}.`);
    const min = b.amount_min != null ? Number(b.amount_min) : null;
    const max = b.amount_max != null ? Number(b.amount_max) : null;
    const amount = b.amount != null ? Number(b.amount) : null;
    const shaped = rows
      .filter((r) => r.kind !== 'sales')
      .map((r) => costRow(r, r.claim || null))
      .filter((r) => !supplier || norm(r.supplier).includes(supplier) || norm(r.description).includes(supplier))
      .filter((r) => !owner || norm(r.owner).includes(owner) || norm(r.uploaded_by).includes(owner))
      .filter((r) => !b.date_from || r.date >= String(b.date_from))
      .filter((r) => !b.date_to || r.date <= String(b.date_to))
      .filter((r) => !state || STATE_FILTERS[state](r.state))
      .filter((r) => amount == null || Math.abs((r.amount ?? 0) - amount) < 0.005)
      .filter((r) => min == null || (r.amount ?? 0) >= min)
      .filter((r) => max == null || (r.amount ?? 0) <= max)
      .sort((x, y) => String(y.date).localeCompare(String(x.date)));
    const { offset, limit } = page(b);
    const slice = shaped.slice(offset, offset + limit);
    return { org: { id: ctx.org.id, name: ctx.org.name }, total: shaped.length, offset, has_more: offset + limit < shaped.length, next_offset: offset + limit < shaped.length ? offset + limit : null, costs: slice };
  },

  async get_cost(ctx, b) {
    const [bill] = billsFor(ctx, [b.item_id ?? b.id]);
    const got = await must(ctx, 'GET', `/api/costs/bills/${encodeURIComponent(bill.id)}`);
    const full = got.bill;
    const claim = claimMembership(ctx.org.id).get(bill.id) || null;
    return {
      cost: costRow(full, claim),
      fields: full,
      attachments: full.storageKey ? [{ file_name: full.fileName, content_type: full.contentType, url: costRow(full, claim).file_url }] : [],
      history: full.history || [],
    };
  },

  async list_expense_claims(ctx, b) {
    const who = norm(b.claim_for);
    const month = String(b.month ?? '').trim(); // YYYY-MM
    const status = norm(b.status);
    const rows = (await allClaims(ctx))
      .filter((c) => !who || norm(c.claimFor).includes(who))
      .filter((c) => !month || String(c.endDate || c.claimDate || '').startsWith(month))
      .filter((c) => !status || claimState(c) === status)
      .map((c) => claimSummary(c, ctx.org.id, false))
      .sort((x: any, y: any) => String(y.end_date).localeCompare(String(x.end_date)));
    const { offset, limit } = page(b);
    return { org: { id: ctx.org.id, name: ctx.org.name }, total: rows.length, offset, has_more: offset + limit < rows.length, claims: rows.slice(offset, offset + limit) };
  },

  async get_expense_claim(ctx, b) {
    return { claim: claimSummary(await oneClaim(ctx, String(b.claim_id ?? '')), ctx.org.id, true) };
  },

  async list_suppliers(ctx, b) {
    const by = new Map<string, { supplier: string; documents: number; last_date: string }>();
    for (const bill of listBills(ctx.org.id)) {
      if (bill.kind === 'sales' || !bill.supplier) continue;
      const k = norm(bill.supplier);
      const row = by.get(k) || { supplier: bill.supplier, documents: 0, last_date: '' };
      row.documents += 1;
      if (String(bill.date || '') > row.last_date) row.last_date = String(bill.date || '');
      by.set(k, row);
    }
    const all = [...by.values()].sort((x, y) => x.supplier.localeCompare(y.supplier));
    const { offset, limit } = page(b);
    return { total: all.length, offset, has_more: offset + limit < all.length, suppliers: all.slice(offset, offset + limit) };
  },

  // CYBills keeps no alias table (a merge rewrites the name), so "Tanda" is
  // found as the supplier its documents are filed under by searching what the
  // documents SAY: name, description, invoice number, file name.
  async search_suppliers(ctx, b) {
    const q = norm(b.q ?? b.query);
    if (q.length < 2) throw new AgentError(400, 'query_required', 'q must be at least two characters.');
    const hits = new Map<string, { supplier: string; matched_on: Set<string>; documents: number; example_item_id: string; example_text: string }>();
    for (const bill of listBills(ctx.org.id)) {
      if (bill.kind === 'sales') continue;
      const fields: Array<[string, string]> = [
        ['name', bill.supplier || ''],
        ['description', bill.description || ''],
        ['invoice_number', bill.invoiceNumber || ''],
        ['file_name', bill.fileName || ''],
      ];
      const on = fields.filter(([, v]) => norm(v).includes(q));
      if (!on.length) continue;
      const k = norm(bill.supplier) || '(no supplier)';
      const row = hits.get(k) || { supplier: bill.supplier || '', matched_on: new Set<string>(), documents: 0, example_item_id: bill.displayId, example_text: on[0][1].slice(0, 120) };
      on.forEach(([f]) => row.matched_on.add(f));
      row.documents += 1;
      hits.set(k, row);
    }
    return { query: q, suppliers: [...hits.values()].map((h) => ({ ...h, matched_on: [...h.matched_on] })).sort((x, y) => y.documents - x.documents).slice(0, 50) };
  },
};

// Every write answers with what it changed: before, and the claim(s) after.
async function afterClaims(ctx: Ctx, ids: string[]) {
  const all = await allClaims(ctx);
  return [...new Set(ids.filter(Boolean))].map((id) => {
    const c = all.find((x) => x.id === id);
    return c ? claimSummary(c, ctx.org.id, true) : { id, status: 'gone' };
  });
}

const RECORDS: Record<string, Handler> = {
  async create_claim(ctx, b) {
    const name = String(b.name ?? '').trim();
    if (!name) throw new AgentError(400, 'name_required', 'A claim needs a name.');
    const made = await must(ctx, 'POST', '/api/claims', { name, claimFor: b.claim_for || ctx.member.name, endDate: b.date || b.end_date || '' });
    return { created: true, claims: await afterClaims(ctx, [made.claim.id]) };
  },

  // Onto an existing claim (claim_id) or a new one (new_claim). A document on
  // another claim is MOVED, in the same write (claims.ts takeOffOtherClaims).
  async add_items_to_claim(ctx, b) {
    const bills = billsFor(ctx, b.item_ids);
    const before = membershipOf(ctx, bills);
    let claimId = String(b.claim_id ?? '').trim();
    if (!claimId) {
      const nc = b.new_claim || {};
      const name = String(nc.name ?? '').trim();
      if (!name) throw new AgentError(400, 'claim_required', 'Name claim_id, or new_claim { claim_for, name, date }.');
      const made = await must(ctx, 'POST', '/api/claims', { name, claimFor: nc.claim_for || ctx.member.name, endDate: nc.date || '' });
      claimId = made.claim.id;
    }
    const got = await must(ctx, 'POST', `/api/claims/${encodeURIComponent(claimId)}/items`, { items: bills.map(asTxn) });
    const touched = [claimId, ...(got.moved_from || []).map((m: any) => m.claimId), ...before.map((x) => x.claim_id || '')];
    return { before, moved_from: got.moved_from || [], claims: await afterClaims(ctx, touched) };
  },

  async move_items(ctx, b) {
    const from = String(b.from_claim ?? '').trim();
    const to = String(b.to_claim ?? '').trim();
    if (!from || !to) throw new AgentError(400, 'claims_required', 'Name from_claim and to_claim.');
    const bills = billsFor(ctx, b.item_ids);
    const before = membershipOf(ctx, bills);
    const strays = before.filter((x) => x.claim_id !== from);
    if (strays.length) {
      throw new AgentError(409, 'not_on_from_claim', `Not on that claim: ${strays.map((s) => `${s.item_id} (${s.claim_name || 'on no claim'})`).join(', ')}.`);
    }
    const got = await must(ctx, 'POST', `/api/claims/${encodeURIComponent(to)}/items`, { items: bills.map(asTxn) });
    return { before, moved_from: got.moved_from || [], claims: await afterClaims(ctx, [from, to]) };
  },

  async remove_items_from_claim(ctx, b) {
    const id = String(b.claim_id ?? '').trim();
    const bills = billsFor(ctx, b.item_ids);
    const before = membershipOf(ctx, bills);
    await must(ctx, 'POST', `/api/claims/${encodeURIComponent(id)}/items/remove`, { itemIds: bills.map((x) => x.id) });
    return { before, after: membershipOf(ctx, bills), claims: await afterClaims(ctx, [id]) };
  },

  async rename_claim(ctx, b) {
    const id = String(b.claim_id ?? '');
    const before = claimSummary(await oneClaim(ctx, id), ctx.org.id, false);
    await must(ctx, 'POST', `/api/claims/${encodeURIComponent(id)}/update`, { name: String(b.name ?? '') });
    return { before, claims: await afterClaims(ctx, [id]) };
  },

  async update_claim_date(ctx, b) {
    const id = String(b.claim_id ?? '');
    const before = claimSummary(await oneClaim(ctx, id), ctx.org.id, false);
    await must(ctx, 'POST', `/api/claims/${encodeURIComponent(id)}/update`, { endDate: String(b.date ?? b.end_date ?? '') });
    return { before, claims: await afterClaims(ctx, [id]) };
  },

  async archive_claim(ctx, b) {
    const id = String(b.claim_id ?? '');
    const before = claimSummary(await oneClaim(ctx, id), ctx.org.id, false);
    await must(ctx, 'POST', `/api/claims/${encodeURIComponent(id)}/archive`, { archived: b.archived !== false });
    return { before, claims: await afterClaims(ctx, [id]) };
  },

  async update_item(ctx, b) {
    const [bill] = billsFor(ctx, [b.item_id ?? b.id]);
    const patch: Record<string, string> = {};
    for (const [from, to] of [['category', 'category'], ['date', 'date'], ['supplier', 'supplier'], ['tax_rate', 'taxRate'], ['description', 'description']] as const) {
      if (typeof b[from] === 'string') patch[to] = b[from];
    }
    if (!Object.keys(patch).length) throw new AgentError(400, 'nothing_to_change', 'Give one of category, date, supplier, tax_rate, description.');
    return writeItem(ctx, bill, patch);
  },

  async set_item_owner(ctx, b) {
    const [bill] = billsFor(ctx, [b.item_id ?? b.id]);
    const owner = String(b.owner ?? '').trim();
    if (!owner) throw new AgentError(400, 'owner_required', 'Name the owner (an email or a person\'s name).');
    return writeItem(ctx, bill, { owner });
  },

  // Archive a document (never a delete). One on a claim is refused: the claim
  // is what says where it stands — take it off the claim first.
  async archive_cost(ctx, b) {
    const [bill] = billsFor(ctx, [b.item_id ?? b.id]);
    const claim = claimMembership(ctx.org.id).get(bill.id);
    if (claim) throw new AgentError(409, 'on_a_claim', `On claim "${claim.name}". Remove it from the claim first.`);
    return writeItem(ctx, bill, { status: 'archived' });
  },
};

async function writeItem(ctx: Ctx, bill: Bill, patch: Record<string, string>) {
  const claim = claimMembership(ctx.org.id).get(bill.id) || null;
  const before = costRow(bill, claim);
  await must(ctx, 'PATCH', `/api/costs/bills/${encodeURIComponent(bill.id)}`, patch);
  const fresh = getBillById(ctx.org.id, bill.id)!;
  const now = claimMembership(ctx.org.id).get(bill.id) || null;
  return { before, after: costRow(fresh, now), claims: now ? await afterClaims(ctx, [now.id]) : [] };
}

// Xero actions: a dry run unless `confirm: true`. The dry run says what would
// happen and to what, from the claim as it stands, and changes nothing.
const XERO: Record<string, Handler> = {
  async submit_claim(ctx, b) {
    const c = await oneClaim(ctx, String(b.claim_id ?? ''));
    if (b.confirm !== true) return dryRun('submit for approval', c, ctx);
    await must(ctx, 'POST', `/api/claims/${encodeURIComponent(c.id)}/submit`, {});
    return { done: 'submitted', claims: await afterClaims(ctx, [c.id]) };
  },

  async approve_claim(ctx, b) {
    const c = await oneClaim(ctx, String(b.claim_id ?? ''));
    if (b.confirm !== true) return dryRun('approve', c, ctx);
    await must(ctx, 'POST', `/api/claims/${encodeURIComponent(c.id)}/approve`, {});
    return { done: 'approved', claims: await afterClaims(ctx, [c.id]) };
  },

  async approve_and_publish_claim(ctx, b) {
    const c = await oneClaim(ctx, String(b.claim_id ?? ''));
    const status = String(b.xero_status ?? 'DRAFT').toUpperCase();
    if (b.confirm !== true) return dryRun(`approve, then publish to Xero as ${status}`, c, ctx);
    if (c.approvalStatus !== 'approved') await must(ctx, 'POST', `/api/claims/${encodeURIComponent(c.id)}/approve`, {});
    const published = await must(ctx, 'POST', `/api/xero/organisations/${encodeURIComponent(ctx.org.id)}/publish-claim`, { claimId: c.id, status });
    return { done: 'approved_and_published', xero: published, claims: await afterClaims(ctx, [c.id]) };
  },

  async publish_costs(ctx, b) {
    const bills = billsFor(ctx, b.item_ids);
    const status = String(b.xero_status ?? 'DRAFT').toUpperCase();
    const on = claimMembership(ctx.org.id);
    const [accounts, rates] = await Promise.all([accountsForOrg(WORKSPACE_ID, ctx.org.id), taxRatesForOrg(WORKSPACE_ID, ctx.org.id)]);
    const plan = bills.map((bill) => {
      const posting = postingCodesFrom(bill, accounts, rates, { gstRegistered: gstRegisteredFor(ctx.org.id) });
      const problem = on.get(bill.id)
        ? `on claim "${on.get(bill.id)!.name}" (it reaches Xero as a line of that claim)`
        : bill.xeroInvoiceId
          ? 'already in Xero'
          : !costComplete(bill)
            ? 'not ready (needs a date, category and total)'
            : !posting.ok
              ? posting.message || 'no account or tax code it can post to'
              : '';
      return { bill, posting, problem, row: { ...costRow(bill, on.get(bill.id) || null), account_code: posting.ok ? posting.accountCode : '', tax_type: posting.ok ? posting.taxType : '', problem } };
    });
    if (b.confirm !== true) {
      return {
        dry_run: true,
        would: `publish ${plan.filter((p) => !p.problem).length} document(s) to Xero as ${status}`,
        documents: plan.map((p) => p.row),
        say_confirm: 'Call again with confirm: true to publish.',
      };
    }
    const results = [];
    for (const p of plan) {
      if (p.problem || !p.posting.ok) {
        results.push({ id: p.bill.id, item_id: p.row.item_id, ok: false, problem: p.problem });
        continue;
      }
      const r = await call(ctx, 'POST', `/api/xero/organisations/${encodeURIComponent(ctx.org.id)}/publish-bill`, {
        billId: p.bill.id,
        accountCode: p.posting.accountCode,
        taxType: p.posting.taxType,
        status,
      });
      results.push({ id: p.bill.id, item_id: p.row.item_id, ok: r.status < 400, xero: r.body });
    }
    return { done: 'published', results };
  },
};

function dryRun(what: string, c: any, ctx: Ctx) {
  return {
    dry_run: true,
    would: `${what}: "${c.name}" for ${c.claimFor}`,
    claim: claimSummary(c, ctx.org.id, true),
    say_confirm: 'Call again with confirm: true to do it.',
  };
}

export const AGENT_ACTIONS = {
  read: Object.keys(READ),
  records: Object.keys(RECORDS),
  xero: Object.keys(XERO),
};

const HANDLERS: Record<string, Handler> = { ...READ, ...RECORDS, ...XERO };

// GET /api/agent/actions — what is here, by grant.
agentRouter.get('/actions', (req, res) => {
  if (!keyMatches(req.header('X-API-Key') || '')) return res.status(401).json({ error: 'bad_key' });
  res.json(AGENT_ACTIONS);
});

// POST /api/agent/:action — { tenant_id, acting_email, org_id?, ...fields }
agentRouter.post('/:action', async (req: Request, res: Response) => {
  if (!keyMatches(req.header('X-API-Key') || '')) return res.status(401).json({ error: 'bad_key', message: 'X-API-Key did not match.' });
  const handler = HANDLERS[req.params.action];
  if (!handler) return res.status(404).json({ error: 'unknown_action', actions: AGENT_ACTIONS });
  try {
    const ctx = contextFor(req);
    const out = await handler(ctx, req.body ?? {});
    return res.json({ ok: true, action: req.params.action, org: { id: ctx.org.id, name: ctx.org.name }, acting_as: ctx.member.email, ...(out as object) });
  } catch (err) {
    if (err instanceof AgentError) return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    console.error('[agent]', req.params.action, err);
    return res.status(500).json({ error: 'failed', message: (err as Error)?.message || String(err) });
  }
});
