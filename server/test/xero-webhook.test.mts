// Inbound Xero webhooks: what the receiver must refuse, and what a paid invoice
// does to the document that was published as it.
//
// The rules being pinned here are Xero's, not ours: an unsigned or wrongly
// signed POST is a 401 (which is also how the "intent to receive" handshake is
// answered), a signed one is a 200 sent BEFORE any Xero read-back, and the
// event itself never says "paid" — the status has to be read back from Xero.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-xerohook-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.XERO_WEBHOOK_KEY = 'test-webhook-key';
process.env.CYWORKSPACE_API_KEY = 'test-relay-key';
process.env.CYWORKSPACE_RELAY_URL = 'http://relay.invalid';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { xeroWebhookRouter, flushXeroWebhooks, verifyXeroSignature } = await import('../src/xeroWebhook.ts');
const { insertBill, markBillPosted, getBillById } = await import('../src/store.ts');

// --- a stubbed Xero -------------------------------------------------------
// The relay is the only thing between us and Xero, so stubbing fetch stubs
// Xero. `asked` records every invoice read, which is how "an event for an
// invoice we never published costs nothing" is checked.
const asked: string[] = [];
const statuses = new Map<string, string>();
const payments = new Map<string, Array<{ Reference?: string }>>();
const paidOn = new Map<string, string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const m = /xero-relay\/Invoices\/([^?]+)/.exec(url);
  // The test posts to its own server through fetch too; only relay traffic is
  // Xero's to answer.
  if (!m) return realFetch(input, init);
  const invoiceId = decodeURIComponent(m[1]);
  asked.push(invoiceId);
  const Status = statuses.get(invoiceId) ?? 'AUTHORISED';
  const invoice: Record<string, unknown> = { InvoiceID: invoiceId, Status };
  if (paidOn.has(invoiceId)) invoice.FullyPaidOnDate = paidOn.get(invoiceId);
  if (payments.has(invoiceId)) invoice.Payments = payments.get(invoiceId);
  return new Response(JSON.stringify({ Invoices: [invoice] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

const mk = (supplier: string, invoiceId: string) => {
  const bill = insertBill({
    orgId: 'cybm', kind: 'cost', status: 'ready', supplier, documentType: 'Invoice',
    currency: 'SGD', date: '2026-08-20', category: '429 - General Expenses',
    description: supplier, total: '100', tax: '0',
  } as any);
  markBillPosted('cybm', bill.id, { xeroInvoiceId: invoiceId, xeroTenantId: 't-cybm', xeroTenantName: 'CYBM' });
  return bill;
};

const published = mk('Singtel', 'inv-published');
const stillOwed = mk('Sheng Siong', 'inv-owed');

const app = express();
app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }), xeroWebhookRouter);
const server = app.listen(4617, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const url = 'http://127.0.0.1:4617/api/webhooks/xero';

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

const payloadFor = (events: unknown[]) =>
  JSON.stringify({ events, lastEventSequence: 1, firstEventSequence: 1, entropy: 'S0m3r4Nd0mt3xt' });

const sign = (body: string) =>
  createHmac('sha256', process.env.XERO_WEBHOOK_KEY as string).update(body).digest('base64');

const post = (body: string, signature: string | null) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature === null ? {} : { 'x-xero-signature': signature }) },
    body,
  });

const invoiceEvent = (resourceId: string) => ({
  resourceUrl: 'https://api.xero.com/api.xro/2.0/Invoices',
  resourceId,
  eventDateUtc: '2026-08-26T01:15:39.902',
  eventType: 'Update',
  eventCategory: 'INVOICE',
  tenantId: 't-cybm',
  tenantType: 'ORGANISATION',
});

// --- the signature is the whole door --------------------------------------
const body = payloadFor([invoiceEvent('inv-published')]);
check('unsigned POST is refused', (await post(body, null)).status, 401);
check('wrongly signed POST is refused', (await post(body, sign(body + 'x'))).status, 401);
check('intent-to-receive (bad signature) is refused', (await post(payloadFor([]), 'aW50ZW50')).status, 401);
check('a tampered body no longer matches its signature', (await post(payloadFor([invoiceEvent('inv-owed')]), sign(body))).status, 401);
check('nothing was read from Xero for any of those', asked, []);
check('verifyXeroSignature agrees with the route', verifyXeroSignature(Buffer.from(body), sign(body)), true);

// --- a signed delivery ----------------------------------------------------
// Xero's own words are recorded, with the payment behind them. The document's
// `paid` toggle is a DIFFERENT question - the reviewer's capture-time flag, in
// Dext's sense - and the webhook must never write it.
statuses.set('inv-published', 'PAID');
paidOn.set('inv-published', '2026-08-26T00:00:00');
payments.set('inv-published', [{ Reference: 'PayNow 26 Aug' }]);
check('signed POST is accepted', (await post(body, sign(body))).status, 200);
await flushXeroWebhooks();
check("Xero's status is recorded", getBillById('cybm', published.id)?.xeroStatus, 'PAID');
check('...with the date it was fully paid', getBillById('cybm', published.id)?.xeroPaidDate, '2026-08-26');
check('...and the payment reference', getBillById('cybm', published.id)?.xeroPaymentRef, 'PayNow 26 Aug');
check("the reviewer's Paid toggle is left alone", getBillById('cybm', published.id)?.paid, undefined);
check('one read-back, for the one invoice named', asked, ['inv-published']);

// An invoice still owed says so, and an event naming an invoice CYBills never
// published is not ours to read.
const owed = payloadFor([invoiceEvent('inv-owed'), invoiceEvent('inv-someone-elses')]);
check('second delivery accepted', (await post(owed, sign(owed))).status, 200);
await flushXeroWebhooks();
check('an approved-but-unpaid invoice says so', getBillById('cybm', stillOwed.id)?.xeroStatus, 'AUTHORISED');
check('...with no paid date', getBillById('cybm', stillOwed.id)?.xeroPaidDate, '');
check('an unknown invoice costs no Xero call', asked, ['inv-published', 'inv-owed']);

// A payment reversed in Xero puts the document back.
statuses.set('inv-published', 'AUTHORISED');
paidOn.delete('inv-published');
payments.delete('inv-published');
check('third delivery accepted', (await post(body, sign(body))).status, 200);
await flushXeroWebhooks();
check('un-paying in Xero un-pays the status', getBillById('cybm', published.id)?.xeroStatus, 'AUTHORISED');
check('...and clears the paid date', getBillById('cybm', published.id)?.xeroPaidDate, '');
check('...and the reference', getBillById('cybm', published.id)?.xeroPaymentRef, '');

// A voided bill is not "unpaid" - it is voided, and the document says so
// rather than sitting there looking like it is still awaiting payment.
statuses.set('inv-published', 'VOIDED');
check('fourth delivery accepted', (await post(body, sign(body))).status, 200);
await flushXeroWebhooks();
check('a voided bill is recorded as voided', getBillById('cybm', published.id)?.xeroStatus, 'VOIDED');
statuses.set('inv-published', 'AUTHORISED');
await post(body, sign(body));
await flushXeroWebhooks();

// Only INVOICE events are ours; a CONTACT event in the same batch is ignored.
const mixed = payloadFor([{ ...invoiceEvent('inv-published'), eventCategory: 'CONTACT' }]);
check('a non-invoice event is accepted', (await post(mixed, sign(mixed))).status, 200);
await flushXeroWebhooks();
check('...and read nothing', asked, ['inv-published', 'inv-owed', 'inv-published', 'inv-published', 'inv-published']);

// A CREATE is the echo of our own publish — the only thing it could tell us is
// what we just wrote — so it is dropped before the read-back too.
const readsSoFar = [...asked];
statuses.set('inv-published', 'PAID');
const created = payloadFor([{ ...invoiceEvent('inv-published'), eventType: 'Create' }]);
check('a create event is accepted', (await post(created, sign(created))).status, 200);
await flushXeroWebhooks();
check('...and reads nothing', asked, readsSoFar);
check('...and leaves the document alone', getBillById('cybm', published.id)?.xeroStatus, 'AUTHORISED');

// The same invoice, this time as an update, still gets through.
check('an update after it is accepted', (await post(body, sign(body))).status, 200);
await flushXeroWebhooks();
check('...and is read back', asked, [...readsSoFar, 'inv-published']);
check('...and records it as paid', getBillById('cybm', published.id)?.xeroStatus, 'PAID');

globalThis.fetch = realFetch;
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
