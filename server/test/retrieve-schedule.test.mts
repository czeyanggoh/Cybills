// Costs -> Retrieve, on a schedule: a portal login that signs in for its
// invoices by itself, daily or on a day of the month, at an hour of the
// practice's day.
//
// Two halves. The rule itself (src/lib/retrieveSchedule.js, pure) at fixed
// dates — due, not due, the catch-up after downtime, a day the month does not
// have. Then the clock as the server runs it, `runDueRetrievals(now)` at chosen
// moments, over real HTTP to a stub n8n: so what is asserted is that a due
// login actually files a document, that it never runs twice in a practice day,
// that a failure waits for the next slot, and that two due logins never share
// n8n's one browser.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-retrieve-schedule-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret-for-sealing';
process.env.PRACTICE_TIMEZONE = 'Asia/Singapore';
process.env.N8N_RETRIEVE_URL = 'http://127.0.0.1:4672/webhook/portal-retrieve';
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

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- The rule ----------------------------------------------------------------
const R = await import('../../src/lib/retrieveSchedule.js');
const daily = { frequency: 'daily', day: 1, hour: 7 };
const from = '2026-10-16';
check('daily: not before its hour', R.scheduleDue(daily, { from }, '2026-10-16', 6), false);
check('daily: due at its hour', R.scheduleDue(daily, { from }, '2026-10-16', 7), true);
check('daily: not twice in a day', R.scheduleDue(daily, { from, lastDay: '2026-10-16' }, '2026-10-16', 15), false);
check('daily: not the next morning before its hour', R.scheduleDue(daily, { from, lastDay: '2026-10-16' }, '2026-10-17', 6), false);
check('daily: a slot before the schedule was set is not owed', R.scheduleDue(daily, { from }, '2026-10-16', 3), false);
check('daily: catches up after downtime', R.scheduleDue(daily, { from, lastDay: '2026-10-16' }, '2026-10-19', 10), true);
check('daily: catches up yesterday’s slot past midnight', R.scheduleDue(daily, { from, lastDay: '2026-10-18' }, '2026-10-20', 2), true);
check('daily: …and that is the day’s run', R.scheduleDue(daily, { from, lastDay: '2026-10-20' }, '2026-10-20', 8), false);

const fifth = { frequency: 'monthly', day: 5, hour: 7 };
const sept = { from: '2026-09-01', lastDay: '2026-09-05' };
check('monthly: not before its day', R.scheduleDue(fifth, sept, '2026-10-04', 12), false);
check('monthly: not before its hour on its day', R.scheduleDue(fifth, sept, '2026-10-05', 6), false);
check('monthly: due at its hour on its day', R.scheduleDue(fifth, sept, '2026-10-05', 7), true);
check('monthly: catches up after downtime over its day', R.scheduleDue(fifth, sept, '2026-10-07', 0), true);
check('monthly: once caught up, not again that month', R.scheduleDue(fifth, { ...sept, lastDay: '2026-10-07' }, '2026-10-20', 9), false);
check('monthly: set after its day, it waits for next month', R.scheduleDue(fifth, { from: '2026-10-10' }, '2026-10-12', 9), false);
check('…and says so', R.nextScheduledDay(fifth, { from: '2026-10-10' }, '2026-10-12', 9), '2026-11-05');

const last = { frequency: 'monthly', day: 31, hour: 8 };
check('the 31st runs on the last day of a shorter month', R.scheduleDue(last, { from: '2026-09-01' }, '2026-09-30', 8), true);
check('…February included', R.scheduleDue(last, { from: '2027-02-01' }, '2027-02-28', 9), true);
check('a missed month-end is caught up early the next month', R.scheduleDue(last, { from: '2026-09-01', lastDay: '2026-09-30' }, '2026-11-02', 3), true);
check('off is never due', R.scheduleDue({ frequency: 'off', hour: 0 }, {}, '2026-10-16', 23), false);
check('next run: today, before its hour', R.nextScheduledDay(daily, { from }, '2026-10-16', 3), '2026-10-16');
check('next run: tomorrow, once it has run', R.nextScheduledDay(daily, { from, lastDay: '2026-10-16' }, '2026-10-16', 9), '2026-10-17');
check('a schedule names a frequency it knows', [R.validSchedule({ frequency: 'weekly' }), R.validSchedule({ frequency: 'daily', hour: 25 }), R.validSchedule({ frequency: 'monthly', day: 5, hour: 7 })], [false, false, true]);
check('labels', [R.scheduleLabel(daily), R.scheduleLabel(fifth), R.scheduleLabel(undefined)], ['Daily at 07:00', 'Monthly on the 5th at 07:00', 'Off']);

// --- The clock ---------------------------------------------------------------
// The stub answers each login with its own invoice, slowly enough that two runs
// at once would overlap — and counts whether they ever did.
let failing = false;
let inFlight = 0;
let maxInFlight = 0;
const sent: Array<Record<string, any>> = [];
const n8n = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const body = JSON.parse(raw || '{}');
    sent.push(body);
    await new Promise((r) => setTimeout(r, 80));
    inFlight -= 1;
    if (failing) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'Login failed: incorrect password' }));
    }
    const n = sent.length;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ fileName: `${body.username}-${n}.pdf`, invoice_number: `INV-${n}`, pdf_base64: Buffer.from(`%PDF-1.4 bill ${n}`).toString('base64') }]));
  });
});
await new Promise<void>((r) => n8n.listen(4672, '127.0.0.1', r));

const express = (await import('express')).default;
const { retrieveRouter, runDueRetrievals } = await import('../src/retrieve.ts');
const { env } = await import('../src/env.ts');
const { practiceDayKey } = await import('../src/usage.ts');
const { listBillsAcrossScopes } = await import('../src/store.ts');
const { ensure } = await import('../src/users.ts');
ensure('cybm');

const app = express();
app.use(express.json());
app.use('/api/retrieve', retrieveRouter);
const server = app.listen(4671, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

const api = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4671/api/retrieve${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org_one0001' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const loginOf = async (id: string) => (await api('/logins')).body.logins.find((l: any) => l.id === id);
const retrieved = () => listBillsAcrossScopes().filter((b) => b.retrieved);
const requestsFor = (username: string) => sent.filter((b) => b.username === username).length;

// A moment of the practice's day (Singapore, UTC+8, no daylight saving): `day`
// days after today, at `hour` — a few minutes past, as a tick would land.
const T = practiceDayKey(new Date());
const at = (day: number, hour: number) => {
  const [y, m, d] = T.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + day, hour - 8, 3));
};
const dayKey = (day: number) => practiceDayKey(at(day, 12));

let r = await api('/logins', 'POST', { portal: 'spgroup', username: 'a@cybm.sg', password: 'pw', schedule: { frequency: 'weekly' } });
check('a schedule it does not know is refused', [r.status, r.body.error], [422, 'bad_schedule']);

r = await api('/logins', 'POST', { portal: 'spgroup', username: 'a@cybm.sg', password: 'pw', schedule: { frequency: 'daily', hour: 7 } });
check('a login is saved with its schedule', [r.status, r.body.login.schedule], [201, { frequency: 'daily', day: 1, hour: 7 }]);
const a = r.body.login.id as string;
r = await api('/logins', 'POST', { portal: 'spgroup', username: 'b@cybm.sg', password: 'pw' });
const b = r.body.login.id as string;
check('a login saved without one is off', r.body.login.schedule.frequency, 'off');
r = await api(`/logins/${b}`, 'PATCH', { schedule: { frequency: 'daily', hour: 7 } });
check('a schedule is changed on an edit', [r.status, r.body.login.schedule.frequency], [200, 'daily']);
r = await api('/logins', 'POST', { portal: 'spgroup', username: 'off@cybm.sg', password: 'pw', schedule: { frequency: 'off', hour: 7 } });
r = await api('/logins');
check('the listing says when each runs next, and in which timezone', [
  r.body.timezone,
  r.body.logins.map((l: any) => l.nextScheduledDay),
], ['Asia/Singapore', [T, T, '']]);

check('nothing runs before the hour', [await runDueRetrievals(at(0, 6)), sent.length], [0, 0]);

check('at the hour, both due logins run', await runDueRetrievals(at(0, 7)), 2);
check('…one at a time, never two in n8n’s browser at once', maxInFlight, 1);
check('…each filing its invoice into the inbox', retrieved().map((d) => d.retrieved?.loginId).sort(), [a, b].sort());
for (let i = 0; i < 60 && retrieved().some((d) => d.status === 'processing'); i++) await new Promise((res) => setTimeout(res, 50));
check('…read like an upload (no reader here, so they land New)', retrieved().map((d) => d.status), ['new', 'new']);
let la = await loginOf(a);
check('…saying it ran on schedule, and on which day', [la.run.status, la.run.scheduled, la.lastScheduledDay], ['done', true, T]);
check('a login with its schedule off is never asked about', requestsFor('off@cybm.sg'), 0);

check('not twice in the same day', await runDueRetrievals(at(0, 9)), 0);
check('nor the next morning before the hour', await runDueRetrievals(at(1, 6)), 0);

failing = true;
check('a run that fails is recorded on the login', await runDueRetrievals(at(2, 8)), 2);
la = await loginOf(a);
check('…in n8n’s words', [la.run.status, /incorrect password/.test(la.run.note)], ['failed', true]);
check('…and is not retried that day', await runDueRetrievals(at(2, 11)), 0);
failing = false;

// The server down from the morning of day 3 until 02:00 on day 5.
check('after downtime, the missed run is made up', await runDueRetrievals(at(5, 2)), 2);
check('…and that is the day’s run — not a second at the hour', await runDueRetrievals(at(5, 8)), 0);
check('…the day it ran is what is recorded', (await loginOf(a)).lastScheduledDay, dayKey(5));

// A person's own Retrieve now holds n8n's browser; the clock waits for it.
const before = sent.length;
await api(`/logins/${b}/run`, 'POST', {});
check('while somebody’s run is going, the clock waits', await runDueRetrievals(at(6, 8)), 0);
for (let i = 0; i < 100 && (await loginOf(b)).run.status === 'running'; i++) await new Promise((res) => setTimeout(res, 50));
check('…and runs what is due once it has settled', await runDueRetrievals(at(6, 8)), 2);
check('…with nothing overlapping', [maxInFlight, sent.length - before], [1, 3]);

r = await api(`/logins/${a}`, 'PATCH', { schedule: { frequency: 'off' } });
check('switched off, a login stops running by itself', [await runDueRetrievals(at(7, 8)), (await loginOf(a)).nextScheduledDay], [1, '']);

env.N8N_RETRIEVE_URL = '';
check('with no workflow configured, nothing runs', await runDueRetrievals(at(8, 8)), 0);
check('…and the day is not used up', (await loginOf(b)).lastScheduledDay, dayKey(7));
env.N8N_RETRIEVE_URL = 'http://127.0.0.1:4672/webhook/portal-retrieve';
check('…so it runs once it is', await runDueRetrievals(at(8, 9)), 1);

await finish(failures, server, n8n);
