// Sending a correction to a bill that is already in Xero.
//
// The thing that must not happen here is a SECOND bill: a document whose
// figures were fixed after publishing has one bill in the ledger, and an
// "update" that created another would leave the first to be found and voided by
// somebody who may not know it exists. So this pins the method (POST, not the
// create-only PUT), the InvoiceID that makes Xero restate rather than create,
// and what the route refuses.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-xeroupdate-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// A stubbed Xero that records HOW it was asked, and can be told to refuse the
// way a paid bill really does.
let seen: { method: string; body: any } | null = null;
let refuse = '';
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('content-type', 'application/json');
  if (path.endsWith('/Accounts')) return void res.end(JSON.stringify({ Accounts: [{ Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE' }] }));
  if (path.endsWith('/TrackingCategories')) return void res.end(JSON.stringify({ TrackingCategories: [] }));
  if (path.endsWith('/Invoices')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen = { method: String(req.method), body };
      const sent = body?.Invoices?.[0] ?? {};
      if (refuse) {
        return void res.end(JSON.stringify({ Invoices: [{ ...sent, HasErrors: true, ValidationErrors: [{ Message: refuse }] }] }));
      }
      res.end(JSON.stringify({
        Invoices: [{
          InvoiceID: sent.InvoiceID || 'inv-new',
          InvoiceNumber: 'BILL-1',
          Status: sent.Status || 'AUTHORISED',
          HasErrors: false,
        }],
      }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4624, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4624';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill, markBillPosted, getBillById, updateBill } = await import('../src/store.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4625, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const mk = (supplier: string, published: boolean) => {
  const b = insertBill({
    orgId: 'cybm', kind: 'cost', status: 'ready', supplier, invoiceNumber: 'INV-1', documentType: 'Invoice',
    currency: 'AUD', date: '2026-07-31', category: '429 - General Expenses', description: supplier,
    total: '717.75', tax: '0',
  } as any);
  if (published) markBillPosted('cybm', b.id, { xeroInvoiceId: 'inv-existing', xeroTenantId: 't-cybm', xeroTenantName: 'CYBM' });
  return b;
};

const posted = mk('Deputec Pty Ltd', true);
const neverPosted = mk('Grab', false);

const update = async (billId: string, extra: Record<string, unknown> = {}) => {
  seen = null;
  const res = await fetch('http://127.0.0.1:4625/api/xero/organisations/org-cybm/update-bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billId, accountCode: '429', taxType: 'NONE', ...extra }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let r = await update(posted.id);
check('the update is accepted', r.status, 200);
// The two facts that make it an update rather than a second bill.
check('...sent as POST, not the create-only PUT', seen?.method, 'POST');
check('...naming the invoice it is restating', seen?.body?.Invoices?.[0]?.InvoiceID, 'inv-existing');
check('...and it reports the same invoice back', r.body.invoice?.invoiceId, 'inv-existing');

// The document's current figures are what goes up.
check('the current total is what is sent', seen?.body?.Invoices?.[0]?.LineItems?.[0]?.UnitAmount, 717.75);
check('...in the document\'s own currency', seen?.body?.Invoices?.[0]?.CurrencyCode, 'AUD');

// Status is left alone unless the reviewer asks: correcting an approved bill's
// coding must not knock it back to draft and out of somebody's approval queue.
check('no status is sent by default', 'Status' in (seen?.body?.Invoices?.[0] ?? {}), false);
r = await update(posted.id, { status: 'AUTHORISED' });
check('...but one asked for is sent', seen?.body?.Invoices?.[0]?.Status, 'AUTHORISED');

// What it refuses.
r = await update(neverPosted.id);
check('a document with no bill in Xero is refused', r.status, 400);
check('...as not_published, pointing at publish instead', r.body.error, 'not_published');
check('...and nothing was sent to Xero', seen, null);

updateBill('cybm', posted.id, { category: '' });
r = await update(posted.id);
check('a document that has LOST a field is refused', r.status, 400);
check('...so an update cannot blank it in the ledger', r.body.error, 'incomplete');
updateBill('cybm', posted.id, { category: '429 - General Expenses' });

// Xero's own refusal — a paid bill will not take an amount change — is passed
// through in Xero's words rather than translated into a guess.
refuse = 'Invoice not of valid status for modification.';
r = await update(posted.id);
check('Xero refusing is reported as 422', r.status, 422);
check('...in Xero\'s own words', r.body.messages, ['Invoice not of valid status for modification.']);
refuse = '';

// A successful update refreshes what the document knows about the bill, rather
// than leaving it to the next webhook.
r = await update(posted.id, { status: 'AUTHORISED' });
check('the answer updates the stored Xero status', getBillById('cybm', posted.id)?.xeroStatus, 'AUTHORISED');
check('the document is still linked to the SAME bill', getBillById('cybm', posted.id)?.xeroInvoiceId, 'inv-existing');

server.close();
stub.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
