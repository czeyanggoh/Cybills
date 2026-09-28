// A colleague nobody signs in as, and the project their documents follow.
//
// "AP CYBM" is on the practice team and is not a person: it is a pipe — an
// address and a WhatsApp group bills are sent down. Added with no email it was
// stored with a BLANK address, and a document's owner is an address, so it
// could own nothing: a bill sent into its own group was filed under whoever
// pressed send, and the Document owner picker never offered it. And the
// Colleagues page had no Project column at all, so even a colleague who could
// own documents could not be given a default for them.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-colleague-project-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org_client', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: '', tenantName: '', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

let answer: Record<string, unknown> = {};
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const out = JSON.stringify(answer);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-4o-stub',
        output_text: out,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      })
    );
  });
});
await new Promise<void>((r) => stub.listen(4693, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4693';

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { usersRouter, ensure, save, full, peopleForOrg, defaultProjectFor, isInternalAddress } = await import('../src/users.ts');
const { practiceRouter } = await import('../src/practice.ts');
const { autoRead } = await import('../src/inbound.ts');
const { insertBill, getBillById, listBills } = await import('../src/store.ts');
const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');
const { WORKSPACE_ID } = await import('../src/workspace.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/users', usersRouter);
app.use('/api/practice', practiceRouter);
const server = app.listen(4694, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const call = async (method: string, path: string, body?: unknown, org = 'org_cybm') => {
  const res = await fetch(`http://127.0.0.1:4694${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

// --- A colleague written before any of this, with no address at all ---------
{
  const items = ensure(WORKSPACE_ID);
  const old = full({ name: 'GCY AUS', login: 'No', practice: true, practiceRole: 'Standard', organisationId: 'org_cybm', clientAccess: ['org_client'] }, WORKSPACE_ID);
  old.email = '';
  items.push(old);
  save(items);
}
const gcy = ensure(WORKSPACE_ID).find((u) => u.name === 'GCY AUS');
check('a colleague stored with no address gets an identity on load', isInternalAddress(gcy?.email || ''), true);

// --- A colleague added with no email -----------------------------------------
let r = await call('POST', '/api/practice/colleagues', { name: 'AP CYBM', login: 'No', practiceRole: 'Standard', clientAccess: ['org_client'], notify: false });
const ap = r.body.colleagues?.[0];
check('the colleague is created', r.status, 200);
check('…showing no email, because there is no mailbox', ap?.email, '');

let here = peopleForOrg(WORKSPACE_ID, 'org_cybm').find((p) => p.name === 'AP CYBM');
check('the directory knows them in the practice’s own entity', Boolean(here), true);
check('…by an internal identity', isInternalAddress(here?.email || ''), true);
check('…as somebody who can own a document there', here?.external, false);
check('…and is not the same identity as the other one', here?.email === gcy?.email, false);

// --- Their default project ----------------------------------------------------
r = await call('PATCH', `/api/users/${ap.id}`, { project: 'HQ' });
check('a default project is saved on the colleague', [r.status, r.body.user?.project], [200, 'HQ']);
check('…without touching their identity', ensure(WORKSPACE_ID).find((u) => u.id === ap.id)?.email, here?.email);

here = peopleForOrg(WORKSPACE_ID, 'org_cybm').find((p) => p.name === 'AP CYBM');
check('the directory carries it where they own documents', here?.project, 'HQ');
const away = peopleForOrg(WORKSPACE_ID, 'org_client').find((p) => p.name === 'AP CYBM');
check('in a client’s book they are an outsider', away?.external, true);
check('…and carry no project: HQ is a name in another entity’s list', away?.project, '');
check('asked by address', defaultProjectFor(WORKSPACE_ID, 'org_cybm', String(here?.email)).project, 'HQ');
check('…and nobody’s, for an address nobody has', defaultProjectFor(WORKSPACE_ID, 'org_cybm', 'stranger@example.com').project, '');

// --- A bill sent down their pipe ---------------------------------------------
type Setting = { workspaceId: string; key: string; value: unknown };
const setSupplierRules = (rules: Record<string, Record<string, unknown>>) => {
  const key = 'cybills.supplier.rules.v1::org_cybm';
  const rows = loadCollection<Setting>('settings').filter((s) => s.key !== key);
  rows.push({ workspaceId: WORKSPACE_ID, key, value: rules });
  saveCollection('settings', rows);
};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {}, header: () => undefined } as never;
let n = 0;
const arrive = async (owner: string, extra: Record<string, unknown> = {}) => {
  n += 1;
  const bill = insertBill({
    orgId: 'cybm', fileHash: `hash-${n}`, fileName: `bill-${n}.png`, supplier: '', invoiceNumber: '',
    documentType: '', currency: '', total: 0, tax: 0, date: '', category: '',
    createdBy: owner, owner, status: 'processing', kind: 'cost', ...extra,
  } as never);
  await autoRead(req, 'cybm', 'org_cybm', 'openai', bill.id, PNG, 'image/png');
  return getBillById('cybm', bill.id);
};

const FIELDS = {
  supplier: 'Singtel', date: '2026-08-28', documentType: 'Invoice', invoiceNumber: '000199796834',
  currency: 'SGD', total: 475.78, tax: 0, category: 'Uncategorised', categoryReason: '', noteFollowed: '',
  description: 'Mobile and broadband', dueDate: '', period: '', cardLast4: '', supplierGstRegNo: '',
  taxLabel: '', billedTo: '', billedToRegNo: '', customer: '', rebillable: false, taxRate: '',
  taxRateReason: '', project: '', projectReason: '', baseCurrency: '', baseTotal: 0, baseTax: 0,
  exchangeRate: 0, attendees: '', distanceKm: 0, taxRatePrinted: 0, lineItems: [],
};
answer = { ...FIELDS };

let bill = await arrive(String(here?.email));
check('the bill is read', bill?.supplier, 'Singtel');
check('…and follows its owner’s default project', bill?.project, 'HQ');
check('…saying why', /AP CYBM's default project/.test(String(bill?.projectReason)), true);

bill = await arrive(String(gcy?.email));
check('an owner with no default leaves the project alone', bill?.project || '', '');

bill = await arrive(String(here?.email), { project: 'Outlet B' });
check('a project already on the document is kept', bill?.project, 'Outlet B');

setSupplierRules({ Singtel: { project: 'Outlet A' } });
bill = await arrive(String(here?.email));
check('the supplier’s rule still beats the owner’s default', bill?.project, 'Outlet A');
setSupplierRules({});

// --- The day they are given a mailbox -----------------------------------------
r = await call('PATCH', `/api/users/${ap.id}`, { email: 'ap@cy-bm.sg' });
check('an address can be set on them', [r.status, r.body.user?.email], [200, 'ap@cy-bm.sg']);
check('…and their documents come with them', listBills('cybm').filter((b) => b.owner === 'ap@cy-bm.sg').length, 3);
check('…leaving nothing on the old identity', listBills('cybm').some((b) => b.owner === here?.email), false);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, stub, server);
