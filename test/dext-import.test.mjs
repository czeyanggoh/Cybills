// Reading a Dext export.
//
// This is a one-way door: a migration writes months of somebody's paperwork
// into a live book, and the mistakes that matter are silent ones — a total read
// into the tax column, a date a year out, or a receipt attached to the wrong
// row. So the rules that decide those are pinned here.
import {
  parseCsv, isoDate, amount, parseDextExport, matchFiles, billPayload, patchPayload, cleanCategory,
} from '../src/lib/dextImport.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- The file itself ---------------------------------------------------------
check('a plain row splits', parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
check('quoted commas stay inside their field', parseCsv('a,b\n"x, y",2'), [['a', 'b'], ['x, y', '2']]);
check('a doubled quote is one quote', parseCsv('a\n"he said ""hi"""'), [['a'], ['he said "hi"']]);
check('CRLF is a line ending too', parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
check('a trailing blank line is not a record', parseCsv('a\n1\n\n').length, 2);
// Dext's own file quotes some empty cells and not others; both are empty.
check('quoted empties are empty', parseCsv('a,b\n"",x'), [['a', 'b'], ['', 'x']]);

// --- Dates -------------------------------------------------------------------
check("Dext's own format", isoDate('31-Aug-2026'), '2026-08-31');
check('a single-digit day', isoDate('1-Sep-2026'), '2026-09-01');
check('already ISO is left alone', isoDate('2026-08-31'), '2026-08-31');
// A spreadsheet round-trip rewrites the column, and these clients are all in
// Singapore, so the day comes first.
check('day-first when a spreadsheet has rewritten it', isoDate('05/09/2026'), '2026-09-05');
check('nothing readable is nothing, never today', isoDate('n/a'), '');
check('an empty cell stays empty', isoDate(''), '');

// --- Money -------------------------------------------------------------------
check('a plain amount', amount('78.70'), '78.7');
check('thousands separators go', amount('1,234.56'), '1234.56');
check('a comma-decimal file reads by the LAST separator', amount('1.234,56'), '1234.56');
check('a currency symbol is not part of the number', amount('SGD 78.70'), '78.7');
// '' is "the file did not say"; 0 would be a claim about the money.
check('an empty cell is not zero', amount(''), '');
check('nonsense is not zero either', amount('n/a'), '');

// --- A whole export ----------------------------------------------------------
const CSV = [
  'Receipt ID,Type,Date,Due Date,Invoice Number,Supplier,Category,Customer,Project,Payment Method,Bank Account,Tax,Total,Currency,Tax (SGD),Total (SGD),Status,Owner,Note,Description,Image',
  '21616969450,Expense claim,20-Aug-2026,,INV-1,Grab,"Transport - Taxi",,ASTP 01,Visa,"",0.00,39.20,SGD,0.00,39.20,processed,Fan Liang Bonny Cheow,note here,MHA NPPK to ST Jurong,https://rbnk.me/i/x',
  '21616981690,Expense claim,24-Aug-2026,,,Grab,"Transport - Taxi",,,,"",0.00,17.10,SGD,0.00,17.10,processed,Fan Liang Bonny Cheow,,Home to MHA PCC,',
].join('\r\n');

const { rows, missing } = parseDextExport(CSV);
check('every row is read', rows.length, 2);
check('and every column was recognised', missing, []);
check('the fields Dext already decided come across', rows[0], {
  line: 2,
  receiptId: '21616969450',
  supplier: 'Grab',
  invoiceNumber: 'INV-1',
  date: '2026-08-20',
  dueDate: '',
  category: 'Transport - Taxi',
  taxRate: '',
  documentType: 'Expense claim',
  customer: '',
  project: 'ASTP 01',
  paymentMethod: 'Visa',
  currency: 'SGD',
  total: '39.2',
  tax: '0',
  baseTotal: '39.2',
  baseTax: '0',
  note: 'note here',
  description: 'MHA NPPK to ST Jurong',
  image: 'https://rbnk.me/i/x',
  owner: 'Fan Liang Bonny Cheow',
});

// Columns are found by NAME. Dext offers a custom column set, and a file whose
// columns are in another order must not load totals into the tax field.
const SHUFFLED = ['Total,Supplier,Receipt ID,Date', '39.20,Grab,999111222,20-Aug-2026'].join('\n');
const shuffled = parseDextExport(SHUFFLED);
check('a reordered export still reads correctly', [shuffled.rows[0].total, shuffled.rows[0].supplier], ['39.2', 'Grab']);
check('and says which columns it did not find', shuffled.missing.includes('Category'), true);

// --- Matching a row to its file ----------------------------------------------
const f = (name) => ({ name });
const m = matchFiles(rows, [f('21616969450.pdf'), f('Receipt_21616981690 (1).PDF')]);
check('a file named by the id is matched', m.pairs[0].file.name, '21616969450.pdf');
check('and so is one somebody has renamed around the id', m.pairs[1].file.name, 'Receipt_21616981690 (1).PDF');
check('both rows got their document', m.matched, 2);
check('nothing was left over', m.spare.length, 0);

// A row whose file is missing still imports — it just arrives without the
// document, and is named so nobody has to work out which ones.
const half = matchFiles(rows, [f('21616969450.pdf')]);
check('a row with no file is reported, not dropped', half.withoutFile.map((r) => r.receiptId), ['21616981690']);
check('and the rest still match', half.matched, 1);

// Two files claiming one id is ambiguous, so NEITHER is used: attaching the
// wrong image to a row is worse than attaching none, because the figures would
// look right and the evidence behind them would be somebody else's.
const ambiguous = matchFiles(rows, [f('21616969450.pdf'), f('copy-21616969450.jpg')]);
check('an ambiguous id attaches nothing', ambiguous.pairs[0].file, null);

// Never by supplier, date or amount — several receipts from one supplier on one
// day for one amount is an ordinary Tuesday.
const wrongName = matchFiles(rows, [f('grab-20-aug-2026.pdf')]);
check('a file that names no id matches nothing', wrongName.matched, 0);
check('and is reported as spare, so it can be found', wrongName.spare.length, 1);

// --- What gets sent ----------------------------------------------------------
check('the create body carries the coding as it stands', billPayload(rows[0]), {
  kind: 'cost',
  documentType: 'Expense claim',
  supplier: 'Grab',
  invoiceNumber: 'INV-1',
  date: '2026-08-20',
  category: 'Transport - Taxi',
  currency: 'SGD',
  total: '39.2',
  tax: '0',
  description: 'MHA NPPK to ST Jurong',
  owner: 'Fan Liang Bonny Cheow',
});
// A blank cell sends nothing rather than an empty string, so an import can
// never blank a field the server would otherwise fill in.
check('a blank cell is simply absent', 'invoiceNumber' in billPayload(rows[1]), false);
check('the rest follows in one patch', patchPayload(rows[0]), {
  paymentMethod: 'Visa', project: 'ASTP 01', note: 'note here',
});
check('and a plain receipt needs no patch at all', patchPayload(rows[1]), {});

// --- What a REAL export turned out to contain ---------------------------------
// Taken from an Arc3 Nobel export: extra Tax columns Dext adds, a rate
// annotation on the category, and a foreign-currency invoice.
const REAL = [
  'Receipt ID,Type,Date,Due Date,Invoice Number,Supplier,Category,Customer,Project,Payment Method,Bank Account,Tax,Tax Name,Tax Code,Tax Percentage,Total,Currency,Tax (SGD),Total (SGD),Status,Owner,Note,Description,Image',
  '21134108980,Invoice,09-Jun-2026,09-Jun-2026,008-IND-05-2026,JA FEAST HUB PRIVATE LIMITED,310 - Manpower Cost (0%),,,"","",0.00,No Tax,NONE,0.00,14600.00,SGD,0.00,14600.00,processed,,,Supply of Manpower,https://rbnk.me/i/wIcFkASFWY0',
  '20909316790,Invoice,18-Jun-2026,18-Jun-2026,BTM-104609,Cititex,"",,,"","",0.00,,,,1872500.00,IDR,0.00,135.26,processed,Arc3 Nobel Finance,,,https://rbnk.me/i/pQ9Qj-p2mKs',
].join('\r\n');
const real = parseDextExport(REAL);
check('the extra Tax columns do not shift anything', real.rows[0].total, '14600');

// Dext writes the account's rate onto the label. The chart says "310 - Manpower
// Cost", so a category imported with the suffix matches nothing and publishes
// nowhere.
check('the rate annotation comes off the category', real.rows[0].category, '310 - Manpower Cost');
check('a name that really ends in brackets keeps them', cleanCategory('Meal Weekday (after 9pm)'), 'Meal Weekday (after 9pm)');
check('the tax code Dext used comes across', billPayload(real.rows[0]).taxRate, 'NONE');
check("and so does Dext's word for what the document is", billPayload(real.rows[0]).documentType, 'Invoice');

// A foreign-currency document says twice what it is worth. Both halves are
// kept, and the restatement is only sent when it says something.
const idr = billPayload(real.rows[1]);
check('a foreign document keeps its own total', [idr.total, idr.currency], ['1872500', 'IDR']);
check('and what it is worth here', [idr.baseCurrency, idr.baseTotal], ['SGD', '135.26']);
check('an SGD document is not restated against itself', 'baseCurrency' in billPayload(real.rows[0]), false);

// The link in the Image column is where the document itself comes from when
// there is no downloaded file to match.
check('the image link is carried for fetching', real.rows[1].image, 'https://rbnk.me/i/pQ9Qj-p2mKs');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
