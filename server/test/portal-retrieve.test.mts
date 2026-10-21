// Costs -> Retrieve: an entity's supplier-portal logins, and the retrieval that
// hands one to n8n to sign in and download the invoices.
//
// Driven over real HTTP at both ends, like email-link.test.mts: the routes as
// the page calls them, and a stub standing in for n8n — so what is asserted is
// the request that actually goes out (the password included, and only there)
// and what is filed from the bytes that come back.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-portal-retrieve-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret-for-sealing';
process.env.N8N_RETRIEVE_URL = 'http://127.0.0.1:4652/webhook/portal-retrieve';
process.env.N8N_API_KEY = 'test-n8n-key';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const SECRET = 'Sp-Gr0up pass!';
const pdf = (n: string) => Buffer.from(`%PDF-1.4 SP Group invoice ${n}`);

// What the stub answers next, and what it was sent.
let reply: { status: number; type: string; body: string } = { status: 200, type: 'application/json', body: '[]' };
const sent: Array<{ body: Record<string, unknown>; key: string }> = [];
const n8n = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    sent.push({ body: JSON.parse(raw || '{}'), key: String(req.headers['x-api-key'] || '') });
    res.statusCode = reply.status;
    res.setHeader('content-type', reply.type);
    res.end(reply.body);
  });
});
await new Promise<void>((r) => n8n.listen(4652, '127.0.0.1', r));
const answer = (docs: Array<Record<string, unknown>>) => {
  reply = { status: 200, type: 'application/json', body: JSON.stringify(docs) };
};

const express = (await import('express')).default;
const { retrieveRouter } = await import('../src/retrieve.ts');
const { env } = await import('../src/env.ts');
const { listBillsAcrossScopes } = await import('../src/store.ts');
const { ensure, generalUserFor } = await import('../src/users.ts');
ensure('cybm');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/retrieve', retrieveRouter);
const server = app.listen(4651, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const api = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4651/api/retrieve${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_one0001' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text || '{}') as Record<string, any> };
};

const loginOf = async (lid: string) => (await api('/logins')).body.logins.find((x: any) => x.id === lid);

// Wait for the background run to settle, as the page does by polling.
const settled = async (id: string) => {
  for (let i = 0; i < 100; i++) {
    const r = await api('/logins');
    const l = r.body.logins.find((x: any) => x.id === id);
    if (l?.run && l.run.status !== 'running' && l.run.status !== 'queued') return l;
    await new Promise((res) => setTimeout(res, 50));
  }
  return null;
};
const retrieved = () => listBillsAcrossScopes().filter((b) => b.retrieved);

// --- Saving a login ----------------------------------------------------------
let r = await api('/logins', 'POST', { portal: 'spgroup', username: 'accounts@cybm.sg' });
check('a login with no password is refused', [r.status, r.body.error], [422, 'no_password']);
r = await api('/logins', 'POST', { portal: 'other', username: 'a', password: 'b', loginUrl: 'http://portal.example' });
check('another portal needs an https sign-in page', [r.status, r.body.error], [422, 'bad_login_url']);
r = await api('/logins', 'POST', { portal: 'spgroup', username: 'a', password: 'b', owner: 'stranger@nowhere.sg' });
check('a document owner nobody here knows is refused', [r.status, r.body.error], [422, 'bad_owner']);

r = await api('/logins', 'POST', { portal: 'spgroup', username: 'accounts@cybm.sg', password: SECRET, accountRef: '93-1234567-8' });
check('a login is saved', r.status, 201);
const id = r.body.login.id as string;
check('…named for its portal when nobody names it', r.body.login.label, 'SP Group');
check('…saying a password is set, without it', [r.body.login.hasPassword, r.text.includes(SECRET), 'password' in r.body.login], [true, false, false]);

const stored = readFileSync(join(DATA_DIR, 'portal-logins.json'), 'utf8');
check('the password is sealed at rest, not written as typed', [stored.includes(SECRET), /"password": "v1:/.test(stored)], [false, true]);

r = await api('/logins');
check('the listing never carries it either', [r.status, r.text.includes(SECRET), r.body.logins.length], [200, false, 1]);
check('…and says which portals are offered', r.body.portals.map((p: any) => p.id), ['spgroup', 'other']);
check('…and that retrieval is configured', r.body.enabled, true);

// --- Retrieving --------------------------------------------------------------
answer([{ fileName: 'SP-Sep-2026.pdf', invoice_number: '8812345', invoice_date: '04 Sep 2026', pdf_base64: pdf('Sep').toString('base64') }]);
r = await api(`/logins/${id}/run`, 'POST', {});
check('Retrieve answers at once and runs in the background', [r.status, r.body.login.run?.status], [202, 'running']);
let l = await settled(id);
check('the run settles having filed one document', [l?.run.status, l?.run.filed.length], ['done', 1]);

const out = sent[sent.length - 1];
check('n8n is told the portal and the account', [out.body.portal, out.body.username, out.body.account_ref, out.body.accountRef], [
  'spgroup',
  'accounts@cybm.sg',
  '93-1234567-8',
  '93-1234567-8',
]);
check('…the password, opened for this one request', out.body.password, SECRET);
check('…which client it is for', [out.body.tenant_id, out.body.xero_name], ['t-1', 'CYBM']);
check('…with the n8n key', out.key, 'test-n8n-key');
check('the first run names no last invoice date', [out.body.last_invoice_date, out.body.lastInvoiceDate], ['', '']);
check('…and the listing then carries the portal’s date for it', l?.lastInvoiceDate, '2026-09-04');

let docs = retrieved();
const general = generalUserFor('cybm', 'org_one0001')?.email;
check('the invoice is a cost in the inbox', [docs.length, docs[0]?.kind, docs[0]?.fileName], [1, 'cost', 'SP-Sep-2026.pdf']);
check('…owned by the general account by default', [docs[0]?.owner, Boolean(general)], [general, true]);
check('…saying where it came from, never the password', [
  docs[0]?.retrieved?.portal,
  docs[0]?.retrieved?.loginId,
  docs[0]?.retrieved?.reference,
  JSON.stringify(docs[0]).includes(SECRET),
], ['spgroup', id, '8812345', false]);
check('…with its file stored', [Boolean(docs[0]?.storageKey), docs[0]?.contentType], [true, 'application/pdf']);
for (let i = 0; i < 60 && retrieved()[0]?.status === 'processing'; i++) await new Promise((res) => setTimeout(res, 50));
check('…and read like an upload (no reader here, so it lands New)', retrieved()[0]?.status, 'new');

// The same invoice again — the portal lists it every month until it scrolls off.
r = await api(`/logins/${id}/run`, 'POST', {});
l = await settled(id);
check('the same bytes again are not filed twice', [retrieved().length, l?.run.skipped, l?.run.filed.length], [1, 1, 0]);
check('…and the run says so', /already retrieved/.test(l?.run.note || ''), true);
check('n8n is told what is already held', sent[sent.length - 1].body.known_references, ['8812345']);
check('…and to fetch only invoices dated after the newest one filed', sent[sent.length - 1].body.last_invoice_date, '2026-09-04');

// A portal that regenerates the PDF: new bytes, same invoice number.
answer([{ fileName: 'SP-Sep-2026 (1).pdf', invoice_number: '8812345', data: pdf('Sep regenerated').toString('base64') }]);
await api(`/logins/${id}/run`, 'POST', {});
l = await settled(id);
check('the same invoice number is not filed twice either', [retrieved().length, l?.run.skipped], [1, 1]);

// A login page where the invoice should be.
reply = { status: 200, type: 'text/html', body: '<html><form>Sign in to SP Group</form></html>' };
await api(`/logins/${id}/run`, 'POST', {});
l = await settled(id);
check('a sign-in page is never filed as a document', retrieved().length, 1);
check('…and the run says why', /login page/.test(l?.run.note || ''), true);

// The workflow refusing, in its own words.
reply = { status: 500, type: 'application/json', body: JSON.stringify({ ok: false, error: 'Login failed: incorrect password' }) };
await api(`/logins/${id}/run`, 'POST', {});
l = await settled(id);
check('a refused sign-in is a failed run, quoting n8n', [l?.run.status, /incorrect password/.test(l?.run.note || '')], ['failed', true]);

// --- Editing -----------------------------------------------------------------
const before = JSON.parse(readFileSync(join(DATA_DIR, 'portal-logins.json'), 'utf8')).items[0].password;
r = await api(`/logins/${id}`, 'PATCH', { label: 'SP Group — HQ', password: '' });
const after = JSON.parse(readFileSync(join(DATA_DIR, 'portal-logins.json'), 'utf8')).items[0].password;
check('a blank password on an edit keeps the saved one', [r.status, r.body.login.label, before === after], [200, 'SP Group — HQ', true]);
r = await api(`/logins/${id}`, 'PATCH', { password: 'new-secret' });
answer([{ fileName: 'SP-Oct-2026.pdf', invoice_number: '8899999', pdf_base64: pdf('Oct').toString('base64') }]);
await api(`/logins/${id}/run`, 'POST', {});
l = await settled(id);
check('a replaced password is the one sent next', sent[sent.length - 1].body.password, 'new-secret');
check('…and a new invoice is filed', [retrieved().length, l?.run.filed.length], [2, 1]);
// No date from n8n for that one: the date the reader took off the paper counts.
const { updateBill } = await import('../src/store.ts');
const oct = retrieved().find((b) => b.fileName === 'SP-Oct-2026.pdf')!;
updateBill(oct.orgId, oct.id, { date: '2026-10-05' });
answer([]);
await api(`/logins/${id}/run`, 'POST', {});
l = await settled(id);
check('a date read off the paper moves it on when n8n gave none', sent[sent.length - 1].body.last_invoice_date, '2026-10-05');
// A misread year in the future would stop every later invoice being fetched.
updateBill(oct.orgId, oct.id, { date: '2099-10-05' });
await api(`/logins/${id}/run`, 'POST', {});
l = await settled(id);
check('…but a date past today is not believed', sent[sent.length - 1].body.last_invoice_date, '2026-09-04');

// --- Retrieve invoices from -------------------------------------------------
r = await api(`/logins/${id}`, 'PATCH', { retrieveFrom: '2099-01-01' });
check('a "retrieve from" date in the future is refused', [r.status, r.body.error], [422, 'bad_retrieve_from']);
r = await api(`/logins/${id}`, 'PATCH', { retrieveFrom: 'soon' });
check('…and so is one that is not a date', [r.status, r.body.error], [422, 'bad_retrieve_from']);
r = await api(`/logins/${id}`, 'PATCH', { retrieveFrom: '15/08/2026' });
check('a typed date is kept, as ISO', [r.status, r.body.login.retrieveFrom], [200, '2026-08-15']);
answer([
  { fileName: 'SP-Jul-2026.pdf', invoice_number: '8700001', invoice_date: '2026-07-03', pdf_base64: pdf('Jul').toString('base64') },
  { fileName: 'SP-Aug-2026.pdf', invoice_number: '8700002', invoice_date: '2026-08-05', pdf_base64: pdf('Aug').toString('base64') },
  { fileName: 'SP-Aug2-2026.pdf', invoice_number: '8700003', invoice_date: '2026-08-20', pdf_base64: pdf('Aug2').toString('base64') },
]);
const held = retrieved().length;
await api(`/logins/${id}/run`, 'POST', {});
l = await settled(id);
check('n8n is told the date to retrieve from', [sent[sent.length - 1].body.retrieve_from, sent[sent.length - 1].body.retrieveFrom], [
  '2026-08-15',
  '2026-08-15',
]);
check('…and what it sends dated before it is left on the portal', [retrieved().length - held, l?.run.tooOld], [1, 2]);
check('…which the run says', /2 were dated before 15 Aug 2026/.test(l?.run.note || ''), true);
r = await api(`/logins/${id}`, 'PATCH', { retrieveFrom: '' });
check('clearing it lifts the limit', [r.status, r.body.login.retrieveFrom], [200, '']);

// --- n8n answering 202 and calling back --------------------------------------
// The workflow takes the run on at once and posts the invoices back when it is
// done, so nothing holds a request open for the whole sign-in.
reply = { status: 202, type: 'application/json', body: JSON.stringify({ accepted: true }) };
const callBack = (body: Record<string, unknown>, opts: { url?: string; token?: string } = {}) => {
  const out = sent[sent.length - 1].body as Record<string, string>;
  return fetch(opts.url || out.callback_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Callback-Token': opts.token ?? out.callback_token },
    body: JSON.stringify(body),
  });
};
r = await api(`/logins/${id}/run`, 'POST', {});
for (let i = 0; i < 40 && !(await api('/logins')).body.logins[0].run?.awaiting; i++) await new Promise((res) => setTimeout(res, 25));
let lr = (await api('/logins')).body.logins[0];
const asked = sent[sent.length - 1].body as Record<string, string>;
check('n8n is given a callback for this run, and a token', [
  asked.callback_url.endsWith(`/api/retrieve/callback/${lr.run.id}`),
  asked.callbackUrl === asked.callback_url,
  /^[0-9a-f]{64}$/.test(asked.callback_token),
], [true, true, true]);
check('a 202 leaves the run going, waiting on n8n', [lr.run.status, lr.run.awaiting], ['running', true]);
check('…and the page never sees the token or its hash', [JSON.stringify(lr).includes(asked.callback_token), 'callbackHash' in lr.run], [false, false]);
let cb = await callBack({ ok: true }, { token: 'f'.repeat(64) });
check('a callback with the wrong token is turned away, as if no run existed', cb.status, 404);
const beforeCb = retrieved().length;
cb = await callBack([{ fileName: 'SP-Nov-2026.pdf', invoice_number: '8900001', invoice_date: '2026-10-21', pdf_base64: pdf('Nov').toString('base64') }]);
check('the callback is accepted', cb.status, 202);
l = await settled(id);
check('…and files what it brought', [l?.run.status, l?.run.filed.length, retrieved().length - beforeCb, l?.run.awaiting], ['done', 1, 1, undefined]);
cb = await callBack([{ fileName: 'SP-Nov-2026.pdf', pdf_base64: pdf('Nov again').toString('base64') }]);
check('a second callback for a settled run files nothing', [cb.status, retrieved().length - beforeCb], [409, 1]);

await api(`/logins/${id}/run`, 'POST', {});
for (let i = 0; i < 40 && !(await api('/logins')).body.logins[0].run?.awaiting; i++) await new Promise((res) => setTimeout(res, 25));
cb = await callBack({ ok: false, error: 'Login failed: account locked' });
l = await settled(id);
check('a callback that refuses fails the run, in n8n’s words', [cb.status, l?.run.status, /account locked/.test(l?.run.note || '')], [202, 'failed', true]);

// --- One at a time -----------------------------------------------------------
// n8n drives one browser: a second login pressed while the first is with n8n
// waits its turn rather than being refused by the workflow.
r = await api('/logins', 'POST', { portal: 'spgroup', username: 'second@cybm.sg', password: 'pw-2' });
const second = r.body.login.id as string;
const sentBefore = sent.length;
await api(`/logins/${id}/run`, 'POST', {});
r = await api(`/logins/${second}/run`, 'POST', {});
check('a second retrieval while one is with n8n is queued', [r.status, r.body.login.run?.status], [202, 'queued']);
for (let i = 0; i < 40 && !(await api('/logins')).body.logins[0].run?.awaiting; i++) await new Promise((res) => setTimeout(res, 25));
await new Promise((res) => setTimeout(res, 100));
check('…and not sent while the first is with n8n', [sent.length - sentBefore, (await loginOf(second)).run.status], [1, 'queued']);
reply = { status: 200, type: 'application/json', body: '[]' };
await callBack({ message: 'No new invoices' });
await settled(id);
const s2 = await settled(second);
check('…and goes to n8n once the first has called back', [sent.length - sentBefore, sent[sent.length - 1].body.username, s2?.run.status], [
  2,
  'second@cybm.sg',
  'done',
]);
await api(`/logins/${second}`, 'DELETE');

// --- Unconfigured ------------------------------------------------------------
env.N8N_RETRIEVE_URL = '';
r = await api(`/logins/${id}/run`, 'POST', {});
check('with no workflow configured, Retrieve says so', [r.status, r.body.error], [503, 'not_configured']);
r = await api('/logins');
check('…and the listing says it is off', r.body.enabled, false);
env.N8N_RETRIEVE_URL = 'http://127.0.0.1:4652/webhook/portal-retrieve';

// --- Deleting ----------------------------------------------------------------
r = await api(`/logins/${id}`, 'DELETE');
const gone = readFileSync(join(DATA_DIR, 'portal-logins.json'), 'utf8');
check('deleting a login removes it, sealed password and all', [r.status, JSON.parse(gone).items.length], [200, 0]);
check('…and leaves the documents it retrieved', retrieved().length, 4);

await finish(failures, server, n8n);
