// What the inbox scan calls one document. Getting this wrong costs real money in
// both directions — a missed pair leaves half a bill unposted, a false pair
// combines two unrelated costs into one — so the rules are tested directly.
import {
  findMergeCandidates,
  looksLikeDuplicates,
  mergeKind,
  orderForMerge,
  pairMatch,
  docFacts,
} from '../src/lib/mergeDetect.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// A row as the Costs list holds it: absent fields carry the list's own blanks
// ('—' for a date or total), which is exactly what a half-read page looks like.
const doc = (o) => ({
  id: 'd1',
  persisted: true,
  hasFile: true,
  status: 'new',
  supplier: 'Unknown supplier',
  date: '—',
  total: '—',
  tax: '0.00',
  invoiceNumber: '',
  lineItems: [],
  cardLast4: '',
  createdByEmail: 'sefi@example.com',
  createdAt: '2026-08-12T09:05:00.000Z',
  ...o,
});
const kindOf = (a, b) => pairMatch(docFacts(a), docFacts(b))?.kind ?? null;
const ids = (list) => list.map((d) => d.id);

// --- the case that started this ----------------------------------------------
// One forwarded order confirmation, screenshotted in two halves: the header page
// carries the invoice number, the date and the card payment; the details page
// carries the itemised rows and the total. Same merchant, same money.
const page1 = doc({
  id: 'page1',
  supplier: 'Craftsmen Coffee - Mohd Sultan',
  date: '2026-08-12',
  invoiceNumber: '2026081222-WO',
  total: '61.63',
  createdAt: '2026-08-12T09:05:00.000Z',
});
const page2 = doc({
  id: 'page2',
  supplier: 'Craftsmen Coffee - Mohd Sultan',
  total: '61.63',
  tax: '5.09',
  lineItems: [{ description: 'Cappuccino' }, { description: 'Long Black' }],
  createdAt: '2026-08-12T09:06:00.000Z',
});
check('two halves of one document are a page pair', kindOf(page1, page2), 'pages');
check('the header page leads the merged PDF', ids(orderForMerge([page2, page1], 'pages')), ['page1', 'page2']);
check('a hand-picked pair reads as pages', mergeKind([page1, page2]), 'pages');
check('a page pair is not mistaken for a re-upload', looksLikeDuplicates([page1, page2]), false);

// The same pair when the header page's total never extracted: the tie is now the
// shared supplier plus arriving in one upload.
const page1NoTotal = doc({ ...page1, total: '—' });
check('pages still pair when one half states no total', kindOf(page1NoTotal, page2), 'pages');

// ...but not once they are days apart with nothing else in common.
const page1Later = doc({ ...page1NoTotal, createdAt: '2026-09-30T09:05:00.000Z' });
check('a blank half from another week does not pair on supplier alone', kindOf(page1Later, page2), null);

// --- the case the old scan already handled -----------------------------------
const receipt = doc({
  id: 'receipt',
  supplier: 'Craftsmen Coffee',
  date: '2026-08-12',
  total: '61.63',
  tax: '5.09',
  lineItems: [{ description: 'Cappuccino' }],
});
const cardSlip = doc({ id: 'slip', supplier: 'DBS Bank', date: '2026-08-12', total: '61.63' });
check('a receipt and its card slip still pair', kindOf(receipt, cardSlip), 'payment');
check('the itemised document leads a payment pair', ids(orderForMerge([cardSlip, receipt], 'payment')), ['receipt', 'slip']);

// Two different cards for the same amount are two different transactions.
check(
  'a card conflict blocks a payment pair',
  kindOf(doc({ ...receipt, cardLast4: '1234' }), doc({ ...cardSlip, cardLast4: '9876' })),
  null,
);

// --- what must NOT pair -------------------------------------------------------
// The same document uploaded twice: same supplier, same total, and neither half
// fills a blank in the other. That is a duplicate to resolve, not a merge.
const copyA = doc({ id: 'copyA', supplier: 'Craftsmen Coffee', date: '2026-08-12', total: '61.63', tax: '5.09', invoiceNumber: 'WO-1', lineItems: [{ description: 'Cappuccino' }] });
const copyB = doc({ ...copyA, id: 'copyB' });
check('a straight re-upload is not a merge', kindOf(copyA, copyB), null);
check('a straight re-upload reads as duplicates', looksLikeDuplicates([copyA, copyB]), true);

// Two half-read documents that share nothing but their blanks.
const blankA = doc({ id: 'blankA', lineItems: [{ description: 'Something' }] });
const blankB = doc({ id: 'blankB', date: '2026-08-12' });
check('two unrelated half-read documents do not pair', kindOf(blankA, blankB), null);

// Facts they both state must agree.
check(
  'a different stated total blocks a page pair',
  kindOf(page1, doc({ ...page2, total: '42.00' })),
  null,
);
check(
  'a different stated reference blocks a page pair',
  kindOf(page1, doc({ ...page2, invoiceNumber: 'OTHER-1' })),
  null,
);

// --- the scan over a whole inbox ---------------------------------------------
const unrelated = doc({ id: 'other', supplier: 'Grab', date: '2026-08-11', total: '18.40' });
const found = findMergeCandidates([unrelated, page2, page1, receipt, cardSlip]);
check('the scan finds both kinds and leaves the rest alone', found.map((g) => [g.kind, ids(g.docs)]), [
  ['pages', ['page1', 'page2']],
  ['payment', ['receipt', 'slip']],
]);
check('the scan says why it paired them', found[0].why, 'the same total');

// Three documents at one total is an ambiguity, not a pairing: which slip paid
// which receipt is not knowable from the total alone, so nothing is offered.
const secondSlip = doc({ id: 'slip2', supplier: 'UOB', date: '2026-08-12', total: '61.63' });
check('an ambiguous total offers nothing', findMergeCandidates([receipt, cardSlip, secondSlip]).length, 0);

// Three pages of one document chain into a single group, not two pairs.
const page3 = doc({ id: 'page3', supplier: 'Craftsmen Coffee - Mohd Sultan', invoiceNumber: '2026081222-WO', tax: '5.09', createdAt: '2026-08-12T09:07:00.000Z' });
const chained = findMergeCandidates([page2, page3, page1]);
check('three pages chain into one group', chained.map((g) => ids(g.docs)), [['page1', 'page3', 'page2']]);

// Documents without a stored file can't be combined into a PDF, so they are not
// offered — and neither are the originals of an earlier merge.
check('rows with no file are never candidates', findMergeCandidates([doc({ ...page1, hasFile: false }), page2]).length, 0);
check('already-merged originals are left alone', findMergeCandidates([doc({ ...page1, status: 'merged' }), page2]).length, 0);

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
