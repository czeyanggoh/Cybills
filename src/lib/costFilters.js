// The Costs inbox's Filter popover, defined once.
//
// One list drives both the panel and the filtering, so a filter can never be
// offered without being applied (or applied without being visible). Each row is
// a question with two mutually exclusive answers — the Dext shape — and picking
// the answer that is already on clears it, so the row means "either" again.
//
// Every predicate reads the document row as the table already has it; the few
// facts that live outside the row (which documents are flagged, what the org's
// own currency is) arrive as context.
import { docFacts, statesNothing } from './mergeDetect.js'; // relative so the rules can be tested under plain node

const text = (v) => String(v ?? '').trim();
const has = (v) => text(v) !== '' && text(v) !== '—';
const num = (v) => Number(text(v).replace(/[^0-9.-]/g, '')) || 0;
const isCategorised = (d) => has(d.category) && text(d.category).toLowerCase() !== 'uncategorised';
// The document's currency, or the org's own when the read didn't state one.
const currencyOf = (d, ctx) => (text(d.currency) || text(ctx?.baseCurrency) || 'SGD').toUpperCase().slice(0, 3);
const baseCurrency = (ctx) => (text(ctx?.baseCurrency) || 'SGD').toUpperCase().slice(0, 3);
const isFlagged = (d, ctx) => Boolean(ctx?.flags?.[d.id]);
const hasDuplicate = (d) => Boolean(d.duplicateOfId) && !d.duplicateDismissed;
const isMerged = (d) => d.status === 'merged' || (Array.isArray(d.mergedFrom) && d.mergedFrom.length > 0);
const lineCount = (d) => (Array.isArray(d.lineItems) ? d.lineItems.length : 0);
const hasProject = (d) =>
  has(d.project) || (Array.isArray(d.lineItems) && d.lineItems.some((l) => has(l?.project) || has(l?.project2)));
// "The reader got nothing off this file" — the same test the Nothing read badge
// and the merge scan use, so one document can't be blank in one place and not
// in another.
const readBlank = (d) => statesNothing(docFacts(d));

// A pair of chips: [id, label, predicate]. The second is always the first's
// negation, so "either" is the absence of a choice rather than a third chip.
const pair = (label, yes, no, test) => ({
  label,
  options: [
    { value: 'yes', label: yes, test },
    { value: 'no', label: no, test: (d, ctx) => !test(d, ctx) },
  ],
});

export const COST_FILTERS = {
  status: {
    label: 'Status',
    options: [
      { value: 'ready', label: 'Ready', test: (d) => d.status === 'ready' },
      { value: 'review', label: 'To review', test: (d) => d.status === 'review' },
    ],
  },
  tax: pair('Tax', 'With tax', 'Without tax', (d) => num(d.tax) > 0),
  taxRate: pair('Tax rate', 'With tax rate', 'Without tax rate', (d) => has(d.taxRate)),
  category: pair('Category', 'With category', 'Without category', isCategorised),
  currency: {
    label: 'Currency',
    options: [
      { value: 'base', label: 'Default currency', test: (d, ctx) => currencyOf(d, ctx) === baseCurrency(ctx) },
      { value: 'foreign', label: 'Foreign currency', test: (d, ctx) => currencyOf(d, ctx) !== baseCurrency(ctx) },
    ],
  },
  read: pair('Read', 'Read', 'Unread', (d) => d.status !== 'new'),
  publishing: pair('Publishing', 'Published', 'Unpublished', (d) => Boolean(d.xeroInvoiceId)),
  flag: pair('Flag', 'Flagged', 'Unflagged', isFlagged),
  note: pair('Note', 'With note', 'Without note', (d) => has(d.note)),
  merged: pair('Merged', 'Merged', 'Not merged', isMerged),
  duplicates: pair('Duplicates', 'With duplicates', 'Without duplicates', hasDuplicate),
  paid: pair('Paid', 'Paid', 'Unpaid', (d) => Boolean(d.paid)),
  claim: pair('Expense claim', 'On a claim', 'Not on a claim', (d) => d.status === 'expenseclaim'),
  lineItems: pair('Line items', 'With line items', 'Without line items', (d) => lineCount(d) > 0),
  project: pair('Project', 'With project', 'Without project', hasProject),
  extraction: pair('Data extraction', 'Nothing read', 'Read something', readBlank),
};

export const FILTER_IDS = Object.keys(COST_FILTERS);

// No filter chosen anywhere.
export const emptyFilters = () => ({});

export const filterCount = (picked) => FILTER_IDS.filter((id) => picked?.[id]).length;

// Apply the picked chips to a list of rows. An unknown id or a stale value is
// ignored rather than emptying the table.
export function applyCostFilters(rows, picked, ctx) {
  if (!picked) return rows;
  return FILTER_IDS.reduce((list, id) => {
    const value = picked[id];
    if (!value) return list;
    const option = COST_FILTERS[id].options.find((o) => o.value === value);
    return option ? list.filter((d) => option.test(d, ctx || {})) : list;
  }, rows);
}
