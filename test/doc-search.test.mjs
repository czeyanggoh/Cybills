// The Costs and Sales quick search (src/lib/docSearch.js).
import assert from 'node:assert/strict';
import { matchesQuickSearch } from '../src/lib/docSearch.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures += 1; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

const doc = {
  supplier: 'Singtel', user: 'Cze Yang Goh', ownerEmail: 'gcy@example.com', category: '489 - Telephone',
  date: '2026-10-31', invoiceNumber: 'INV-7133316', description: '* Mobile plan October', total: 1200,
};

check('an empty search matches everything', () => assert.equal(matchesQuickSearch(doc, '  '), true));
check('invoice number', () => assert.equal(matchesQuickSearch(doc, '7133316'), true));
check('Item ID', () => assert.equal(matchesQuickSearch(doc, '261029000237', '261029000237'), true));
check('description, any case', () => assert.equal(matchesQuickSearch(doc, 'MOBILE PLAN'), true));
check('owner email', () => assert.equal(matchesQuickSearch(doc, 'gcy@'), true));
check('total as typed, with commas, with cents', () => {
  for (const q of ['1200', '1,200', '1200.00']) assert.equal(matchesQuickSearch(doc, q), true, q);
});
check('a string total with commas', () => assert.equal(matchesQuickSearch({ total: '1,200.50' }, '1200.5'), true));
check('the SGD restatement', () => assert.equal(matchesQuickSearch({ total: 25, baseTotal: 32.86 }, '32.86'), true));
check('nothing matching', () => assert.equal(matchesQuickSearch(doc, 'grab'), false));
check('a comma alone is not a match on the total', () => assert.equal(matchesQuickSearch({ total: 5 }, ','), false));

if (failures) { console.error(`\ndoc-search: ${failures} failed`); process.exit(1); }
console.log('\ndoc-search: all passed');
