// Costs -> Retrieve: a portal that signs in with an SMS code (Singtel, 24 Nov
// 2026). The robot asks for the code while its run is held open; the card asks
// the person; what they type is given to the robot once, and never stored.
//
// Real HTTP at both ends, as portal-retrieve.test.mts: the stub standing in for
// n8n plays the robot, calling the `otp_url` it was sent with the run's token.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-retrieve-otp-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret-for-sealing';
process.env.PRACTICE_TIMEZONE = 'Asia/Singapore';
process.env.N8N_RETRIEVE_URL = 'http://127.0.0.1:4654/webhook/portal-retrieve';
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

// n8n holds the request open until the test lets it go.
let sentBody: Record<string, any> = {};
let release: () => void = () => {};
let arrived: () => void = () => {};
const n8n = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    sentBody = JSON.parse(raw || '{}');
    release = () => {
      res.setHeader('content-type', 'application/json');
      res.end('[]');
    };
    arrived();
  });
});
await new Promise<void>((r) => n8n.listen(4654, '127.0.0.1', r));

const express = (await import('express')).default;
const { retrieveRouter, PORTALS, failOrphanedRuns, tellCodeNeeded } = await import('../src/retrieve.ts');
const { retrievalNeedsCodeEmail } = await import('../src/mailer.ts');
const { ensure } = await import('../src/users.ts');
ensure('cybm');

const app = express();
app.use(express.json());
app.use('/api/retrieve', retrieveRouter);
const server = app.listen(4653, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const api = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4653/api/retrieve${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_one0001' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const robot = async (body: Record<string, unknown> = {}, token = sentBody.callback_token) => {
  const res = await fetch(sentBody.otp_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Callback-Token': token },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const loginOf = async (id: string) => (await api('/logins')).body.logins.find((x: any) => x.id === id);

// --- The portal --------------------------------------------------------------
check('Singtel is offered, and says it needs an SMS code', PORTALS.find((p) => p.id === 'singtel')?.otp, 'sms');
check('SP Group does not', PORTALS.find((p) => p.id === 'spgroup')?.otp, '');
check('Spotify may ask for a code it emails', PORTALS.find((p) => p.id === 'spotify')?.otp, 'email');

let r = await api('/logins', 'POST', { portal: 'singtel', username: '98765432', password: 'pw-One!' });
check('a Singtel login saves', r.status, 201);
const id = r.body.login.id as string;
check('…and the card knows it needs a code', r.body.login.otp, 'sms');

r = await api(`/logins/${id}/otp`, 'POST', { code: '480215' });
check('a code with no run waiting is refused', [r.status, r.body.error], [409, 'no_code_wanted']);

// --- The hand-off ------------------------------------------------------------
const reached = new Promise<void>((res) => (arrived = res));
await api(`/logins/${id}/run`, 'POST', {});
await reached;
check('n8n is told where to ask for the code', /\/api\/retrieve\/otp\/run_/.test(sentBody.otp_url || ''), true);
check('…in camelCase too', sentBody.otpUrl, sentBody.otp_url);

r = await api(`/logins/${id}/otp`, 'POST', { code: '480215' });
check('before the robot asks, the card takes no code', r.status, 409);

let o = await robot({}, 'wrong-token');
check('a wrong token learns nothing', o.status, 404);
o = await robot({ hint: 'sent to ****4567' });
check('the robot asks: no code yet', [o.status, o.body.code], [200, '']);
let l = await loginOf(id);
check('the card asks for it', [Boolean(l.run.otp?.wantedAt), l.run.otp?.hint, l.run.otp?.enteredAt], [true, 'sent to ****4567', undefined]);
check('the run is still running', l.run.status, 'running');
check('the token hash stays on the server', l.run.callbackHash, undefined);

r = await api(`/logins/${id}/otp`, 'POST', { code: 'abc' });
check('letters are not a code', [r.status, r.body.error], [422, 'bad_code']);
r = await api(`/logins/${id}/otp`, 'POST', { code: '480 215' });
check('a typed code is taken, spaces dropped', [r.status, Boolean(r.body.login.run.otp.enteredAt)], [200, true]);
const onDisk = readFileSync(join(DATA_DIR, 'portal-logins.json'), 'utf8'); const at = onDisk.indexOf('480215'); check('the code is not written to disk', at < 0 ? '' : onDisk.slice(Math.max(0, at - 60), at + 20), '');

o = await robot();
check('the robot gets it', o.body.code, '480215');
o = await robot();
check('…once', o.body.code, '');

o = await robot({ rejected: true });
l = await loginOf(id);
check('a refused code asks again', [o.body.code, l.run.otp.rejected, l.run.otp.enteredAt], ['', 1, undefined]);
await api(`/logins/${id}/otp`, 'POST', { code: '654321' });
o = await robot();
check('the second code goes through', o.body.code, '654321');

release();
for (let i = 0; i < 100; i++) {
  l = await loginOf(id);
  if (l.run.status !== 'running') break;
  await new Promise((res) => setTimeout(res, 50));
}
check('the run settles', l.run.status, 'done');
o = await robot();
check('a settled run takes no more asks', o.status, 409);

// --- The schedule, and a restart ---------------------------------------------
const mail = retrievalNeedsCodeEmail({ name: 'Cze Yang', portalName: 'Singtel (personal)', label: 'Singtel (personal)', username: '98765432', entity: 'CYBM', url: 'https://cybills.cy-bm.sg/costs/retrieve' });
check('the reminder says what to do', [mail.subject, mail.html.includes('Retrieve now')], ['CYBills: Singtel (personal) bills are due to be retrieved — CYBM', true]);
check('nobody set this login up by address, so nobody is asked', await tellCodeNeeded(id), []);

// A run whose job died with the process before: n8n never answers this one.
const hung = new Promise<void>((res) => (arrived = res));
await api(`/logins/${id}/run`, 'POST', {});
await hung;
await robot();
check('a run left running by the process before is failed at start', failOrphanedRuns(), 1);
l = await loginOf(id);
check('…in words, and no longer asking for a code', [l.run.status, /restarted/.test(l.run.note), l.run.otp], ['failed', true, undefined]);
check('…and only once', failOrphanedRuns(), 0);
release();

server.close();
n8n.close();
await finish(failures);
