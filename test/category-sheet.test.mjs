// A bridge entity's category list round-trips through Excel, and Delete deletes.
import { categoryRowsFrom, visibleCategoryNamesFrom, SEED_CATEGORY_NAMES } from '../src/lib/categoryList.js';
import { categoryWorkbook, pickCategorySheet, planCategoryImport } from '../src/lib/categorySheet.js';
import { writeXlsx, readXlsx } from '../src/lib/xlsx.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- Delete removes a seed row from the list, not merely switches it off -----
const deleted = { hidden: { categories: ['categories:Parking'] }, removed: { categories: ['categories:Parking'] } };
check('a deleted seed row is not listed', categoryRowsFrom(deleted).some((r) => r.name === 'Parking'), false);
check('…nor offered', visibleCategoryNamesFrom(deleted).includes('Parking'), false);
check('…and the rest stay', categoryRowsFrom(deleted).length, SEED_CATEGORY_NAMES.length - 1);

// --- The SMRT case: the file lists five, so the rest go --------------------
const rows = categoryRowsFrom({});
const accounts = [{ code: '493', name: 'Travel - National' }, { code: '420', name: 'Entertainment' }];
const map = { 'Transport - Taxi': '493' };
const sheetRows = [
  ['Name', 'Posts to', 'Visible'],
  ['Meals', '420 - Entertainment', 'Yes'],
  ['Transport - Private Taxi', '493 - Travel - National', ''],
  ['Transport - Public Bus/Train', '493', 'Yes'],
  ['Transport - Claim by mileage', '', 'Yes'],
  ['Others', '', 'Yes'],
  ['', '', ''],
];
const plan = planCategoryImport({ sheetRows, rows, map, accounts });
check('five are added (none of the names exist yet but Others)', plan.add.map((a) => a.name), ['Meals', 'Transport - Private Taxi', 'Transport - Public Bus/Train', 'Transport - Claim by mileage']);
check('every seed row but Others is deleted', plan.remove.length, SEED_CATEGORY_NAMES.length - 1);
check('Others is kept', plan.remove.some((r) => r.name === 'Others'), false);
check('Posts to is read from a label or a bare code', plan.accounts, { Meals: '420', 'Transport - Private Taxi': '493', 'Transport - Public Bus/Train': '493' });
check('no errors', plan.errors, []);

// --- A bad row is skipped and KEPT, never deleted for being unreadable ------
const bad = planCategoryImport({
  sheetRows: [['Name', 'Posts to', 'Visible'], ['Parking', '999', 'Yes'], ['Others', '', 'Maybe']],
  rows, map, accounts,
});
check('an account not in the chart is refused', bad.errors.map((e) => e.row), [2, 3]);
check('…and that category is not deleted', bad.remove.some((r) => r.name === 'Parking' || r.name === 'Others'), false);

// --- An empty file deletes nothing --------------------------------------------
const empty = planCategoryImport({ sheetRows: [['Name', 'Posts to', 'Visible']], rows, map, accounts });
check('an empty file changes nothing', [empty.remove.length, empty.add.length, empty.errors.length], [0, 0, 1]);
const noName = planCategoryImport({ sheetRows: [['Category']], rows, map, accounts });
check('a file with no Name column is refused', noName.errors.length, 1);

// --- Visible No hides; matching is case-insensitive -------------------------
const vis = planCategoryImport({ sheetRows: [['name', 'visible'], ['parking', 'No']], rows, map, accounts });
check('Visible No switches an existing row off', vis.visibility, { 'categories:Parking': false });
check('…without a Posts to column, mappings are left alone', vis.accounts, {});

// --- Through a real workbook --------------------------------------------------
const bytes = writeXlsx(categoryWorkbook({ rows, map, accounts }));
const sheet = pickCategorySheet(await readXlsx(bytes));
const again = planCategoryImport({ sheetRows: sheet.rows, rows, map, accounts });
check('an exported file imported unchanged changes nothing', [again.diffs.length, again.errors.length], [0, 0]);
check('…and says Posts to as the account label', sheet.rows.find((r) => r[0] === 'Transport - Taxi')?.[1], '493 - Travel - National');

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\ncategory-sheet: all passed');
