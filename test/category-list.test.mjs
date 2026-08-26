// A bridge entity's categories are plain names off a claim policy, not a chart
// of accounts — which is exactly what the "<code> - <name>" convention assumed.
import {
  SEED_CATEGORY_NAMES,
  categoryRowsFrom,
  visibleCategoryNamesFrom,
  categoryCode,
  categoryName,
} from '../src/lib/categoryList.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- The list ---------------------------------------------------------------
check('an entity with nothing saved gets the whole seed', visibleCategoryNamesFrom(null).length, SEED_CATEGORY_NAMES.length);
check('…including the ones with a " - " in the name', visibleCategoryNamesFrom({}).includes('Transport - Taxi'), true);

const withAdded = { added: { categories: [{ id: 'c1', name: 'Site Allowance', code: '' }] } };
check('an added category joins the list', visibleCategoryNamesFrom(withAdded).includes('Site Allowance'), true);

const withHidden = { ...withAdded, hidden: { categories: ['categories:Parking', 'c1'] } };
check('a hidden seed row drops out', visibleCategoryNamesFrom(withHidden).includes('Parking'), false);
check('a hidden added row drops out too', visibleCategoryNamesFrom(withHidden).includes('Site Allowance'), false);
check('hiding one leaves the rest', visibleCategoryNamesFrom(withHidden).includes('Transport - Taxi'), true);
check('a hidden row is still LISTED, just switched off', categoryRowsFrom(withHidden).find((r) => r.name === 'Parking')?.visible, false);

// Junk where a blob should be must read as "nothing saved", never throw — the
// setting is server-stored and can be anything.
check('a string blob is no blob', visibleCategoryNamesFrom('nonsense').length, SEED_CATEGORY_NAMES.length);
check('an array blob is no blob', visibleCategoryNamesFrom([1, 2]).length, SEED_CATEGORY_NAMES.length);
check('a nameless added row is skipped', visibleCategoryNamesFrom({ added: { categories: [{ id: 'x' }] } }).length, SEED_CATEGORY_NAMES.length);

// --- Code or plain name -----------------------------------------------------
check('a chart label has a code', categoryCode('412 - Consulting & Accounting'), '412');
check('…and a name', categoryName('412 - Consulting & Accounting'), 'Consulting & Accounting');
check('a sub-coded label keeps its whole code', categoryCode('200-10 - Sales - Projects'), '200-10');
check('…and everything after it is the name', categoryName('200-10 - Sales - Projects'), 'Sales - Projects');

// The bug this exists to stop: "Transport" is not an account code, so the label
// is a name in full. Read as a code it would post a taxi fare to nothing.
check('a claim-policy name has NO code', categoryCode('Transport - Taxi'), '');
check('…and is its own name, whole', categoryName('Transport - Taxi'), 'Transport - Taxi');
check('another one', categoryCode('Recall Allowance - Weekend/PH'), '');
check('…whole', categoryName('ERP - Cashcard'), 'ERP - Cashcard');
check('a bare category has no code', categoryCode('Uncategorised'), '');
check('a blank is a blank', categoryCode(''), '');
check('null is not a code', categoryCode(null), '');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
