import { getBillById, listBills, updateBill } from './store.js';
import { dataScopeForOrg } from './organisations.js';
import { readSetting, writeSetting } from './settings.js';
import { relay } from './xero.js';
import { findContact, gstCheckFor, gstRules, renameChecks, type Contact } from './gstCheck.js';

// "Use registered name" (Cze, 28 Nov 2026): an EXISTING supplier renamed to the
// name its GST number is registered to, one supplier at a time and only on a
// person's press. The Xero contact itself is renamed, so its bank details and
// history stay; this entity's documents, supplier rule, billing plans and
// supplier list move with it. Where Xero holds BOTH names as two contacts,
// nothing is done: Xero's API cannot merge them, and renaming CYBills alone
// would leave the two disagreeing.

export type RenameOutcome = {
  ok: boolean;
  status: number;
  message: string;
  from?: string;
  to?: string;
  documents?: number;
  xero?: 'renamed' | 'existing' | 'none';
};

const refuse = (status: number, message: string): RenameOutcome => ({ ok: false, status, message });
const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();

export async function renameToRegistered(
  ws: string,
  orgId: string,
  billId: string,
  tenantId: string
): Promise<RenameOutcome> {
  const scope = dataScopeForOrg(orgId);
  const rules = await gstRules();
  const bill = getBillById(scope, billId);
  const check = gstCheckFor(billId);
  if (!rules || !bill) return refuse(404, 'That document could not be found.');
  const from = String(bill.supplier ?? '').trim();
  const target = String(check?.registeredName ?? '').trim();
  // The name has to come from a NUMBER, and be about the supplier still on the
  // document: one found by name proves nothing about it.
  if (!check || !target || check.source === 'name' || !rules.sameSupplierName(check.supplier, from)) {
    return refuse(422, 'Press “Check again” first: there is no registered name for this supplier to use.');
  }
  if (rules.sameSupplierName(from, target)) return refuse(422, 'The supplier already carries its registered name.');

  const mine = await findContact(tenantId, from);
  const exact = await findContact(tenantId, target);
  const listed = await relay('Contacts', { tenantId, query: { where: 'IsSupplier==true AND ContactStatus=="ACTIVE"' } });
  if (mine === undefined || exact === undefined || !listed.ok) {
    return refuse(502, 'Xero could not be asked about this supplier’s contacts, so nothing was changed.');
  }
  const contacts: Contact[] = listed.data?.Contacts ?? [];
  const theirs = exact ?? contacts.find((c) => rules.sameSupplierName(c.Name, target)) ?? null;
  if (mine && theirs && theirs.ContactID !== mine.ContactID) {
    return refuse(
      409,
      `Xero already has a second contact, “${theirs.Name}”, so “${from}” can’t be renamed to it. Merge the two contacts in Xero first (Contacts, select both, Merge), then press this again.`
    );
  }
  // Already merged or renamed in Xero: take the spelling Xero holds.
  const to = !mine && theirs ? String(theirs.Name ?? target).trim() : target;
  let xero: RenameOutcome['xero'] = theirs ? 'existing' : 'none';
  if (mine?.ContactID && !theirs) {
    const result = await relay('Contacts', { method: 'POST', tenantId, body: { Contacts: [{ ContactID: mine.ContactID, Name: to }] } });
    const made = (result.data?.Contacts ?? [])[0];
    if (!result.ok || made?.HasValidationErrors) {
      const why = made?.ValidationErrors?.[0]?.Message || (result.ok ? '' : result.message) || 'Xero did not accept the new name.';
      return refuse(422, `Xero did not rename the contact, so nothing was changed: ${why}`);
    }
    xero = 'renamed';
  }

  // The documents, published ones included: the contact they sit on in Xero now
  // reads the new name, and an Update in Xero under the old one would make a
  // second contact.
  let documents = 0;
  for (const b of listBills(scope)) {
    if (b.kind === 'sales' || b.status === 'deleted' || lower(b.supplier) !== lower(from)) continue;
    if (updateBill(scope, b.id, { supplier: to, supplierPrintedName: '' })) documents += 1;
  }
  moveSettings(ws, orgId, from, to);
  renameChecks(orgId, from, to);
  return { ok: true, status: 200, message: '', from, to, documents, xero };
}

// The supplier's standing rule, billing plans and list entries, under its new name.
function moveSettings(ws: string, orgId: string, from: string, to: string): void {
  const ruleMap = readSetting<Record<string, unknown>>(ws, 'cybills.supplier.rules.v1', orgId);
  const oldKey = Object.keys(ruleMap ?? {}).find((k) => lower(k) === lower(from));
  if (ruleMap && oldKey) {
    const next = { ...ruleMap };
    // A rule already written for the new name is the one that stands.
    if (!Object.keys(next).some((k) => lower(k) === lower(to))) next[to] = next[oldKey];
    delete next[oldKey];
    writeSetting(ws, 'cybills.supplier.rules.v1', orgId, next);
  }

  const book = readSetting<{ plans?: Array<{ supplier?: string }> }>(ws, 'cybills.billing-plans.v1', orgId);
  if (book?.plans?.some((p) => lower(p.supplier) === lower(from))) {
    writeSetting(ws, 'cybills.billing-plans.v1', orgId, {
      ...book,
      plans: book.plans.map((p) => (lower(p.supplier) === lower(from) ? { ...p, supplier: to } : p)),
    });
  }

  // As a merge on the Suppliers page records it (recordSupplierMerge): the old
  // spelling leaves the list, and a read under it is filed under the new one.
  type List = { removed?: string[]; added?: string[]; merged?: Record<string, string>; notDuplicates?: string[] };
  const list = readSetting<List>(ws, 'cybills.supplier-list.v1', orgId) || {};
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(list.merged ?? {})) {
    if (lower(k) !== lower(to)) merged[k] = lower(v) === lower(from) ? to : v;
  }
  merged[lower(from)] = to;
  const removed = (list.removed ?? []).filter((n) => lower(n) !== lower(to) && lower(n) !== lower(from));
  writeSetting(ws, 'cybills.supplier-list.v1', orgId, {
    ...list,
    removed: [...removed, from],
    added: (list.added ?? []).map((n) => (lower(n) === lower(from) ? to : n)),
    merged,
  });
}
