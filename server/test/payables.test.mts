// The payables hand-off to CYWorkspace's payment run.
//
// CYWS's Bills Listing is built from AUTHORISED bills already in Xero, so a
// document CYBills had read and coded but not yet published did not exist as far
// as a payment run was concerned. These three routes are the seam: what is
// waiting to be paid, the paper the payee's bank details are read off, and the
// publish that puts a document in the ledger so it can be paid.
//
// Driven over REAL HTTP against the real server, not by mounting the router —
// two of the things being asserted live outside it. The session guard has to let
// these through (they carry a shared key instead of a session, and the last time
// a machine route was guarded by mistake it locked out exactly the callers it
// existed for), and the guard is in index.ts.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-payables-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
// Sign-in configured, which is what production looks like. Without it the
// server stays open for local development and the allowlist would prove nothing.
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';
process.env.WHATSAPP_INBOUND_KEY = 'cyws-key';
process.env.CYWORKSPACE_API_KEY = 'relay-key';
process.env.PORT = '4644';

// Two linked entities on two different Xero tenants — because one key opens
// every client's book here, and naming the wrong tenant must not post one
// client's bill into another's ledger.
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Demo Co', tenantId: 'tenant-1', tenantName: 'Demo Co', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-2', orgId: 'cybm', name: 'Other Co', tenantId: 'tenant-2', tenantName: 'Other Co', createdAt: new Date(1000).toISOString(), createdBy: '' },
    ],
  })
);

// --- stub relay --------------------------------------------------------------
let posted: any = null;
let postCount = 0;
const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0];
  res.setHeader('content-type', 'application/json');
  if (path.endsWith('/Accounts')) {
    res.end(JSON.stringify({ Accounts: [
      { Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'NONE' },
      { Code: '493', Name: 'Travel - National', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'NONE' },
    ] }));
    return;
  }
  if (path.endsWith('/TaxRates')) {
    res.end(JSON.stringify({ TaxRates: [
      { Name: 'Standard-Rated Purchases', TaxType: 'INPUTY24', Status: 'ACTIVE', EffectiveRate: 9, CanApplyToExpenses: true },
      { Name: 'No Tax', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0, CanApplyToExpenses: true },
    ] }));
    return;
  }
  if (path.endsWith('/Organisation')) {
    res.end(JSON.stringify({ Organisations: [{ Name: 'Demo Co', BaseCurrency: 'SGD' }] }));
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
      postCount++;
      res.end(JSON.stringify({ Invoices: [{
        InvoiceID: 'inv-99', InvoiceNumber: 'BILL-99', Status: 'AUTHORISED', HasErrors: false,
        AmountDue: 109, Total: 109, CurrencyCode: 'SGD',
        Contact: { ContactID: posted?.Contact?.ContactID ?? '' },
        LineItems: [],
      }] }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4645, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4645';

const { insertBill } = await import('../src/store.ts');
const { dataScopeForOrg } = await import('../src/organisations.ts');
// The real server, guard and all.
await import('../src/index.ts');
await new Promise((r) => setTimeout(r, 200));

const BASE = 'http://127.0.0.1:4644';
const KEY = { 'X-API-Key': 'cyws-key' };

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const book1 = dataScopeForOrg('org-1');
const book2 = dataScopeForOrg('org-2');

const bill = (orgId: string, fields: Record<string, unknown>) =>
  insertBill({
    orgId, kind: 'cost', status: 'ready', supplier: 'A1 Consultancy', invoiceNumber: 'INV-9',
    documentType: 'Invoice', currency: 'SGD', date: '2026-07-31', category: '429 - General Expenses',
    taxRate: 'Standard-Rated Purchases', description: 'Consulting', total: '109', tax: '9',
    ...fields,
  } as any);

// --- the book ----------------------------------------------------------------
const waiting = bill(book1, { supplier: 'A1 Consultancy', storageKey: 'local:a1.pdf', contentType: 'application/pdf' });
const alsoWaiting = bill(book1, { supplier: 'Grab', category: '493 - Travel - National', taxRate: 'No Tax', total: '28.30', tax: '0' });
// Every one of these is a way of paying money twice, or paying it for nothing.
bill(book1, { supplier: 'Paid Already', paid: true });
bill(book1, { supplier: 'Set Aside', status: 'archived' });
bill(book1, { supplier: 'On A Claim', status: 'expenseclaim' });
bill(book1, { supplier: 'Merged Away', status: 'merged' });
bill(book1, { supplier: 'Half Read', category: '', total: '0' });
bill(book1, { supplier: 'In Xero', xeroInvoiceId: 'inv-old' });
bill(book1, { supplier: 'A Sales Invoice', kind: 'sales' });
// Coded to an account this chart doesn't have: listed, but never offered as
// payable — the alternative is a row that gets a contact made for it in Xero
// and only then refuses.
const unpostable = bill(book1, { supplier: 'Odd Coding', category: '999 - Nowhere' });
// Another client's ledger entirely.
const elsewhere = bill(book2, { supplier: 'Other Co Supplier' });

// --- listing -----------------------------------------------------------------
const list = async (tenant: string, headers: Record<string, string> = KEY) => {
  const res = await fetch(`${BASE}/api/payments/bills?tenant_id=${tenant}`, { headers });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

let r = await list('tenant-1', {});
check('no key: refused', [r.status, r.body.error], [401, 'bad_key']);
check('and the guard let it reach the route rather than 401-ing as unauthenticated', r.body.error, 'bad_key');

r = await list('tenant-1');
const suppliers = (r.body.bills ?? []).map((b: any) => b.supplier).sort();
check('lists what is waiting to be paid, and nothing else', suppliers, ['A1 Consultancy', 'Grab', 'Odd Coding']);
check('one client entity, named', r.body.organisations, [{ id: 'org-1', name: 'Demo Co' }]);

const byId = new Map((r.body.bills ?? []).map((b: any) => [b.id, b]));
check('the codes it would post under are said up front', [byId.get(waiting.id).account_code, byId.get(waiting.id).tax_type], ['429', 'INPUTY24']);
check("a document's own tax rate wins over the account default", byId.get(alsoWaiting.id).tax_type, 'NONE');
check('a row that could not post says so', byId.get(unpostable.id).postable, false);
check('and says why', byId.get(unpostable.id).blocked_reason.includes('999'), true);
check('a payable row is marked payable', byId.get(waiting.id).postable, true);
check('the paper is offered on the machine route', byId.get(waiting.id).file_url.includes(`/api/payments/bills/${waiting.id}/file`), true);
check('a document with no stored file offers no link', [byId.get(unpostable.id).has_file, byId.get(unpostable.id).file_url], [false, '']);
check('the money is the document’s own', [byId.get(waiting.id).total, byId.get(waiting.id).tax, byId.get(waiting.id).currency], [109, 9, 'SGD']);

r = await list('tenant-2');
check("another tenant sees only its own", (r.body.bills ?? []).map((b: any) => b.supplier), ['Other Co Supplier']);

r = await list('tenant-nobody');
check('a tenant CYBills has never heard of is an empty list, not an error', [r.status, r.body.bills.length], [200, 0]);

r = await list('');
check('and a request naming no tenant at all is refused', [r.status, r.body.error], [400, 'tenant_id_required']);

// --- the file ----------------------------------------------------------------
{
  const res = await fetch(`${BASE}/api/payments/bills/${waiting.id}/file`);
  check('the paper needs the key too', res.status, 401);
}

// --- publishing --------------------------------------------------------------
const publish = async (id: string, body: Record<string, unknown>, headers: Record<string, string> = KEY) => {
  posted = null;
  const res = await fetch(`${BASE}/api/payments/bills/${id}/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any, posted };
};

r = await publish(waiting.id, { tenant_id: 'tenant-1', contact_id: 'contact-9' }, {});
check('publishing needs the key', [r.status, r.body.error], [401, 'bad_key']);

r = await publish(waiting.id, { tenant_id: 'tenant-1' });
check('and a contact to post against', [r.status, r.body.error], [400, 'missing_field']);
check('nothing reached Xero', r.posted, null);

r = await publish(elsewhere.id, { tenant_id: 'tenant-1', contact_id: 'contact-9' });
check("a document belonging to another client's ledger is refused", [r.status, r.body.error], [409, 'tenant_mismatch']);
check('and nothing reached Xero', r.posted, null);

r = await publish(unpostable.id, { tenant_id: 'tenant-1', contact_id: 'contact-9' });
check('a document with no account in the chart is refused', [r.status, r.body.error], [422, 'account_not_in_chart']);

r = await publish(waiting.id, { tenant_id: 'tenant-1', contact_id: 'contact-9' });
check('published', r.status, 200);
// Xero validates an invoice's Url and refuses the WHOLE invoice over it —
// "Custom ports are not allowed in invoice url / Url host cannot be an IP
// address". This test reaches the server on 127.0.0.1:4644, which breaks both
// rules at once, and that is not a contrivance: it is what a call from
// CYWorkspace across the VPS looks like. Publishing from a browser had always
// carried the public host, so the first bill published by MACHINE was the first
// one Xero refused. A link it won't take is not sent.
check('no link is sent when the origin is one Xero would refuse', 'Url' in r.posted, false);
// The whole reason publish takes a contact id: Xero matches a contact by NAME
// when given one and CREATES one when the name is new, so a bill posted as
// "A1 Consultancy" against a contact CYWS made as "A1" would land on a second,
// bank-detail-less contact and the payment file would have nowhere to send it.
check('the bill is posted against the contact CYWS made, by id', r.posted.Contact, { ContactID: 'contact-9' });
check('never by name', Object.keys(r.posted.Contact), ['ContactID']);
// Xero will not accept a payment against a DRAFT or SUBMITTED bill, so anything
// else here would produce a bank file for a bill the ledger refuses to settle.
check('and AUTHORISED, so it can actually be paid', r.posted.Status, 'AUTHORISED');
check('the invoice comes back for the payment line', [r.body.invoice.invoiceId, r.body.invoice.amountDue], ['inv-99', 109]);

// A run that published five bills and then failed to build its file is re-run by
// somebody pressing the button again. Each of those five must answer with the
// invoice it already has rather than posting a second copy.
const before = postCount;
r = await publish(waiting.id, { tenant_id: 'tenant-1', contact_id: 'contact-9' });
check('publishing the same document twice is answered, not repeated', [r.status, r.body.already_published], [200, true]);
check('it names the bill that already exists', r.body.invoice.invoiceId, 'inv-99');
check('and posts nothing', postCount, before);

r = await list('tenant-1');
check('a published document leaves the payables list', (r.body.bills ?? []).map((b: any) => b.supplier).sort(), ['Grab', 'Odd Coding']);

// The list a run is working from can go stale between reading it and committing
// it — somebody archives a document, or marks it paid.
{
  const { getBillById, updateBill } = await import('../src/store.ts');
  updateBill(book1, alsoWaiting.id, { paid: true } as never);
  check('(the document really is marked paid)', getBillById(book1, alsoWaiting.id)?.paid, true);
  r = await publish(alsoWaiting.id, { tenant_id: 'tenant-1', contact_id: 'contact-9' });
  check('a document marked paid since the list was read is refused', [r.status, r.body.error], [409, 'not_payable']);
  check('and nothing reached Xero', r.posted, null);
}

// --- what Xero will and won't take as an invoice Url --------------------------
// Both directions, because a guard that drops everything would "pass" the check
// above while quietly costing every published bill its "Go to CYBills" button.
{
  const { xeroInvoiceUrl } = await import('../src/xero.ts');
  const takes = (u: string) => xeroInvoiceUrl(u) !== '';
  check('a public https origin is kept', xeroInvoiceUrl('https://cybills.cy-bm.sg/costs/2608?org=org-1'), 'https://cybills.cy-bm.sg/costs/2608?org=org-1');
  check('a loopback address is not', takes('http://127.0.0.1:3004/costs/2608'), false);
  check('nor a public host on a custom port', takes('https://cybills.cy-bm.sg:8443/costs/2608'), false);
  check('nor localhost', takes('http://localhost/costs/2608'), false);
  check('nor a bare hostname with no domain', takes('https://cybills/costs/2608'), false);
  check('nor an IPv6 address', takes('http://[::1]/costs/2608'), false);
  check('nor something that is not a URL at all', takes('/costs/2608'), false);
}

stub.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll payables checks passed');
process.exit(failures ? 1 : 0);
