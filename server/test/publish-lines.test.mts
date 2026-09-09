// What a bill's own line items become when they are posted to Xero. This
// arithmetic decides the figures that land in a live ledger, so the rule it
// enforces is tested directly: the lines must be the same money as the bill, or
// they don't go up as lines at all.
import http from 'node:http';
import { finish } from './support.mts';

process.env.CYWORKSPACE_API_KEY = 'test-key';

// --- stub relay --------------------------------------------------------------
// Stands in for cyworkspace's Xero relay: the accounts and tracking categories
// the builder checks a line against.
const ACCOUNTS = ['315', '313A', '429'];
const TRACKING = [
  { Name: 'Projects', Status: 'ACTIVE', Options: [{ Name: 'ASTP 01', Status: 'ACTIVE' }, { Name: 'ASTP 02', Status: 'ACTIVE' }] },
  { Name: 'Projects 2', Status: 'ACTIVE', Options: [{ Name: 'Phase A', Status: 'ACTIVE' }] },
];
const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0];
  res.setHeader('content-type', 'application/json');
  if (path.endsWith('/Accounts')) {
    res.end(JSON.stringify({ Accounts: ACCOUNTS.map((code) => ({ Code: code, Name: `Account ${code}`, Status: 'ACTIVE' })) }));
  } else if (path.endsWith('/TrackingCategories')) {
    res.end(JSON.stringify({ TrackingCategories: TRACKING }));
  } else if (path.endsWith('/TaxRates')) {
    res.end(JSON.stringify({ TaxRates: [
      { Name: 'Standard-Rated Purchases', TaxType: 'INPUTY24', EffectiveRate: 9, Status: 'ACTIVE' },
      { Name: 'Zero-Rated Purchases', TaxType: 'ZERORATEDINPUT', EffectiveRate: 0, Status: 'ACTIVE' },
      { Name: 'Old Rate', TaxType: 'INPUT', EffectiveRate: 7, Status: 'DELETED' },
    ] }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  }
});
await new Promise<void>((r) => stub.listen(4601, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4601';

const { perLineItems } = await import('../src/xero.ts');

const OPTS = { accountCode: '429', taxType: 'INPUT', tenantId: 'tenant-1', fallbackDescription: 'Supplier bill' };
const row = (o: Record<string, unknown>) => ({ description: 'Row', category: '315 - Outlet Laundry', net: '', tax: '', total: '', ...o }) as any;
const bill = (o: Record<string, unknown>) => ({ id: 'b1', supplier: 'A1', total: '0', tax: '0', ...o }) as any;

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const sum = (lines: any[], k: string) => Math.round(lines.reduce((t, l) => t + l[k] * 100, 0)) / 100;
// The builder answers with what the publish path should do; unwrap the lines
// when it says they can go up as themselves.
const built = async (b: any) => await perLineItems(b, OPTS);
const linesOf = async (b: any) => ((await built(b)) as any).lines;

// 1) No line items — nothing to do, the caller posts its summary line.
check('no rows -> summary line', (await built(bill({ total: '100' }))).kind, 'none');

// 2) Rows that don't add up to the bill are a mismatch, and the publish is
//    refused rather than quietly summarised.
const short = await built(bill({ total: '1139.05', lineItems: [row({ total: '315' }), row({ total: '3045' })] }));
check('rows that do not add up -> mismatch', [short.kind, (short as any).reason], ['mismatch', 'total']);
check('mismatch reports what the rows came to', (short as any).linesTotal, 3360);

// 3) The document states one GST figure: spread it across the rows, exactly.
let lines = await linesOf(bill({ total: '109', tax: '9', project: 'ASTP 01', lineItems: [row({ total: '60' }), row({ total: '49' })] }));
check('one GST figure: two lines', lines.length, 2);
check('one GST figure: tax sums to the bill', sum(lines, 'TaxAmount'), 9);
check('one GST figure: net + tax is the bill total', sum(lines, 'UnitAmount') + sum(lines, 'TaxAmount'), 109);
check('one GST figure: pro-rata by size', [lines[0].TaxAmount, lines[1].TaxAmount], [4.95, 4.05]);

// 4) Odd cents go somewhere — never lost, never invented.
lines = await linesOf(bill({ total: '100.10', tax: '0.10', lineItems: [row({ total: '33.37' }), row({ total: '33.37' }), row({ total: '33.36' })] }));
check('indivisible tax still sums exactly', sum(lines, 'TaxAmount'), 0.1);
check('indivisible tax: total preserved', sum(lines, 'UnitAmount') + sum(lines, 'TaxAmount'), 100.1);

// 5) Rows carrying their own tax are used as they are…
lines = await linesOf(bill({ total: '218', tax: '18', lineItems: [row({ total: '109', net: '100', tax: '9' }), row({ total: '109', net: '100', tax: '9' })] }));
check('per-row tax kept', [lines[0].TaxAmount, lines[1].TaxAmount], [9, 9]);
check('per-row tax: net posted exclusive', [lines[0].UnitAmount, lines[1].UnitAmount], [100, 100]);

// 6) …but rows whose tax disagrees with the bill are not massaged into agreeing.
const taxOff = await built(bill({ total: '218', tax: '18', lineItems: [row({ total: '109', tax: '9' }), row({ total: '109', tax: '5' })] }));
check('per-row tax that disagrees -> mismatch', [taxOff.kind, (taxOff as any).reason], ['mismatch', 'tax']);
check('tax mismatch reports the rows\u2019 tax', (taxOff as any).linesTax, 14);

// 7) Accounts: a line's own category is used when Xero has it, else the
//    document's chosen account — never a code Xero would reject.
lines = await linesOf(bill({ total: '200', lineItems: [row({ total: '100', category: '313A - Outlet Rental' }), row({ total: '100', category: '999 - Gone' })] }));
check('known line account used', lines[0].AccountCode, '313A');
check('unknown line account falls back to the document’s', lines[1].AccountCode, '429');

// 8) Tracking, across both categories.
lines = await linesOf(
  bill({
    total: '300',
    project: 'ASTP 02',
    lineItems: [
      row({ total: '100', project: 'ASTP 01', project2: 'Phase A' }),
      row({ total: '100' }),
      row({ total: '100', project: 'Closed project', project2: 'Not an option' }),
    ],
  })
);
check('both categories tagged', lines[0].Tracking, [{ Name: 'Projects', Option: 'ASTP 01' }, { Name: 'Projects 2', Option: 'Phase A' }]);
check('a silent row follows the bill', lines[1].Tracking, [{ Name: 'Projects', Option: 'ASTP 02' }]);
check('stale option dropped, bill’s not substituted for it', lines[2].Tracking, undefined);

// 10) A line's own tax code posts under that code; a blank one follows the bill.
//     Royal China: 17.82 of GST at 9% on 198.00, and 60.43 of discount taken off
//     the tax-inclusive bill — two lines, each with exactly its own rate's tax.
lines = await linesOf(
  bill({
    total: '155.39',
    tax: '17.82',
    lineItems: [
      row({ net: '198.00', tax: '17.82', total: '215.82', taxRate: 'Standard-Rated Purchases' }),
      row({ net: '-60.43', tax: '0.00', total: '-60.43', taxRate: 'No Tax' }),
    ],
  })
);
check('a split document goes up as two lines', lines.length, 2);
check('each under its own code', [lines[0].TaxType, lines[1].TaxType], ['INPUTY24', 'NONE']);
check('each with exactly its own tax', [lines[0].TaxAmount, lines[1].TaxAmount], [17.82, 0]);
check('the discount posts as a negative net', [lines[0].UnitAmount, lines[1].UnitAmount], [198, -60.43]);
check('and the money is the document\u2019s', sum(lines, 'UnitAmount') + sum(lines, 'TaxAmount'), 155.39);

lines = await linesOf(bill({ total: '218', tax: '18', lineItems: [row({ total: '109', net: '100', tax: '9' }), row({ total: '109', net: '100', tax: '9', taxRate: 'Zero-Rated Purchases' })] }));
check('blank follows the bill; a named code is its own', [lines[0].TaxType, lines[1].TaxType], ['INPUT', 'ZERORATEDINPUT']);
lines = await linesOf(bill({ total: '100', lineItems: [row({ total: '100', taxRate: 'Not A Rate Here' })] }));
check('a name the org does not have follows the bill', lines[0].TaxType, 'INPUT');

// 11) One stated GST figure is shared only across the rows that carry tax.
lines = await linesOf(bill({ total: '109', tax: '9', lineItems: [row({ total: '60' }), row({ total: '49', taxRate: 'No Tax' })] }));
check('a No Tax row takes no share of the stated GST', [lines[0].TaxAmount, lines[1].TaxAmount], [9, 0]);
check('...and still sums to the bill', sum(lines, 'TaxAmount'), 9);
const allNone = await built(bill({ total: '109', tax: '9', lineItems: [row({ total: '109', taxRate: 'No Tax' })] }));
check('every row No Tax with GST stated -> mismatch', [allNone.kind, (allNone as any).reason], ['mismatch', 'tax']);

// 9) Descriptions never go up blank.
lines = await linesOf(bill({ total: '100', lineItems: [row({ total: '100', description: '' })] }));
check('blank description falls back', lines[0].Description, 'Supplier bill');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, stub);
