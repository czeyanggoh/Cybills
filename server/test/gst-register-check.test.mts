// The IRAS GST register check end to end, with cyworkspace and Xero stubbed: a
// supplier not registered on the invoice date is held at No Tax (and the publish
// that found it out is declined once); a registered one has its numbers written
// to the Xero contact BEFORE the bill goes up; a contact that already holds a
// number is never asked about; no answer changes nothing.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-gstreg-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';
process.env.APP_ORIGIN = 'https://cybills.example.com';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Demo Co', tenantId: 'tenant-1', tenantName: 'Demo Co', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- stubs ---------------------------------------------------------------
let answer: any = null; // null = cyworkspace cannot answer
const asked: any[] = [];
let contacts: any[] = [];
const order: string[] = [];
const contactWrites: Array<{ method: string; body: any }> = [];

const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0];
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw && raw.startsWith('{') ? JSON.parse(raw) : null;
    const send = (o: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (path === '/api/webhooks/cybills/gst-check') {
      asked.push(body);
      return send(answer ?? { available: false, reason: 'limit' });
    }
    if (path.endsWith('/Contacts')) {
      if (req.method === 'GET') {
        const where = new URL(String(req.url), 'http://x').searchParams.get('where') ?? '';
        const name = /Name=="(.*)"/.exec(where)?.[1];
        return send({ Contacts: contacts.filter((c) => !name || c.Name === name) });
      }
      order.push('contact');
      contactWrites.push({ method: String(req.method), body });
      return send({ Contacts: [{ ContactID: 'c-new', ...body.Contacts[0] }] });
    }
    if (path.endsWith('/Accounts')) return send({ Accounts: [{ Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE' }] });
    if (path.endsWith('/Organisation')) return send({ Organisations: [{ Name: 'Demo Co', BaseCurrency: 'SGD' }] });
    if (path.endsWith('/Currencies')) return send({ Currencies: [{ Code: 'SGD' }] });
    if (path.endsWith('/TrackingCategories')) return send({ TrackingCategories: [] });
    if (path.endsWith('/Invoices') && req.method !== 'GET') {
      order.push('bill');
      return send({ Invoices: [{ InvoiceID: 'inv-1', InvoiceNumber: 'B-1', Status: 'DRAFT', HasErrors: false, LineItems: [{ LineItemID: 'li-1' }] }] });
    }
    if (path.includes('/Attachments/')) return send({ Attachments: [{}] });
    return send({ error: 'not_found', path }, 404);
  });
});
await new Promise<void>((r) => stub.listen(4691, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4691';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill, getBillById, updateBill } = await import('../src/store.ts');
const { runGstCheck, gstCheckFor, saveGstToContact } = await import('../src/gstCheck.ts');
const { keepPracticeNoTax } = await import('../src/practiceNoTax.ts');
const { knownGstRegNo } = await import('../src/supplierGst.ts');
const { withRegisteredName } = await import('../src/gstCheck.ts');
const { relay } = await import('../src/xero.ts');
// A write through the relay drops the cached contact list, as it does live.
const xeroNowHolds = async (rows: any[]) => {
  contacts = rows;
  await relay('Contacts', { method: 'POST', tenantId: 'tenant-1', body: { Contacts: [{ ContactID: 'x' }] } });
};

const app = express();
app.use(express.json());
app.use('/api/xero', xeroRouter);
const server = app.listen(4692, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

let n = 0;
const bill = (fields: Record<string, unknown> = {}) => {
  n += 1;
  const b = insertBill({
    orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'Acme Hardware Pte Ltd', invoiceNumber: `INV-${n}`,
    documentType: 'Invoice', currency: 'SGD', date: '2026-11-20', category: '429 - General Expenses',
    description: 'Nails', total: 109, tax: 9, taxRate: 'Standard-Rated Purchases', fileHash: `h${n}`,
    createdBy: '', owner: '', ...fields,
  } as any);
  // What a read records, which insertBill is given by the create route.
  return updateBill('cybm', b.id, { supplierGstRegNo: '201512345M', taxLabel: 'GST 9%', ...(fields as any) })!;
};
const run = (id: string, force = false) => runGstCheck('cybm', 'org-1', 'cybm', id, { force });
const found = (on_date: string, outcome = 'registered') => ({
  available: true, matched: true, by: 'number', on_date,
  result: { outcome, gst_reg_no: outcome === 'not_registered' ? '' : '201512345M', name: 'ACME HARDWARE PTE. LTD.', registration_id: '201512345M', registered_from: '2015-01-01', registered_to: '', checked_at: '2026-11-27T01:00:00Z' },
});
const publish = async (billId: string, taxType = 'INPUTY24') => {
  const res = await fetch('http://127.0.0.1:4692/api/xero/organisations/org-1/publish-bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billId, accountCode: '429', taxType, status: 'DRAFT' }),
  });
  return { status: res.status, body: await res.json() };
};

// 1) No answer: nothing kept, nothing changed.
let b = bill();
await run(b.id);
check('no answer: nothing kept', gstCheckFor(b.id), null);
check('no answer: the code stands', getBillById('cybm', b.id)!.taxRate, 'Standard-Rated Purchases');

// 2) Not registered on the date: held at No Tax, the total unmoved.
answer = found('no', 'not_registered');
b = bill();
let r = await run(b.id);
let now = getBillById('cybm', b.id)!;
check('asked with the number and the date', asked.at(-1), { reg_id: '201512345M', supplier_name: 'Acme Hardware Pte Ltd', date: '2026-11-20' });
check('held: No Tax, no tax amount, same total', [r.changed, now.taxRate, now.tax, now.total], [true, 'No Tax', 0, 109]);
check('held: the reason names no IRAS data', /accounting firm/.test(String(now.taxRateReason)) && !/ACME/.test(String(now.taxRateReason)), true);
// The hold stays through an edit, and a person's own pick wins.
let patch: Record<string, unknown> = { taxRate: 'Standard-Rated Purchases' };
await keepPracticeNoTax(now, patch);
check('a write cannot quietly claim it again', patch.taxRate, 'No Tax');
patch = { taxRate: 'Standard-Rated Purchases', taxRateEdited: true };
await keepPracticeNoTax(now, patch);
check('a person picking a code is kept', patch.taxRate, 'Standard-Rated Purchases');
patch = { supplier: 'Somebody Else Pte Ltd', taxRate: 'Standard-Rated Purchases' };
await keepPracticeNoTax(now, patch);
check('another supplier releases the hold', patch.taxRate, 'Standard-Rated Purchases');

// 3) A publish that finds it out is declined once, and nothing reaches Xero.
order.length = 0;
b = bill();
let p = await publish(b.id);
check('publish declined', [p.status, p.body.error], [422, 'gst_not_supported']);
check('nothing sent to Xero', order, []);
p = await publish(b.id, 'NONE');
check('published again at No Tax', p.status, 200);
check('no contact written for an unregistered supplier', order, ['bill']);

// 4) Registered, printed on the paper: the contact first, then the bill.
answer = found('yes');
contacts = [{ ContactID: 'c-1', Name: 'Acme Hardware Pte Ltd' }];
order.length = 0;
contactWrites.length = 0;
b = bill();
p = await publish(b.id);
check('published', p.status, 200);
check('contact before bill', order, ['contact', 'bill']);
check('both numbers written', contactWrites[0], { method: 'POST', body: { Contacts: [{ ContactID: 'c-1', TaxNumber: '201512345M', CompanyNumber: '201512345M' }] } });
check('recorded', gstCheckFor(b.id)!.saved?.fields, ['TaxNumber', 'CompanyNumber']);

// 5) The contact holds a number: IRAS is not asked.
contacts = [{ ContactID: 'c-1', Name: 'Acme Hardware Pte Ltd', TaxNumber: '201512345M' }];
const before = asked.length;
b = bill();
await run(b.id);
check('not asked', [asked.length, gstCheckFor(b.id)!.skipped], [before, 'contact_has_number']);

// 6) Found by name: saved only on a person's word, then remembered.
contacts = [];
answer = { ...found('yes'), by: 'name' };
order.length = 0;
contactWrites.length = 0;
b = bill({ supplier: 'Acme Hardware Pte Ltd', supplierGstRegNo: '', tax: 0, taxRate: 'No Tax' });
await run(b.id);
check('by name: offered, not saved', [gstCheckFor(b.id)!.confirmable, gstCheckFor(b.id)!.autoSave, contactWrites.length], [true, false, 0]);
check('by name: nothing known yet', (await knownGstRegNo('Acme Hardware Pte Ltd', { ws: 'cybm', orgId: 'org-1' }))?.from === 'checked', false);
const saved = await saveGstToContact(b.id, 'tenant-1', { by: 'cze', confirmed: true });
check('saved on the button', saved.ok, true);
check('a missing contact is made with the numbers', contactWrites[0], { method: 'PUT', body: { Contacts: [{ Name: 'Acme Hardware Pte Ltd', TaxNumber: '201512345M', CompanyNumber: '201512345M' }] } });
check('the confirmed number is this entity’s for the next read', await knownGstRegNo('Acme Hardware Pte Ltd', { ws: 'cybm', orgId: 'org-1' }), { reg: '201512345M', from: 'checked' });

// 7) A new supplier is filed under its registered name; an existing one is not.
const read = (supplier: string, extra: Record<string, unknown> = {}) => ({
  supplier, supplierGstRegNo: '201899999Z', taxLabel: 'GST 9%', date: '2026-11-20', ...extra,
});
const name = async (data: ReturnType<typeof read>) => {
  const out = await withRegisteredName(data, { ws: 'cybm', orgId: 'org-1' });
  return [out.supplier, out.supplierPrintedName];
};
answer = { ...found('yes'), registered_name: 'NEWCO HOLDINGS PTE. LTD.' };
contacts = [];
check('new: the registered name, the printed one kept', await name(read('Newco Cafe')), ['NEWCO HOLDINGS PTE. LTD.', 'Newco Cafe']);
const calls = asked.length;
check('already on a document here: kept', await name(read('Acme Hardware')), ['Acme Hardware', '']);
check('…without asking', asked.length, calls);
await xeroNowHolds([{ ContactID: 'c-9', Name: 'Newco Cafe', IsSupplier: true }]);
check('already a Xero contact: kept', await name(read('Newco Cafe')), ['Newco Cafe', '']);
await xeroNowHolds([{ ContactID: 'c-9', Name: 'Newco', TaxNumber: '201899999Z', IsSupplier: true }]);
check('a contact holds the number under another name: kept', await name(read('Newco Cafe')), ['Newco Cafe', '']);
await xeroNowHolds([{ ContactID: 'c-9', Name: 'Newco Holdings Pte Ltd', IsSupplier: true }]);
check('the registered name already here: its spelling', await name(read('Newco Cafe')), ['Newco Holdings Pte Ltd', 'Newco Cafe']);
await xeroNowHolds([]);
check('a remembered number renames nobody', await name(read('Newco Cafe', { supplierGstRegNoRemembered: true })), ['Newco Cafe', '']);
answer = null;
check('no answer: as printed', await name(read('Newco Cafe')), ['Newco Cafe', '']);

// 8) "Use registered name": the Xero contact and this entity's own copies move.
const { renameToRegistered } = await import('../src/supplierRename.ts');
const { writeSetting, readSetting } = await import('../src/settings.ts');
answer = { ...found('yes'), registered_name: 'ACME HOLDINGS PTE. LTD.' };
await xeroNowHolds([{ ContactID: 'c-1', Name: 'Acme Shop', TaxNumber: '201512345M', IsSupplier: true }]);
writeSetting('cybm', 'cybills.supplier.rules.v1', 'org-1', { 'Acme Shop': { category: '429 - General Expenses' } });
writeSetting('cybm', 'cybills.billing-plans.v1', 'org-1', { plans: [{ id: 'p1', supplier: 'Acme Shop' }] });
b = bill({ supplier: 'Acme Shop' });
const other = bill({ supplier: 'Acme Shop', xeroInvoiceId: 'inv-old', status: 'archived' });
await run(b.id);
check('not asked by itself: the contact holds a number', gstCheckFor(b.id)!.skipped, 'contact_has_number');
await run(b.id, true);
check('a hand check asks, and names the registered business', gstCheckFor(b.id)!.registeredName, 'ACME HOLDINGS PTE. LTD.');
await xeroNowHolds([...contacts, { ContactID: 'c-2', Name: 'Acme Holdings Pte Ltd', IsSupplier: true }]);
let moved = await renameToRegistered('cybm', 'org-1', b.id, 'tenant-1');
check('two contacts in Xero: refused, nothing moved', [moved.status, getBillById('cybm', b.id)!.supplier], [409, 'Acme Shop']);
await xeroNowHolds([{ ContactID: 'c-1', Name: 'Acme Shop', TaxNumber: '201512345M', IsSupplier: true }]);
contactWrites.length = 0;
moved = await renameToRegistered('cybm', 'org-1', b.id, 'tenant-1');
check('renamed', [moved.ok, moved.xero, moved.documents! >= 2], [true, 'renamed', true]);
check('the same Xero contact, renamed', contactWrites[0], { method: 'POST', body: { Contacts: [{ ContactID: 'c-1', Name: 'ACME HOLDINGS PTE. LTD.' }] } });
check('the documents follow, published ones too', [getBillById('cybm', b.id)!.supplier, getBillById('cybm', other.id)!.supplier], ['ACME HOLDINGS PTE. LTD.', 'ACME HOLDINGS PTE. LTD.']);
check('the rule moves', readSetting('cybm', 'cybills.supplier.rules.v1', 'org-1'), { 'ACME HOLDINGS PTE. LTD.': { category: '429 - General Expenses' } });
check('the billing plan moves', (readSetting('cybm', 'cybills.billing-plans.v1', 'org-1') as any).plans[0].supplier, 'ACME HOLDINGS PTE. LTD.');
check('a read under the old name is filed under the new', (readSetting('cybm', 'cybills.supplier-list.v1', 'org-1') as any).merged['acme shop'], 'ACME HOLDINGS PTE. LTD.');

await finish(failures, server, stub);
