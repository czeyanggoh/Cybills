// The payment backfill: asking Xero about every bill this entity has already
// published, for the ones whose webhook fired before there was anything
// listening — or never fired at all.
//
// What it must get right is the batching (a whole book in a handful of calls,
// not one call per bill), reading the DAY out of either shape of Xero date, and
// reporting rather than hiding a bill Xero no longer has.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-syncpay-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

// A stubbed Xero that answers ?IDs= the way the real one does, and records how
// it was asked so the batching can be checked rather than assumed.
const batchCalls: string[][] = [];
const singleCalls: string[] = [];
const INVOICES: Record<string, Record<string, unknown>> = {
  'inv-paid': {
    InvoiceID: 'inv-paid',
    Status: 'PAID',
    FullyPaidOnDate: '/Date(1787702400000+0000)/', // 26 Aug 2026, Xero's other date shape
    Payments: [{ Reference: 'DBS transfer 4471' }],
  },
  'inv-owed': { InvoiceID: 'inv-owed', Status: 'AUTHORISED' },
  // Paid, but the list response left Payments out — the reference has to be
  // fetched by name or the column stays empty for exactly the rows it matters on.
  'inv-paid-noref': { InvoiceID: 'inv-paid-noref', Status: 'PAID', FullyPaidOnDate: '2026-08-01T00:00:00' },
};
const FULL: Record<string, Record<string, unknown>> = {
  'inv-paid-noref': { ...INVOICES['inv-paid-noref'], Payments: [{ Reference: 'cheque 00219' }] },
};

const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('content-type', 'application/json');
  const single = /\/Invoices\/([^/]+)$/.exec(path);
  if (single) {
    const id = single[1];
    singleCalls.push(id);
    return void res.end(JSON.stringify({ Invoices: [FULL[id] ?? INVOICES[id] ?? null].filter(Boolean) }));
  }
  if (path.endsWith('/Invoices')) {
    const ids = (url.searchParams.get('IDs') || '').split(',').filter(Boolean);
    batchCalls.push(ids);
    return void res.end(JSON.stringify({ Invoices: ids.map((id) => INVOICES[id]).filter(Boolean) }));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4620, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4620';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill, markBillPosted, getBillById } = await import('../src/store.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4621, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const mk = (orgId: string, supplier: string, invoiceId: string | null, tenantId = 't-cybm') => {
  const b = insertBill({
    orgId, kind: 'cost', status: 'ready', supplier, documentType: 'Invoice',
    currency: 'SGD', date: '2026-07-31', category: '429 - General Expenses',
    description: supplier, total: '100', tax: '0',
  } as any);
  if (invoiceId) markBillPosted(orgId, b.id, { xeroInvoiceId: invoiceId, xeroTenantId: tenantId, xeroTenantName: 'CYBM' });
  return b;
};

const paidBill = mk('cybm', 'Singtel', 'inv-paid');
const owedBill = mk('cybm', 'Sheng Siong', 'inv-owed');
const noRefBill = mk('cybm', 'M1', 'inv-paid-noref');
const goneBill = mk('cybm', 'Starhub', 'inv-deleted-in-xero');
const neverPublished = mk('cybm', 'Grab', null);
const otherEntity = mk('org-red', 'AWS', 'inv-paid', 't-red');

const sync = async (orgPath: string) => {
  const res = await fetch(`http://127.0.0.1:4621/api/xero/organisations/${orgPath}/sync-payments`, { method: 'POST' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const r = await sync('org-cybm');
check('the sweep runs', r.status, 200);
check('it checked only this book\'s published bills', r.body.checked, 4);
check('...counting the one Xero no longer has', r.body.missing, 1);
check('...and nothing is left over', r.body.remaining, 0);

// One call for the lot, not one per bill — this is what makes it affordable
// against 60 calls a minute.
check('the published bills were asked for in ONE batch', batchCalls.length, 1);
check('...naming every one of them', batchCalls[0]?.length, 4);

check('a paid bill records its status', getBillById('cybm', paidBill.id)?.xeroStatus, 'PAID');
check('...the day out of Xero\'s /Date(…)/ shape', getBillById('cybm', paidBill.id)?.xeroPaidDate, '2026-08-26');
check('...and its payment reference', getBillById('cybm', paidBill.id)?.xeroPaymentRef, 'DBS transfer 4471');
check('an unpaid bill records that instead', getBillById('cybm', owedBill.id)?.xeroStatus, 'AUTHORISED');
check('...with no invented paid date', getBillById('cybm', owedBill.id)?.xeroPaidDate, '');

// The one case worth a second call, and only that case.
check('a paid bill with no Payments in the batch is fetched by name', singleCalls, ['inv-paid-noref']);
check('...which is where its reference comes from', getBillById('cybm', noRefBill.id)?.xeroPaymentRef, 'cheque 00219');
check('...and its ISO paid date still reads', getBillById('cybm', noRefBill.id)?.xeroPaidDate, '2026-08-01');

// What it must NOT touch.
check('a bill Xero no longer has is left as it was', getBillById('cybm', goneBill.id)?.xeroStatus, undefined);
check('an unpublished document is never asked about', getBillById('cybm', neverPublished.id)?.xeroStatus, undefined);
check('another entity\'s book is untouched', getBillById('org-red', otherEntity.id)?.xeroStatus, undefined);
check('the reviewer\'s Paid toggle is never written', getBillById('cybm', paidBill.id)?.paid, undefined);

// Re-running is the repair for a dropped delivery, so it must be safe: same
// answers, nothing counted as newly updated.
const again = await sync('org-cybm');
check('a second run changes nothing', again.body.updated, 0);
check('...but still reports what it checked', again.body.checked, 4);

// Each entity sweeps its own book against its own tenant.
const red = await sync('org-red');
check('the second entity sweeps its own book', red.body.checked, 1);
check('...and its bill picks up the status', getBillById('org-red', otherEntity.id)?.xeroStatus, 'PAID');

server.close();
stub.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
