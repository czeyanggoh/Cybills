// What POST /publish-bill actually sends to Xero. The arithmetic has its own
// test (publish-lines); this one is about the wiring: a bill whose line items
// are populated must reach the ledger AS those lines, a bill without them still
// goes up as one summary line, and a bill whose lines contradict it is refused
// outright rather than posted around.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-test-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';

// The linked client entity, as the organisations store holds it.
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Demo Co', tenantId: 'tenant-1', tenantName: 'Demo Co', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- stub relay --------------------------------------------------------------
let posted: any = null;
const linked: any[] = [];
const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0];
  res.setHeader('content-type', 'application/json');
  if (path.endsWith('/Accounts')) {
    res.end(JSON.stringify({ Accounts: [
      { Code: '315', Name: 'Outlet Laundry', Status: 'ACTIVE', Type: 'EXPENSE' },
      { Code: '313A', Name: 'Outlet Rental', Status: 'ACTIVE', Type: 'EXPENSE' },
      { Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE' },
    ] }));
    return;
  }
  if (path.endsWith('/Contacts')) {
    res.end(JSON.stringify({ Contacts: [{ ContactID: 'contact-cybiz', Name: 'CY-Biz Pte. Ltd.' }] }));
    return;
  }
  if (path.endsWith('/LinkedTransactions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      linked.push(JSON.parse(body || '{}'));
      res.end(JSON.stringify({ LinkedTransactions: [{ LinkedTransactionID: 'lt-1' }] }));
    });
    return;
  }
  if (path.endsWith('/TrackingCategories')) {
    res.end(JSON.stringify({ TrackingCategories: [
      { Name: 'Projects', Status: 'ACTIVE', Options: [{ Name: 'ASTP 01', Status: 'ACTIVE' }, { Name: 'ASTP 02', Status: 'ACTIVE' }] },
      { Name: 'Projects 2', Status: 'ACTIVE', Options: [{ Name: 'Phase A', Status: 'ACTIVE' }] },
    ] }));
    return;
  }
  if (path.endsWith('/Invoices')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posted = JSON.parse(body || '{}').Invoices?.[0] ?? null;
      res.end(JSON.stringify({
        Invoices: [{
          InvoiceID: 'inv-1',
          InvoiceNumber: 'BILL-1',
          Status: 'DRAFT',
          HasErrors: false,
          // Xero echoes the posted lines back WITH their ids — which is the only
          // way a billable expense can be created, since it needs them.
          LineItems: (posted?.LineItems ?? []).map((_: unknown, i: number) => ({ LineItemID: `li-${i + 1}` })),
        }],
      }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4602, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4602';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill } = await import('../src/store.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4603, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const bill = (fields: Record<string, unknown>) =>
  insertBill({
    orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'A1 Laundry', invoiceNumber: 'INV-9',
    documentType: 'Invoice', currency: 'SGD', date: '2026-07-31', category: '429 - General Expenses',
    description: 'Laundry services', total: '0', tax: '0',
    ...fields,
  } as any);

const publish = async (billId: string) => {
  posted = null;
  const res = await fetch('http://127.0.0.1:4603/api/xero/organisations/org-1/publish-bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billId, accountCode: '429', taxType: 'INPUT', status: 'DRAFT' }),
  });
  return { status: res.status, body: await res.json(), posted };
};

const row = (o: Record<string, unknown>) => ({ description: 'Row', category: '315 - Outlet Laundry', project: '', project2: '', net: '', tax: '', total: '', ...o });

// 1) Line items populated -> the bill goes up as those lines.
let r = await publish(
  bill({
    total: '705', tax: '0', project: 'ASTP 02',
    lineItems: [
      row({ description: 'Plaza towel service', total: '315', project: 'ASTP 01', project2: 'Phase A' }),
      row({ description: 'Linen bags', total: '240', category: '313A - Outlet Rental' }),
      row({ description: 'Daily towel service', total: '150' }),
    ],
  }).id
);
check('published ok', r.status, 200);
check('three lines reached Xero', r.posted.LineItems.length, 3);
check('response says how it went up', [r.body.lines, r.body.perLine], [3, true]);
check('each line its own amount', r.posted.LineItems.map((l: any) => l.UnitAmount), [315, 240, 150]);
check('each line its own description', r.posted.LineItems.map((l: any) => l.Description), ['Plaza towel service', 'Linen bags', 'Daily towel service']);
check('each line its own account', r.posted.LineItems.map((l: any) => l.AccountCode), ['315', '313A', '315']);
check('line 1 carries both projects', r.posted.LineItems[0].Tracking, [{ Name: 'Projects', Option: 'ASTP 01' }, { Name: 'Projects 2', Option: 'Phase A' }]);
check('a line with no project follows the bill', r.posted.LineItems[1].Tracking, [{ Name: 'Projects', Option: 'ASTP 02' }]);
check('the bill total is unchanged by the breakdown', r.posted.LineItems.reduce((t: number, l: any) => t + l.UnitAmount + l.TaxAmount, 0), 705);

// 2) GST stated once for the document: spread across the lines, total intact.
r = await publish(bill({ total: '109', tax: '9', lineItems: [row({ total: '60' }), row({ total: '49' })] }).id);
check('GST spread: two lines', r.posted.LineItems.length, 2);
check('GST spread: tax sums to the document', r.posted.LineItems.reduce((t: number, l: any) => t + l.TaxAmount, 0), 9);
check('GST spread: total sums to the document', r.posted.LineItems.reduce((t: number, l: any) => t + l.UnitAmount + l.TaxAmount, 0), 109);

// 3) Rows that don't add up -> nothing is posted at all. A breakdown that
//    contradicts its own document is a mistake to fix, not to publish around.
r = await publish(bill({ total: '1139.05', tax: '0', lineItems: [row({ total: '315' }), row({ total: '3045' })] }).id);
check('unreconciled: refused', r.status, 422);
check('unreconciled: nothing sent to Xero', r.posted, null);
check('unreconciled: says which way it is wrong', r.body.error, 'line_items_unreconciled');
check('unreconciled: names both figures', [r.body.linesTotal, r.body.reason], [3360, 'total']);

// 3b) Rows whose tax contradicts the document are refused the same way.
r = await publish(bill({ total: '218', tax: '18', lineItems: [row({ total: '109', tax: '9' }), row({ total: '109', tax: '5' })] }).id);
check('tax mismatch: refused', [r.status, r.body.reason], [422, 'tax']);
check('tax mismatch: nothing sent to Xero', r.posted, null);

// 3c) A cost incurred for a client, billed back to them: Xero's billable
//     expense. It cannot ride along on the bill — it needs the ids of a bill
//     that already exists — so it is a second call once the invoice comes back.
{
  linked.length = 0;
  const b = bill({ total: '109', tax: '0', customer: 'CY-Biz Pte. Ltd.', rebillable: true, lineItems: [row({ total: '60' }), row({ total: '49' })] });
  const out = await publish(b.id);
  check('rebillable: the bill still posts', out.status, 200);
  check('rebillable: one link per posted line', linked.length, 2);
  check('rebillable: each names the bill and its line', linked.map((l) => `${l.SourceTransactionID}/${l.SourceLineItemID}`), ['inv-1/li-1', 'inv-1/li-2']);
  check('rebillable: billed to the customer', [...new Set(linked.map((l) => l.ContactID))], ['contact-cybiz']);
  check('rebillable: reported as done', [out.body.rebilled.ok, out.body.rebilled.linked], [true, 2]);
}

// 3d) Not marked rebillable -> nothing is linked, whatever the customer says.
{
  linked.length = 0;
  const out = await publish(bill({ total: '50', tax: '0', customer: 'CY-Biz Pte. Ltd.' }).id);
  check('not rebillable: nothing is linked', linked.length, 0);
  check('not rebillable: nothing to report', out.body.rebilled, null);
}

// 3e) The flag alone is not enough: a rebillable cost with nobody to bill
//     cannot become a billable expense, and must not try.
{
  linked.length = 0;
  const out = await publish(bill({ total: '40', tax: '0', rebillable: true }).id);
  check('rebillable with no customer: nothing is linked', linked.length, 0);
  check('…and the bill still posts', out.status, 200);
}

// 4) No line items at all -> unchanged behaviour.
r = await publish(bill({ total: '50', tax: '0', project: 'ASTP 01' }).id);
check('no rows: one line', r.posted.LineItems.length, 1);
check('no rows: the document account', r.posted.LineItems[0].AccountCode, '429');

// Xero shows this as a "Go to CYBills" button on the bill — back to the
// document it was published from, with the original paper attached.
check('the bill links back to its document', /\/costs\/\d+\?org=org-1$/.test(String(r.posted.Url)), true);
check('no rows: the document project', r.posted.LineItems[0].Tracking, [{ Name: 'Projects', Option: 'ASTP 01' }]);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
server.close();
stub.close();
process.exit(failures ? 1 : 0);
