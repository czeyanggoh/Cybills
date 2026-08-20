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
  duplicateMode: 'Automatic',
  extractTax: true,
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
const store = blobStore(KEY, DEFAULT_EXTRACTION_SETTINGS, emit);

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
