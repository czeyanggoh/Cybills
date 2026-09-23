// A document the business ISSUED reaches Xero as a SALES INVOICE.
//
// The Sales workspace could capture a document, read it and mark it Ready, and
// then had nowhere to send it: every publish path in the app built an ACCPAY
// bill, so a client's own invoice could only ever end in a CSV. This drives the
// real route over real HTTP against a stub relay, so what is asserted is the
// payload that actually goes to Xero — the Type, the Contact, the endpoint and
// the link back.
//
// The four records are two axes: payable vs receivable (the document's
// workspace) and invoice vs credit note (its own type). Each is checked here,
// because the pair that decides the endpoint and the pair that decides the
// section of Xero are not the same pair, and a document posted under the wrong
// one is a real figure in the wrong half of somebody's ledger.
import { finish } from './support.mts';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-sales-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';
// Xero refuses an invoice whose Url carries a port or an IP host, and this test
// reaches the server on 127.0.0.1 — without this the link is (rightly) dropped
// and there is nothing to assert about where it points.
process.env.APP_ORIGIN = 'https://cybills.example.com';

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
let creditPosted: any = null;
const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0];
  res.setHeader('content-type', 'application/json');
  if (path.endsWith('/Accounts')) {
    res.end(JSON.stringify({ Accounts: [
      { Code: '200', Name: 'Sales', Status: 'ACTIVE', Type: 'REVENUE' },
    ] }));
    return;
  }
  if (path.endsWith('/Organisation')) {
    res.end(JSON.stringify({ Organisations: [{ Name: 'Demo Co', BaseCurrency: 'SGD' }] }));
    return;
  }
  if (path.endsWith('/Currencies')) {
    res.end(JSON.stringify({ Currencies: [{ Code: 'SGD' }] }));
    return;
  }
  if (path.endsWith('/TrackingCategories')) {
    res.end(JSON.stringify({ TrackingCategories: [] }));
    return;
  }
  if (path.endsWith('/Invoices')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posted = JSON.parse(body || '{}').Invoices?.[0] ?? null;
      res.end(JSON.stringify({
        Invoices: [{ InvoiceID: 'inv-s1', InvoiceNumber: 'SI-1001', Status: 'DRAFT', HasErrors: false, LineItems: [] }],
      }));
    });
    return;
  }
  if (path.endsWith('/CreditNotes')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      creditPosted = JSON.parse(body || '{}').CreditNotes?.[0] ?? null;
      res.end(JSON.stringify({
        CreditNotes: [{ CreditNoteID: 'cn-s1', CreditNoteNumber: 'SCN-7', Status: 'DRAFT', HasErrors: false }],
      }));
    });
    return;
  }
  if (path.includes('/Attachments/')) {
    req.on('data', () => {});
    req.on('end', () => res.end(JSON.stringify({ Attachments: [{ AttachmentID: 'att-1' }] })));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4632, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4632';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill, getBillById, moveBillToKind } = await import('../src/store.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4633, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// A sales document as the Sales uploader stores one: `kind: 'sales'`, and the
// counterparty in `supplier` — one field read from the other end of the paper.
const sale = (fields: Record<string, unknown> = {}) =>
  insertBill({
    orgId: 'cybm', kind: 'sales', status: 'ready', supplier: 'ARC3 Nobel Pte Ltd',
    invoiceNumber: 'SI-1001', documentType: 'Invoice', currency: 'SGD', date: '2026-09-18',
    category: '200 - Sales', description: 'Consulting, September', total: '1090', tax: '90',
    ...fields,
  } as any);

const publish = async (billId: string, over: Record<string, unknown> = {}) => {
  posted = null;
  creditPosted = null;
  const res = await fetch('http://127.0.0.1:4633/api/xero/organisations/org-1/publish-bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billId, accountCode: '200', taxType: 'OUTPUT2', status: 'DRAFT', ...over }),
  });
  return { status: res.status, body: await res.json(), posted, creditPosted };
};

// 1) The whole point: a sales invoice goes up as a RECEIVABLE, under the
//    Invoices endpoint, against the customer it was issued to.
{
  const doc = sale();
  const r = await publish(doc.id);
  check('a sales invoice publishes', r.status, 200);
  check('…as ACCREC', r.posted?.Type, 'ACCREC');
  check('…to the Invoices endpoint', [Boolean(r.posted), r.creditPosted], [true, null]);
  check('…against the CUSTOMER as the contact', r.posted?.Contact, { Name: 'ARC3 Nobel Pte Ltd' });
  check('…carrying its own invoice number', r.posted?.InvoiceNumber, 'SI-1001');
  check('…and the money as read', [r.posted?.LineItems?.[0]?.UnitAmount, r.posted?.LineItems?.[0]?.TaxAmount], [1000, 90]);
  check('…coded to the revenue account at the output rate',
    [r.posted?.LineItems?.[0]?.AccountCode, r.posted?.LineItems?.[0]?.TaxType], ['200', 'OUTPUT2']);
  // "Go to CYBills" has to land on the page the document actually lives on: a
  // sales document opened at /costs/<id> is a page that finds nothing.
  check('…linking back to the Sales page it came from',
    String(r.posted?.Url ?? '').includes('/sales/'), true);
  check('…never to Costs', String(r.posted?.Url ?? '').includes('/costs/'), false);

  const stored = getBillById('cybm', doc.id);
  check('the document records what it went up as', stored?.xeroDocType, 'ACCREC');
  check('…and is archived by publishing, like a cost',
    [stored?.xeroInvoiceId, stored?.status], ['inv-s1', 'archived']);
}

// 2) A CREDIT NOTE the business issued is a customer credit note — its own
//    endpoint, its own id field. Decided by the TYPE, and the workspace decides
//    which side of the ledger it lands on.
{
  const r = await publish(sale({ documentType: 'Credit note/refund', invoiceNumber: 'SCN-7', total: '-109', tax: '-9' }).id);
  check('a sales credit note publishes', r.status, 200);
  check('…as ACCRECCREDIT', r.creditPosted?.Type, 'ACCRECCREDIT');
  check('…to the CreditNotes endpoint, never Invoices', [Boolean(r.creditPosted), r.posted], [true, null]);
  // Xero carries the direction in the record's Type, not in the sign, so a
  // total typed the way the paper shows a credit is flipped positive.
  check('…with positive amounts', [r.creditPosted?.LineItems?.[0]?.UnitAmount, r.creditPosted?.LineItems?.[0]?.TaxAmount], [100, 9]);
  check('…and the number as CreditNoteNumber', r.creditPosted?.CreditNoteNumber, 'SCN-7');
}

// 3) A cost is untouched by any of it — same route, same builder, still ACCPAY.
{
  const cost = insertBill({
    orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'A1 Laundry', invoiceNumber: 'INV-9',
    documentType: 'Invoice', currency: 'SGD', date: '2026-09-18', category: '200 - Sales',
    description: 'Laundry', total: '109', tax: '9',
  } as any);
  const r = await publish(cost.id);
  check('a cost still publishes as a bill', [r.status, r.posted?.Type], [200, 'ACCPAY']);
  check('…linking back to Costs', String(r.posted?.Url ?? '').includes('/costs/'), true);
}

// 4) Incomplete is refused in the words the Sales page uses. "This document
//    still needs a supplier" sends somebody looking for a field that workspace
//    does not have.
{
  const r = await publish(sale({ supplier: '' }).id);
  check('a nameless sales invoice is refused', r.status, 400);
  check('…asking for a customer, not a supplier', r.body?.missing, ['a customer']);
  const r2 = await publish(sale({ supplier: 'Unknown customer' }).id);
  check('and the reader’s own placeholder is no name either', r2.body?.missing, ['a customer']);
}

// 5) Publishing twice is refused the same way a bill's is — one invoice, one
//    record in the ledger.
{
  const doc = sale();
  await publish(doc.id);
  const again = await publish(doc.id);
  check('a second publish is refused', [again.status, again.body?.error], [409, 'already_posted']);
}

// 6) A document filed into the wrong workspace is MOVED, and its coding does
//    not travel. Unlike a move between entities — where the codes are names in
//    a chart the document has left, and so mean nothing — these are names in
//    the same chart and so are WRONG rather than meaningless, which is worse:
//    they would still post. A supply code recording output tax standing on a
//    cost claims input tax under it.
{
  const doc = sale({ taxRate: 'GST on Income', category: '200 - Sales' });
  const moved = moveBillToKind('cybm', doc.id, 'cost');
  check('the document changes workspace', moved?.kind, 'cost');
  check('…and arrives uncoded, both halves', [moved?.category, moved?.taxRate], ['', '']);
  check('…saying why', String(moved?.taxRateReason ?? '').includes('opposite side of the ledger'), true);
  // Readiness is derived, so clearing the category is what puts it in To
  // review — it is not written there.
  check('…waiting on a person, not Ready', moved?.status, 'new');
  // Nobody chose a blank: they chose a code for the workspace it has left.
  check('…and no hand-picked marker survives',
    [moved?.taxRateEdited, moved?.taxRateCleared], [false, false]);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
server.close();
stub.close();
await finish(failures, server);
