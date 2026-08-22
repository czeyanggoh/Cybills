// The Costs inbox's Filter popover. Every chip is a promise about which rows
// come back, and a wrong predicate silently hides a document the reviewer is
// looking for — so each one is tested against a row that should survive it and
// a row that shouldn't.
import { COST_FILTERS, FILTER_IDS, applyCostFilters, filterCount } from '../src/lib/costFilters.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const doc = (over) => ({
  id: 'a',
  status: 'new',
  supplier: 'Grab',
  date: '2026-08-22',
  category: 'Uncategorised',
  currency: 'SGD',
  total: '100',
  tax: '0',
  ...over,
});

const ids = (rows) => rows.map((d) => d.id);
const keep = (rows, picked, ctx) => ids(applyCostFilters(rows, picked, ctx));

// Every filter offers exactly two chips, and for all but Status the second is
// the first's negation — so the two together are always the whole list. Status
// is deliberately not a partition: a document that is neither Ready nor To
// review (a fresh one) answers neither chip, same as Dext's.
check('two chips each', FILTER_IDS.every((id) => COST_FILTERS[id].options.length === 2), true);
{
  const rows = [
    doc({ id: 'a', status: 'ready', tax: '9', taxRate: 'Standard-Rated Purchases', category: 'Meals', note: 'x', paid: true, xeroInvoiceId: 'x1', project: 'Admin', lineItems: [{ description: 'l' }], duplicateOfId: 'b', currency: 'USD' }),
    doc({ id: 'b', status: 'new' }),
  ];
  const ctx = { flags: { a: true }, baseCurrency: 'SGD — Singapore, Dollars' };
  const partitions = (id) => {
    const [yes, no] = COST_FILTERS[id].options;
    const a = keep(rows, { [id]: yes.value }, ctx);
    const b = keep(rows, { [id]: no.value }, ctx);
    return a.length + b.length === rows.length && !a.some((x) => b.includes(x));
  };
  check('every chip pair but Status splits the rows in two', FILTER_IDS.filter((id) => id !== 'status' && !partitions(id)), []);
  check('Ready and To review overlap in nothing', keep(rows, { status: 'ready' }, ctx).filter((x) => keep(rows, { status: 'review' }, ctx).includes(x)), []);
  check('a fresh document is neither Ready nor To review', keep(rows, { status: 'review' }, ctx), []);
}

const rows = [
  doc({ id: 'taxed', tax: '9.00' }),
  doc({ id: 'untaxed', tax: '0' }),
];
check('with tax', keep(rows, { tax: 'yes' }), ['taxed']);
check('without tax', keep(rows, { tax: 'no' }), ['untaxed']);

check(
  'with category ignores Uncategorised',
  keep([doc({ id: 'coded', category: 'Meals' }), doc({ id: 'bare' })], { category: 'yes' }),
  ['coded']
);

check(
  'unread is the untouched document',
  keep([doc({ id: 'seen', status: 'viewed' }), doc({ id: 'fresh', status: 'new' })], { read: 'no' }),
  ['fresh']
);

check(
  'published',
  keep([doc({ id: 'posted', xeroInvoiceId: 'x' }), doc({ id: 'held' })], { publishing: 'yes' }),
  ['posted']
);

check(
  'flagged reads the flag map, not the row',
  keep([doc({ id: 'a' }), doc({ id: 'b' })], { flag: 'yes' }, { flags: { b: 'Query' } }),
  ['b']
);

check(
  'foreign currency is foreign to this org',
  keep([doc({ id: 'sgd' }), doc({ id: 'usd', currency: 'USD' })], { currency: 'foreign' }, { baseCurrency: 'SGD — Singapore, Dollars' }),
  ['usd']
);
check(
  'a document with no stated currency is the org\'s own',
  keep([doc({ id: 'blank', currency: '' })], { currency: 'base' }, { baseCurrency: 'SGD — Singapore, Dollars' }),
  ['blank']
);

check(
  'a dismissed duplicate is not a duplicate',
  keep(
    [doc({ id: 'dup', duplicateOfId: 'x' }), doc({ id: 'cleared', duplicateOfId: 'x', duplicateDismissed: true })],
    { duplicates: 'yes' }
  ),
  ['dup']
);

check(
  'project counts a line\'s own project',
  keep([doc({ id: 'line', lineItems: [{ description: 'l', project: 'Vivo' }] }), doc({ id: 'none' })], { project: 'yes' }),
  ['line']
);

check(
  'nothing read is the blank row',
  keep(
    [
      doc({ id: 'blank', supplier: 'Unknown supplier', date: '', total: '0', tax: '', invoiceNumber: '' }),
      doc({ id: 'read' }),
    ],
    { extraction: 'yes' }
  ),
  ['blank']
);

// Two chips at once narrow rather than widen.
check(
  'filters combine',
  keep(
    [doc({ id: 'both', tax: '9', paid: true }), doc({ id: 'one', tax: '9' }), doc({ id: 'neither' })],
    { tax: 'yes', paid: 'yes' }
  ),
  ['both']
);

// Nothing chosen, a cleared chip, and a value that no longer exists all leave
// the table alone — a stale filter must never empty the inbox.
check('no filters', keep(rows, {}), ['taxed', 'untaxed']);
check('cleared chip', keep(rows, { tax: '' }), ['taxed', 'untaxed']);
check('unknown value', keep(rows, { tax: 'maybe' }), ['taxed', 'untaxed']);
check('count is what is chosen', filterCount({ tax: 'yes', paid: '', flag: 'no' }), 2);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
