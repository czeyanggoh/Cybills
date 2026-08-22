// The Costs inbox's Filter popover. Every chip is a promise about which rows
// come back, and a wrong predicate silently hides a document the reviewer is
// looking for — so each one is tested against a row that should survive it and
// a row that shouldn't.
import { COST_FILTERS, FILTER_IDS, applyCostFilters, filterCount, ANYONE, UNASSIGNED, isOwnedBy, ownersOf } from '../src/lib/costFilters.js';

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

// Every filter offers exactly two chips, and the second is the first's
// negation — so the two together are always the whole list. Status included:
// Ready and To review are now derived from the document, and every inbox
// document is one or the other.
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
  check('every chip pair splits the rows in two', FILTER_IDS.filter((id) => !partitions(id)), []);
  check('Ready and To review overlap in nothing', keep(rows, { status: 'ready' }, ctx).filter((x) => keep(rows, { status: 'review' }, ctx).includes(x)), []);
  check('an unfinished document is waiting on a person', keep(rows, { status: 'review' }, ctx), ['b']);
  check('…and the finished one is Ready', keep(rows, { status: 'ready' }, ctx), ['a']);
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

// --- Advanced search's User picker ------------------------------------------
// A document that records nobody is UNASSIGNED, and it is its own answer — not
// "You" (which is whoever happens to be looking) and not a person's name.
{
  const mine = doc({ id: 'mine', user: 'Cze Yang Goh', ownerEmail: 'czeyang.goh@cy-bm.sg' });
  const uploaded = doc({ id: 'uploaded', user: 'Astrid Yang', ownerEmail: '', createdByEmail: 'astridy2004@gmail.com' });
  const nobody = doc({ id: 'nobody', user: '', ownerEmail: '', createdByEmail: '' });
  const all = [mine, uploaded, nobody];
  const owned = (who) => all.filter((d) => isOwnedBy(d, who)).map((d) => d.id);

  check('by display name', owned('Cze Yang Goh'), ['mine']);
  check('by owner email', owned('CZEYANG.GOH@cy-bm.sg'), ['mine']);
  check('by uploader email where no owner was set', owned('astridy2004@gmail.com'), ['uploaded']);
  check('Unassigned finds only the documents recording nobody', owned(UNASSIGNED), ['nobody']);
  check('a person never matches the unassigned', owned('Cze Yang Goh').includes('nobody'), false);
  check('Anyone keeps everything', owned(ANYONE), ['mine', 'uploaded', 'nobody']);
  check('so does no choice at all', owned(''), ['mine', 'uploaded', 'nobody']);

  check('the picker offers each owner once, A–Z, Unassigned last',
    ownersOf([...all, doc({ id: 'again', user: 'Astrid Yang' })]),
    ['Astrid Yang', 'Cze Yang Goh', UNASSIGNED]);
  check('no unassigned documents, no Unassigned option', ownersOf([mine, uploaded]), ['Astrid Yang', 'Cze Yang Goh']);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
