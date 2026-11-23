// Supporting documents: the receipts or expense reports sent in WITH the invoice
// that recharges them. The rule the Costs list and the server share.
import { findSupportingGroups, tiesTo, mailKey, canSupport, supportCents, reasonText } from '../src/lib/supportingDocs.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const mail = { from: 'finance@dart.com.sg', to: 'dart@cybills.sg', subject: 'Red Alpha October invoice', date: '2026-11-20T02:00:00.000Z', text: '' };
const doc = (id, over = {}) => ({
  id,
  kind: 'cost',
  status: 'ready',
  type: 'Invoice',
  supplier: 'Somebody',
  currency: 'SGD',
  date: '2026-10-31',
  total: '0',
  tax: '0',
  email: mail,
  createdByEmail: 'finance@dart.com.sg',
  createdAt: '2026-11-20T02:00:05.000Z',
  entityCheck: { status: 'unknown' },
  ...over,
});
// The case this was built for: Red Alpha's invoice to Dart, and the three
// expense reports it recharges, in one email. The invoice carries a fee on top,
// so the three do NOT add up to it — each ties to a line instead.
const main = (over = {}) =>
  doc('main', {
    supplier: 'Red Alpha Cybersecurity Pte. Ltd.',
    total: '11590.36',
    entityCheck: { status: 'ok' },
    readLines: [
      { description: 'Roy Shumel expenses', total: 80.78, net: 0 },
      { description: 'Sefi Kirshberg expenses', total: 746.6, net: 0 },
      { description: 'Yoav Korman expenses', total: 9687.35, net: 0 },
      { description: 'Management fee', total: 1075.63, net: 0 },
    ],
    ...over,
  });
const roy = (over = {}) => doc('roy', { supplier: 'ROY SHUMEL', type: 'Receipt', total: '80.78', date: '2026-01-07', ...over });
const sefi = (over = {}) => doc('sefi', { supplier: 'sefi kirshberg', type: 'Receipt', total: '746.6', date: '2025-12-26', ...over });
const yoav = (over = {}) => doc('yoav', { supplier: 'Yoav Korman', type: 'Receipt', total: '9687.35', date: '2025-11-26', ...over });
const shape = (gs) => gs.map((g) => [g.mainId, g.supports.map((s) => s.id).sort().join('+'), g.confidence]);

// --- the firm case -------------------------------------------------------------------
let g = findSupportingGroups([main(), roy(), sefi(), yoav()]);
check('one email, the invoice billed to us, every other document a line of it: firm', shape(g), [['main', 'roy+sefi+yoav', 'firm']]);
check('each is tied to its own line', g[0].supports.find((s) => s.id === 'sefi').line, 'Sefi Kirshberg expenses');
check('and says so in words', reasonText(g[0].supports.find((s) => s.id === 'roy')), 'its total is the invoice\'s line "Roy Shumel expenses"');
check('the three do not add up to the invoice, and need not', g[0].supports.every((s) => !s.reasons.includes('sum')), true);

// --- what stops it being firm -----------------------------------------------------------
g = findSupportingGroups([main(), roy(), sefi(), yoav(), doc('stray', { supplier: 'Singtel', total: '55.10' })]);
check('a document of the same mail that ties to nothing makes it a question', shape(g), [['main', 'roy+sefi+yoav', 'possible']]);

g = findSupportingGroups([main(), roy()]);
check('one figure can coincide: a single tied document is only offered', shape(g), [['main', 'roy', 'possible']]);
g = findSupportingGroups([main(), roy({ billedTo: 'Red Alpha Cybersecurity Pte Ltd' })]);
check('unless it is also made out to the invoice\'s own supplier', shape(g), [['main', 'roy', 'firm']]);

const upload = { email: null };
g = findSupportingGroups([main(upload), roy(upload), sefi(upload), yoav(upload)]);
check('uploaded together rather than emailed together: offered, never taken', shape(g), [['main', 'roy+sefi+yoav', 'possible']]);
g = findSupportingGroups([main(upload), roy({ ...upload, createdAt: '2026-11-20T05:00:00.000Z' })]);
check('uploads hours apart did not arrive together', shape(g), []);

g = findSupportingGroups([main({ entityCheck: { status: 'unknown' } }), roy(), sefi(), yoav()]);
check('an invoice the paper does not say is ours: offered on the money alone', shape(g), [['main', 'roy+sefi+yoav', 'possible']]);

// --- what is never backup ---------------------------------------------------------------
g = findSupportingGroups([main(), roy({ entityCheck: { status: 'ok' } }), sefi(), yoav()]);
check('a document billed to THIS entity is our own cost, not backup', shape(g), []);
g = findSupportingGroups([main(), roy({ notSupportingFor: ['main'] }), sefi(), yoav()]);
check('one a person kept separate is left out, and the rest become a question', shape(g), [['main', 'sefi+yoav', 'possible']]);
check('a document already in Xero cannot be set aside', canSupport(roy({ xeroInvoiceId: 'x' })), false);
check('nor one on an expense claim', canSupport(roy({ status: 'expenseclaim' })), false);
check('nor a payment proof', canSupport(roy({ type: 'Payment proof' })), false);
check('nor one already supporting something', canSupport(roy({ supportingFor: { billId: 'other' } })), false);
check('a document worth as much as the invoice is a copy, not backup', tiesTo(main({ total: '80.78' }), [roy()]), []);
g = findSupportingGroups([main({ readLines: [] }), roy(), sefi(), yoav()]);
check('an invoice showing no lines, with nothing else to go on, offers nothing', shape(g), []);

// --- the other ties ---------------------------------------------------------------------
g = findSupportingGroups([main({ total: '10514.73', readLines: [] }), roy(), sefi(), yoav()]);
check('no lines, but together they ARE the invoice: firm on the sum', shape(g), [['main', 'roy+sefi+yoav', 'firm']]);
g = findSupportingGroups([main({ total: '11461.06', tax: '946.33', readLines: [] }), roy(), sefi(), yoav()]);
check('or the invoice net, with GST charged on top', shape(g), [['main', 'roy+sefi+yoav', 'firm']]);
g = findSupportingGroups([main({ readLines: [] }), roy({ billedTo: 'Red Alpha Cybersecurity' }), sefi(), yoav()]);
check('made out to the invoice\'s supplier, with no line to tie it: offered', shape(g), [['main', 'roy', 'possible']]);
check(
  'a line stated net ties a receipt at that figure',
  tiesTo(main({ readLines: [{ description: 'Taxi', total: 88.05, net: 80.78 }] }), [roy()]).map((t) => t.reasons),
  [['line']]
);
check(
  'two documents at one figure need two lines',
  tiesTo(main({ readLines: [{ description: 'Taxi', total: 80.78, net: 0 }] }), [roy(), roy({ id: 'roy2' })]).length,
  1
);
check('the invoice\'s own line items are read before the rows the read saw',
  tiesTo(main({ lineItems: [{ description: 'Only this', net: '80.78', tax: '0', total: '80.78' }] }), [roy(), sefi()]).map((t) => t.id), ['roy']);

// --- currency ---------------------------------------------------------------------------
check('a USD receipt is compared at the SGD figure it restated itself in', supportCents({ currency: 'USD', total: '60', baseCurrency: 'SGD', baseTotal: '80.78' }, main()), 8078);
check('and without one it cannot be compared', supportCents({ currency: 'USD', total: '60' }, main()), null);

// --- arrival ----------------------------------------------------------------------------
check('one mail is one key', mailKey(roy()) === mailKey(main()), true);
check('another mail is another', mailKey(roy({ email: { ...mail, subject: 'Something else' } })) === mailKey(main()), false);
check('an upload has none', mailKey(roy(upload)), '');
g = findSupportingGroups([main(), roy({ email: { ...mail, date: '2026-11-21T02:00:00.000Z' } }), sefi(), yoav()]);
check('a document from another mail is not part of this one', shape(g), [['main', 'sefi+yoav', 'firm']]);

if (failures) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nAll supporting-docs checks passed');
