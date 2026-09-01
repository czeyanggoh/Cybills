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

// What a bill is posted AS when somebody publishes it, in Xero's own words. The
// three are not shades of one thing: a DRAFT is not in the ledger's numbers at
// all, SUBMITTED is sitting in somebody's approval queue, and only an AUTHORISED
// bill can take a payment — which is why the payment run publishes at that
// status and nothing else would let the money leave.
export const PUBLISH_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Awaiting approval' },
  { value: 'AUTHORISED', label: 'Approved (awaiting payment)' },
];
export const publishStatusLabel = (value) =>
  PUBLISH_STATUSES.find((o) => o.value === value)?.label || PUBLISH_STATUSES[0].label;
// What a merge SUGGESTION does. Detection runs continuously either way; this
// says whether the strongest tier acts on its own.
//
//   Automatic      — a group tied by a shared fact (same reference, same total,
//                    or the same supplier uploaded together) is combined without
//                    asking. Everything weaker is still only suggested.
//   Review manually — nothing is combined until somebody confirms the modal.
//   Off            — no suggestions at all; select two rows and press Merge.
export const MERGE_MODES = ['Automatic', 'Review manually', 'Off'];

export const PAID_OPTIONS = ['Not paid', 'Paid'];

export const DEFAULT_EXTRACTION_SETTINGS = {
  showReviewReadyTabs: true,
  // Which engine reads this client entity's documents: 'claude', 'openai', or
  // '' for whatever the server defaults to. Blank by default so nothing changes
  // for a workspace that never opens the setting, and so a deploy that switches
  // its own default (LLM_PROVIDER) carries every untouched org with it.
  readerProvider: '',
  duplicateMode: 'Automatic',
  // Two uploads that are one document — page 1 and page 2 of a forwarded order,
  // or a receipt with the card slip that paid for it. Only the FIRM tier is ever
  // taken automatically, and a merge is undoable: the sources survive, hidden,
  // and Unmerge puts them back.
  mergeMode: 'Automatic',
  // What "Publish to Xero" posts a bill as, wherever a PERSON presses it: the
  // dialog's own default, the inbox's bulk publish, and a claim's. Approved,
  // because that is the state a bill has to reach before it can be paid, and
  // publishing from here is the last step of coding it — a book of drafts is a
  // second queue somebody has to work through in Xero.
  //
  // NOT the automatic publish-after-reading, which posts as SUBMITTED on
  // purpose: nobody looked at that document, so it goes into an approval queue
  // rather than straight into the payable ledger.
  publishStatus: 'AUTHORISED',
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

// The tax-code rules themselves live in their own dependency-free module so
// they can be tested directly (test/tax-rate-rules.test.mjs); re-exported here
// because every caller already reaches for them through this file.
export {
  inferTaxRateName,
  resolveTaxRate,
  taxRateOutcome,
  noTaxRateName,
  zeroTaxRate,
} from '@/lib/taxRateRules';
