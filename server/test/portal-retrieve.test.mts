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
answer([{ fileName: 'SP-Sep-2026.pdf', invoice_number: '8812345', pdf_base64: pdf('Sep').toString('base64') }]);
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
check('…and leaves the documents it retrieved', retrieved().length, 2);

await finish(failures, server, n8n);
