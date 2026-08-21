import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// Business settings → Extraction. A shared, server-backed settings blob that
// actually drives behaviour (was previously an all-display form that never
// saved). Read by: the Costs/Sales inboxes (tab visibility), the Add-documents
// flow (default tax rate, default paid status, extract-tax, due dates), and the
// Xero publish path (due date).

const KEY = 'cybills.extraction-settings.v1';
export const EXTRACTION_SETTINGS_EVENT = 'cybills:extraction-settings-changed';

export const DUE_MODES = [
  'A number of days after the invoice date',
  'End of the following month',
  'On the invoice date',
];
export const DUE_DAYS = ['7', '14', '30', '60'];
export const DUP_MODES = ['Automatic', 'Review manually', 'Off'];
export const PAID_OPTIONS = ['Not paid', 'Paid'];

export const DEFAULT_EXTRACTION_SETTINGS = {
  showReviewReadyTabs: true,
  // Which engine reads this client entity's documents: 'claude', 'openai', or
  // '' for whatever the server defaults to. Blank by default so nothing changes
  // for a workspace that never opens the setting, and so a deploy that switches
  // its own default (LLM_PROVIDER) carries every untouched org with it.
  readerProvider: '',
  duplicateMode: 'Automatic',
  extractTax: true,
  // Post a document to Xero as Awaiting Approval as soon as it's been read —
  // see autoPublish.js for the conditions it insists on first. OFF by default:
  // publishing writes to a live ledger and finishes the document (it archives,
  // and can no longer go on an expense claim), so nobody should get that
  // without asking for it.
  //
  // Deliberately a NEW key. The old `autoPublishXero` was on by default, and
  // saving anything on the Extraction page persisted `true` into the settings
  // blob — so flipping the default alone would have left it running for every
  // workspace that had ever opened that page. The old key is simply ignored;
  // the rest of the blob is untouched.
  publishToXeroAfterReading: false,
  defaultTaxRateCosts: '', // '' = None; otherwise a tax-rate name from the list
  defaultTaxRateSales: '',
  dueCostsMode: DUE_MODES[0],
  dueCostsDays: '30',
  dueSalesMode: DUE_MODES[0],
  dueSalesDays: '7',
  payReceipts: 'Not paid',
  payInvoices: 'Not paid',
  payCreditNotes: 'Not paid',
};

const emit = () => window.dispatchEvent(new Event(EXTRACTION_SETTINGS_EVENT));
const store = blobStore(KEY, DEFAULT_EXTRACTION_SETTINGS, emit, { perOrg: true });

export function getExtractionSettings() {
  return { ...DEFAULT_EXTRACTION_SETTINGS, ...(store.get() || {}) };
}

export function saveExtractionSettings(next) {
  store.set({ ...DEFAULT_EXTRACTION_SETTINGS, ...next });
  emit();
}

export function useExtractionSettings() {
  const [s, setS] = useState(getExtractionSettings);
  useEffect(() => {
    const sync = () => setS(getExtractionSettings());
    window.addEventListener(EXTRACTION_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(EXTRACTION_SETTINGS_EVENT, sync);
  }, []);
  return s;
}

// The default paid flag for a freshly-added document, by its document type.
// Credit notes / receipts / invoices each have their own setting; anything else
// follows the receipts default.
export function defaultPaidFor(settings, documentType) {
  const t = String(documentType || '').toLowerCase();
  const pick = t.includes('credit') ? settings.payCreditNotes
    : t.includes('invoice') ? settings.payInvoices
    : settings.payReceipts;
  return pick === 'Paid';
}

// Compute an ISO (YYYY-MM-DD) due date from an invoice date + the configured
// mode/days. Returns '' when the invoice date isn't a real date.
export function computeDueDate(mode, days, invoiceDate) {
  const iso = String(invoiceDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(base.getTime())) return '';
  if (mode === 'On the invoice date') {
    // no change
  } else if (mode === 'End of the following month') {
    // last day of the month after the invoice month
    base.setUTCMonth(base.getUTCMonth() + 2, 0);
  } else {
    // "A number of days after the invoice date"
    base.setUTCDate(base.getUTCDate() + (Number(days) || 0));
  }
  return base.toISOString().slice(0, 10);
}

// Due date for a new cost/sales doc from the current settings + invoice date.
export function dueDateForNewDoc(settings, kind, invoiceDate) {
  return kind === 'sales'
    ? computeDueDate(settings.dueSalesMode, settings.dueSalesDays, invoiceDate)
    : computeDueDate(settings.dueCostsMode, settings.dueCostsDays, invoiceDate);
}

// --- Auto-pickable tax codes ------------------------------------------------
// The ONLY codes CYBills is allowed to choose on its own: standard-rated
// purchases and supplies at 7% / 8% / 9% (the 2022 / 2023 / current vintages),
// plus No Tax. Everything else the org has in Xero — imports, IGDS, partially
// exempt traders, reverse charge, bad debt relief, customer accounting — is a
// judgement call about the underlying transaction that a percentage can't
// settle, so auto-population never reaches for it and a human picks it from the
// dropdown instead.
//
// Matched on the Xero TaxType (stable: INPUT / INPUTY23 / INPUTY24, OUTPUT /
// OUTPUTY23 / OUTPUTY24, NONE), falling back to the name for manually-added
// rates that carry no code. The regexes are anchored so near-misses in the same
// chart — BLINPUT2 (Disallowed Expenses), EPINPUT, ZERORATEDINPUT — never slip
// through.
const AUTO_PURCHASE = { code: /^INPUT(Y\d{2})?$/i, name: /^(\d{4}\s+)?standard[- ]?rated purchases$/i };
const AUTO_SUPPLY = { code: /^OUTPUT(Y\d{2})?$/i, name: /^(\d{4}\s+)?standard[- ]?rated supplies$/i };
const AUTO_NO_TAX = { code: /^NONE$/i, name: /^no tax$/i };

const autoMatches = (rule, row) => {
  const code = String(row?.code || '').trim();
  return code ? rule.code.test(code) : rule.name.test(String(row?.name || '').trim());
};

// Infer the tax-rate NAME for an extracted document from its total + tax amounts,
// matched against the org's visible tax rates (`rates` = [{name, code, rate}]),
// its currency, and whether it's a cost (purchases) or a sales (supplies) doc.
// Only ever returns one of the auto-pickable codes above, or the configured
// default — never an import / exempt / reverse-charge code.
//
// When tax is charged, pick the standard-rated vintage whose % matches the
// effective rate (tax / net) closely — tight tolerance so a 10% AU invoice never
// snaps to a 9% SG rate, and so 7% / 8% / 9% each land on their own year.
// Currency-aware: a FOREIGN-currency invoice (≠ base, default SGD) whose exact
// rate isn't in the chart gets No Tax, because foreign GST isn't domestic input
// tax. Tax charged at a rate no standard-rated code matches is left BLANK for a
// human — that's import GST, reverse charge or partial exemption territory. With
// no tax, use the configured default, then No Tax. `opts` is
// { defaultName, currency, baseCurrency, kind }.
export function inferTaxRateName(total, tax, rates, opts = {}) {
  const { defaultName = '', currency = '', baseCurrency = 'SGD', kind = 'cost' } = opts;
  const t = Number(String(total ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const x = Number(String(tax ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const list = Array.isArray(rates) ? rates : [];
  const net = t - x;
  const cur = String(currency || '').toUpperCase().slice(0, 3);
  const base = String(baseCurrency || 'SGD').toUpperCase().slice(0, 3);
  const isForeign = Boolean(cur) && Boolean(base) && cur !== base;
  // Sales docs code to supplies (output tax), everything else to purchases.
  const wanted = kind === 'sales' ? AUTO_SUPPLY : AUTO_PURCHASE;
  const noTax = list.find((r) => Number(r.rate) === 0 && autoMatches(AUTO_NO_TAX, r));
  const useDefault = () => (defaultName && list.some((r) => r.name === defaultName) ? defaultName : '');
  if (x > 0 && net > 0) {
    const pct = (x / net) * 100;
    let best = '';
    let bestDiff = Infinity;
    for (const r of list) {
      const rate = Number(r.rate);
      if (!(rate > 0) || !autoMatches(wanted, r)) continue;
      const d = Math.abs(rate - pct);
      if (d < bestDiff) { bestDiff = d; best = r.name; }
    }
    // Tight tolerance: only a genuinely-matching standard rate (e.g. 9% ~ 9%).
    if (best && bestDiff <= 0.6) return best;
    // Foreign-currency invoice whose exact rate isn't in our chart: the tax is
    // foreign GST, not SG input tax, so claim nothing.
    if (isForeign && noTax) return noTax.name;
    // Domestic tax at some other rate — an import, reverse-charge or partially
    // exempt treatment. Not ours to guess: leave it for the reviewer.
    return '';
  }
  // No tax charged: honour the configured default, else No Tax.
  return useDefault() || (noTax ? noTax.name : '');
}

// The one place a document's tax rate is decided, so every entry point (upload,
// re-read, merge) applies the same precedence:
//
//   1. Not GST-registered  → "No Tax", always. Nothing to claim, nothing to
//      analyse (Business profile → GST registered?).
//   2. A rule the org wrote → the extractor matched this document against a tax
//      rate's "when to use" rule (Lists → Tax rates). Only ever a rate that is
//      visible, so a hidden code can't come back through the model.
//   3. Arithmetic          → the standard-rated code matching the printed GST,
//      or the configured default. See inferTaxRateName.
//
// `suggested` is the model's pick (may be ''), `gstRegistered` the profile flag.
export function resolveTaxRate({ total, tax, rates, suggested = '', gstRegistered = true, ...opts }) {
  const list = Array.isArray(rates) ? rates : [];
  if (!gstRegistered) return noTaxRateName(list);
  const picked = String(suggested || '').trim();
  if (picked && list.some((r) => r.name === picked)) return picked;
  return inferTaxRateName(total, tax, list, opts);
}

// The org's zero-rated "No Tax" code, by name — '' when the list doesn't have
// one (it's hidden, or Xero isn't connected yet). The single answer for a
// company that isn't GST-registered, so every screen agrees on it.
export function noTaxRateName(rates) {
  const row = (Array.isArray(rates) ? rates : []).find(
    (r) => Number(r.rate) === 0 && autoMatches(AUTO_NO_TAX, r),
  );
  return row ? row.name : '';
}
