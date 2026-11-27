import { env } from './env.js';
import { loadCollection, saveCollection } from './jsonStore.js';
import { getBillById, listBills, updateBill, reconcileReadiness, type Bill } from './store.js';
import { getOrganisation } from './organisations.js';
import { readSetting } from './settings.js';
import { keepPracticeNoTax } from './practiceNoTax.js';
import { relay } from './xero.js';

// The IRAS GST register check on a cost (Cze, 27 Nov 2026). The rules are
// src/lib/gstRegisterCheck.js (pure, loaded by path, so the browser and the
// server cannot differ); this file keeps the answers, asks cyworkspace, holds
// an unsupported cost at No Tax and writes the numbers to the Xero contact.
//
// IRAS's answer is kept HERE, in its own collection, and never on the bill: it
// is shown to the practice's own team only. The bill carries only `gstHold`,
// the key of a check that holds it at No Tax.

type Rules = {
  gstCheckKey: (doc: unknown) => string;
  gstCheckApplies: (doc: unknown) => boolean;
  gstCheckAsk: (doc: unknown, contactNumber?: string) => { source: string; body: Record<string, string> };
  judgeGstAnswer: (answer: unknown, ctx: { source: string; supplier: string }) => {
    verdict: string; hold: boolean; autoSave: boolean; confirmable: boolean; nameMatches: boolean;
  };
  contactGstPatch: (contact: unknown, numbers: { gstRegNo: string; uen: string }) => Record<string, string>;
};

let rulesPromise: Promise<Rules | null> | null = null;
export function gstRules(): Promise<Rules | null> {
  rulesPromise ??= import(new URL('../../src/lib/gstRegisterCheck.js', import.meta.url).href)
    .then((m) => (typeof m?.gstCheckApplies === 'function' ? (m as Rules) : null))
    .catch((e) => {
      console.error('[gstCheck] rules unavailable', e);
      return null;
    });
  return rulesPromise;
}

export type GstCheck = {
  id: string; // the bill's id
  scope: string;
  orgId: string; // the entity
  key: string;
  supplier: string;
  checkedAt: string;
  // 'contact_has_number': nothing was asked, the Xero contact already holds one.
  skipped?: 'contact_has_number';
  source?: string;
  matched?: boolean;
  verdict?: string;
  hold?: boolean;
  autoSave?: boolean;
  confirmable?: boolean;
  nameMatches?: boolean;
  outcome?: string;
  gstRegNo?: string;
  uen?: string;
  irasName?: string;
  registeredFrom?: string;
  registeredTo?: string;
  // Written to the Xero contact.
  saved?: { at: string; by: string; contactId: string; fields: string[] };
  saveError?: string;
  // A person pressed Save: the number is this supplier's, for this entity.
  confirmed?: boolean;
};

const COLLECTION = 'gst-checks';
const all = () => loadCollection<GstCheck>(COLLECTION);
export const gstCheckFor = (billId: string): GstCheck | null => all().find((c) => c.id === billId) ?? null;
function store(check: GstCheck): GstCheck {
  saveCollection(COLLECTION, [...all().filter((c) => c.id !== check.id), check]);
  return check;
}

/** The number a person confirmed for this supplier in this entity, '' when none. */
export function confirmedGstRegNo(orgId: string, sameSupplier: (name: string) => boolean): string {
  const hit = all()
    .filter((c) => c.orgId === orgId && c.confirmed && c.gstRegNo && sameSupplier(c.supplier))
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  return hit?.gstRegNo ?? '';
}

// A Singapore entity registered for GST, with a Xero of its own. Anything else
// claims no Singapore input tax, or has no contact to look at.
function entityTenant(ws: string, orgId: string): string {
  const organisation = getOrganisation(ws, orgId);
  if (!organisation?.tenantId) return '';
  const profile = readSetting<{ gstRegistered?: string; country?: string }>(ws, 'cybills.business-profile.v1', orgId);
  if (String(profile?.gstRegistered || 'Yes').toLowerCase() === 'no') return '';
  if (profile?.country && profile.country !== 'Singapore') return '';
  return organisation.tenantId;
}

type Contact = { ContactID?: string; Name?: string; TaxNumber?: string; CompanyNumber?: string };

/** The Xero contact of that name; null when there is none; undefined when Xero could not say. */
async function findContact(tenantId: string, name: string, contactId = ''): Promise<Contact | null | undefined> {
  if (contactId) {
    const r = await relay(`Contacts/${encodeURIComponent(contactId)}`, { tenantId });
    return r.ok ? ((r.data?.Contacts ?? [])[0] ?? null) : undefined;
  }
  if (!name) return undefined;
  // A name holding a double quote cannot be put in a Xero filter: searched for,
  // and matched here.
  const quoted = name.includes('"');
  const query: Record<string, string> = quoted ? { searchTerm: name } : { where: `Name=="${name}"` };
  const r = await relay('Contacts', { tenantId, query });
  if (!r.ok) return undefined;
  const found: Contact[] = r.data?.Contacts ?? [];
  return (quoted ? found.find((c) => String(c.Name ?? '').toLowerCase() === name.toLowerCase()) : found[0]) ?? null;
}

// After an answer that could not be had (Xero or cyworkspace down, IRAS's limit),
// the sweep leaves that document alone for a while. Per document, so one that
// keeps failing does not hold up anybody else's.
const RETRY_MS = 60 * 60_000;
const retryAfter = new Map<string, number>();
const waiting = (billId: string) => (retryAfter.get(billId) ?? 0) > Date.now();

async function askCyws(body: Record<string, string>): Promise<any | null> {
  if (!env.CYWORKSPACE_RELAY_URL || !env.CYWORKSPACE_API_KEY) return null;
  try {
    const res = await fetch(`${env.CYWORKSPACE_RELAY_URL.replace(/\/+$/, '')}/api/webhooks/cybills/gst-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': env.CYWORKSPACE_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => null);
    return res.ok && data?.available === true ? data : null;
  } catch (err) {
    console.error('[gstCheck] cyworkspace unreachable', err);
    return null;
  }
}

export type GstCheckRun = {
  check: GstCheck | null;
  // The run put the document to No Tax just now.
  changed: boolean;
};

const running = new Map<string, Promise<GstCheckRun>>();

/**
 * Check one cost, if it needs it. Never throws, and an answer that cannot be had
 * changes nothing. `force` asks again though this question was already answered.
 */
export function runGstCheck(ws: string, orgId: string, scope: string, billId: string, opts: { force?: boolean } = {}): Promise<GstCheckRun> {
  const already = running.get(billId);
  if (already) return already;
  const p = check(ws, orgId, scope, billId, opts)
    .catch((err): GstCheckRun => {
      console.error('[gstCheck] failed', billId, err);
      return { check: null, changed: false };
    })
    .finally(() => running.delete(billId));
  running.set(billId, p);
  return p;
}

async function check(ws: string, orgId: string, scope: string, billId: string, opts: { force?: boolean }): Promise<GstCheckRun> {
  const none = { check: gstCheckFor(billId), changed: false };
  const rules = await gstRules();
  if (!rules) return none;
  const bill = getBillById(scope, billId);
  if (!bill || !rules.gstCheckApplies(bill)) return none;
  const tenantId = entityTenant(ws, orgId);
  if (!tenantId) return none;
  const key = rules.gstCheckKey(bill);
  const prior = gstCheckFor(billId);
  if (!opts.force && prior?.key === key) return { check: prior, changed: false };

  const supplier = String(bill.supplier ?? '').trim();
  const contact = await findContact(tenantId, supplier);
  if (contact === undefined) {
    retryAfter.set(billId, Date.now() + RETRY_MS);
    return none;
  }
  const base = { id: billId, scope, orgId, key, supplier, checkedAt: new Date().toISOString() };
  // A contact that holds a number is not checked by itself. A person pressing
  // Check is asking anyway, with that number where the document gives none.
  const held = String(contact?.TaxNumber ?? '').trim();
  if (held && !opts.force) {
    const changed = await applyHold(scope, billId, '');
    return { check: store({ ...base, skipped: 'contact_has_number' }), changed };
  }

  const ask = rules.gstCheckAsk(bill, held);
  const answer = await askCyws(ask.body);
  if (!answer) {
    retryAfter.set(billId, Date.now() + RETRY_MS);
    return none;
  }
  const judged = rules.judgeGstAnswer(answer, { source: ask.source, supplier });
  const r = answer.result ?? {};
  const saved = store({
    ...base,
    ...judged,
    source: ask.source,
    matched: Boolean(answer.matched),
    outcome: String(r.outcome ?? ''),
    gstRegNo: String(r.gst_reg_no ?? ''),
    uen: String(r.registration_id || answer.acra?.uen || ''),
    irasName: String(r.name ?? ''),
    registeredFrom: String(r.registered_from ?? ''),
    registeredTo: String(r.registered_to ?? ''),
    checkedAt: String(r.checked_at || base.checkedAt),
  });
  const changed = await applyHold(scope, billId, judged.hold ? key : '');
  return { check: saved, changed };
}

// Put the hold on (No Tax, through the same road as the practice's other No Tax
// rules) or take it off. Taking it off changes no tax code: the next read, or a
// person, picks one.
async function applyHold(scope: string, billId: string, key: string): Promise<boolean> {
  const current = getBillById(scope, billId);
  if (!current || current.xeroInvoiceId) return false;
  if (!key) {
    if (current.gstHold) updateBill(scope, billId, { gstHold: '' });
    return false;
  }
  const patch: Record<string, unknown> = { gstHold: key };
  const changed = await keepPracticeNoTax(current, patch);
  updateBill(scope, billId, patch);
  if (changed) reconcileReadiness(scope, billId);
  return changed;
}

export type GstContactSave = { ok: boolean; fields: string[]; message?: string };

/**
 * Write the checked numbers to the supplier's Xero contact, making the contact
 * when there is none (a publish would make it a moment later, without them).
 * A value the contact already holds is never replaced.
 */
export async function saveGstToContact(
  billId: string,
  tenantId: string,
  opts: { by: string; contactId?: string; confirmed?: boolean }
): Promise<GstContactSave> {
  const rules = await gstRules();
  const kept = gstCheckFor(billId);
  if (!rules || !kept?.gstRegNo || kept.verdict !== 'registered') {
    return { ok: false, fields: [], message: 'There is no registered GST number to save for this document.' };
  }
  const fail = (message: string): GstContactSave => {
    store({ ...kept, saveError: message });
    return { ok: false, fields: [], message };
  };
  const contact = await findContact(tenantId, kept.supplier, opts.contactId);
  if (contact === undefined) return fail('Xero could not be asked for this supplier’s contact.');
  const patch = rules.contactGstPatch(contact, { gstRegNo: kept.gstRegNo, uen: kept.uen ?? '' });
  const fields = Object.keys(patch);
  let contactId = String(contact?.ContactID ?? '');
  // Nothing to write when the contact already holds numbers of its own.
  if (fields.length) {
    const result = contact?.ContactID
      ? await relay('Contacts', { method: 'POST', tenantId, body: { Contacts: [{ ContactID: contact.ContactID, ...patch }] } })
      : await relay('Contacts', { method: 'PUT', tenantId, body: { Contacts: [{ Name: kept.supplier, ...patch }] } });
    if (!result.ok) return fail(result.message || 'Xero did not accept the contact change.');
    contactId ||= String((result.data?.Contacts ?? [])[0]?.ContactID ?? '');
  }
  store({ ...kept, saveError: '', confirmed: kept.confirmed || opts.confirmed === true, saved: { at: new Date().toISOString(), by: opts.by, contactId, fields } });
  return { ok: true, fields };
}

// Over the inbox: documents whose read or edit has not been checked. Only ones
// captured from the day the check began, so the standing backlog does not spend
// IRAS's limit; an older document is checked when it is published.
const SWEEP_FROM = '2026-11-27';
const SWEEP_AT_ONCE = 3;
let sweeping = false;
export async function sweepGstChecks(ws: string, orgId: string, scope: string): Promise<number> {
  if (sweeping || !env.CYWORKSPACE_API_KEY) return 0;
  const rules = await gstRules();
  if (!rules || !entityTenant(ws, orgId)) return 0;
  sweeping = true;
  try {
    const due = listBills(scope).filter(
      (b: Bill) =>
        ['new', 'ready', 'review'].includes(String(b.status)) &&
        String(b.createdAt ?? '') >= SWEEP_FROM &&
        rules.gstCheckApplies(b) &&
        !waiting(b.id) &&
        gstCheckFor(b.id)?.key !== rules.gstCheckKey(b)
    );
    for (const b of due.slice(0, SWEEP_AT_ONCE)) {
      // eslint-disable-next-line no-await-in-loop -- gentle on IRAS and Xero
      await runGstCheck(ws, orgId, scope, b.id);
      // No answer to be had just now: the rest wait for a later pass.
      if (waiting(b.id)) break;
    }
    return Math.min(due.length, SWEEP_AT_ONCE);
  } finally {
    sweeping = false;
  }
}
