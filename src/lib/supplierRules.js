// Per-supplier standing rules — the defaults CYBills applies to every document
// that arrives from that supplier (category, customer, project, currency, tax
// rate, payment, due-date terms, description). Mirrors Dext's supplier-rules
// editor, and is the cost-side twin of customerRules.js.
//
// Keyed by the supplier's name (the Suppliers list uses the Xero contact name
// as its id), so a document's read supplier resolves straight to its rule.
// Applied when a document is read: a rule here is an instruction, so it
// outranks anything the reader worked out for itself.

import { useEffect, useState } from 'react';
import { blobStore } from '@/lib/blobStore';
import { computeDueDate, DUE_MODES } from '@/lib/extractionSettings';
import { INVOICE_DATE_MODES, ruleInvoiceDate } from '@/lib/ruleDate';

// The same currency list the sales-side rules offer — one list, so a rule reads
// the same whichever side of the ledger it was written on.
export { CURRENCIES } from '@/lib/customerRules';

const KEY = 'cybills.supplier.rules.v1';
export const SUPPLIER_RULES_EVENT = 'cybills:supplier-rules-changed';
const emit = () => window.dispatchEvent(new Event(SUPPLIER_RULES_EVENT));
const store = blobStore(KEY, {}, emit, { perOrg: true });

function read() {
  return store.get() || {};
}
function write(map) {
  store.set(map);
  emit();
}

const norm = (name) => String(name || '').trim().toLowerCase();

// The key a supplier name is already stored under, matched without regard to
// case or surrounding space — the reader's spelling won't always be
// byte-identical to the Xero contact the rule was written against.
function existingKey(map, name) {
  if (!norm(name)) return '';
  if (map[name]) return name;
  return Object.keys(map).find((k) => norm(k) === norm(name)) || '';
}

// A blank rule — the shape every consumer can rely on. Everything is opt-in:
// a blank field means "no instruction", so the reader's own answer stands.
export function emptySupplierRule() {
  return {
    category: '',
    customer: '',
    project: '',
    currency: '',
    taxRate: '',
    paymentMethod: '',
    paid: '', // '' = follow Extraction settings; else 'Paid' / 'Not paid'
    dueMode: '', // '' = follow Extraction settings; else a DUE_MODES value
    dueDays: '',
    // '' = the date printed on the document; 'endOfPreviousMonth' = the last day
    // of the month before it, for a supplier that invoices after the period it
    // bills for (src/lib/ruleDate.js). The due date stays as printed.
    invoiceDate: '',
    description: '',
    extractLineItems: false,
    // Publish to Xero after reading, and as what: '' = follow Extraction
    // settings (uploads only, as Awaiting approval), 'AUTHORISED' / 'SUBMITTED'
    // = publish at that status on EVERY road a document arrives by, 'never' =
    // not even when the entity's switch is on. Not a field of any document, so
    // never in supplierRulePatch; read by autoPublish.js and, for emailed and
    // WhatsApp'd documents, server/src/autoPublishRule.ts.
    autoPublish: '',
    // The supplier's Singapore GST registration number, typed by a person for
    // the supplier whose number the reader keeps missing. Not a field of any
    // document — it is EVIDENCE the server hands the tax decision when a read
    // found no number of its own (server/src/supplierGst.ts), so it never
    // appears in supplierRulePatch.
    gstRegNo: '',
  };
}

export const SUPPLIER_DUE_MODES = DUE_MODES;
export const SUPPLIER_PAID_OPTIONS = ['Paid', 'Not paid'];
export const SUPPLIER_INVOICE_DATE_OPTIONS = INVOICE_DATE_MODES;
export const SUPPLIER_AUTO_PUBLISH_OPTIONS = [
  { value: 'AUTHORISED', label: 'Publish as Approved (awaiting payment)' },
  { value: 'SUBMITTED', label: 'Publish as Awaiting approval' },
  { value: 'never', label: 'Never publish automatically' },
];

// The rule for a supplier NAME — the one it was stored under, or the one
// written against a differently-cased spelling of the same name.
export function matchSupplierRule(name) {
  const map = read();
  const key = existingKey(map, name);
  return key ? map[key] : {};
}
export const getSupplierRule = matchSupplierRule;

// Merge a partial change into a supplier's rule (the inline edits on the
// Suppliers list).
export function setSupplierRule(id, patch) {
  const map = read();
  const key = existingKey(map, id) || id;
  map[key] = { ...(map[key] || {}), ...patch };
  write(map);
}

// Replace a supplier's whole rule (the rules editor).
export function saveSupplierRule(name, rule) {
  if (!norm(name)) return;
  const map = read();
  const key = existingKey(map, name) || String(name).trim();
  map[key] = { ...emptySupplierRule(), ...rule };
  write(map);
}

export function clearSupplierRule(name) {
  const map = read();
  const key = existingKey(map, name);
  if (!key) return;
  delete map[key];
  write(map);
}

// How many instructions a rule actually carries — 0 means "no rule yet", which
// is what the "Set supplier rules" links use to label themselves.
export function supplierRuleCount(rule) {
  const r = rule || {};
  return Object.entries(r).filter(([k, v]) => {
    if (k === 'dueDays') return false; // only meaningful alongside dueMode
    if (typeof v === 'boolean') return v;
    return String(v || '').trim() !== '';
  }).length;
}

export function hasSupplierRule(name) {
  return supplierRuleCount(matchSupplierRule(name)) > 0;
}

// The field patch a rule implies for a cost document. Only the fields the rule
// actually sets appear, so a caller can spread it over what it already has and
// the rule wins there and only there. Keys match both the detail form's `data`
// and the server's bill fields, so the same patch drives either.
export function supplierRulePatch(rule, { invoiceDate = '', gstRegistered = true, keepMonthEnd = false } = {}) {
  const r = { ...emptySupplierRule(), ...(rule || {}) };
  const p = {};
  for (const k of ['category', 'customer', 'project', 'currency', 'paymentMethod', 'description']) {
    if (String(r[k] || '').trim()) p[k] = r[k];
  }
  // Not GST-registered → every document codes to No Tax, and a rule doesn't get
  // to overrule the registration.
  if (gstRegistered && String(r.taxRate || '').trim()) p.taxRate = r.taxRate;
  if (r.paid) p.paid = r.paid === 'Paid';
  // Payment terms run from the date the supplier actually invoiced, so they are
  // worked out before the rule moves that date.
  const due = r.dueMode ? computeDueDate(r.dueMode, r.dueDays, invoiceDate) : '';
  if (due) p.dueDate = due;
  const date = ruleInvoiceDate(r.invoiceDate, invoiceDate, { keepMonthEnd });
  if (date && date !== invoiceDate) {
    p.date = date;
    // The day the supplier actually invoiced is still a fact worth keeping. A
    // "due on receipt" invoice is read with no due date of its own (one equal to
    // the invoice date is dropped), so once the date moves it would leave
    // nothing on the document saying 2 September — kept as the due date instead,
    // unless payment terms have already given one.
    if (!p.dueDate) p.dueDate = invoiceDate;
  }
  return p;
}

// Why a document was allocated the way it was — shown under the Reason fields,
// so a rule's decision reads as a decision and not as the reader's guess.
export function supplierRuleProjectReason(rule, supplier) {
  const project = String(rule?.project || '').trim();
  if (!project) return '';
  return `Standing rule: everything from ${supplier || 'this supplier'} goes to ${project}.`;
}
export function supplierRuleCategoryReason(rule, supplier) {
  const category = String(rule?.category || '').trim();
  if (!category) return '';
  return `Standing rule: everything from ${supplier || 'this supplier'} is coded to ${category}.`;
}

// Re-render a component when rules change / hydrate. Sync getters still work
// off the in-memory cache.
export function useSupplierRules() {
  const [v, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((n) => n + 1);
    window.addEventListener(SUPPLIER_RULES_EVENT, sync);
    return () => window.removeEventListener(SUPPLIER_RULES_EVENT, sync);
  }, []);
  return v;
}
