// Costs -> Retrieve: a retrieval that failed is TOLD to the person who set the
// login up (Cze, 24 Nov 2026: "it fails without informing").
//
// What is asserted: who is told, what the email says (the reason, escaped), that
// one run is told once, and that a run which died without settling is written
// down as failed so it is told too. No mail transport is configured here, so
// nothing is sent: `tellOfFailure` answers who it WOULD tell.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-retrieve-failure-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret-for-sealing';
process.env.PRACTICE_TIMEZONE = 'Asia/Singapore';
process.env.N8N_RETRIEVE_URL = 'http://127.0.0.1:4699/webhook/portal-retrieve';
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

const login = (id: string, run: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  workspaceId: 'cybm',
  orgId: 'org_one0001',
  scope: 'cybm:org_one0001',
  portal: 'spgroup',
  label: 'SP Group',
  loginUrl: '',
  username: 'accounts@example.com',
  password: 'sealed',
  passwordSetAt: new Date(0).toISOString(),
  accountRef: '',
  owner: '',
  createdAt: new Date(0).toISOString(),
  createdBy: 'setup@example.com',
  updatedAt: new Date(0).toISOString(),
  filed: [],
  run,
  ...extra,
});
const failedRun = { id: 'run_a', status: 'failed', startedAt: '2026-11-24T02:33:20.000Z', endedAt: '2026-11-24T02:34:45.000Z', by: 'presser@example.com', note: 'n8n answered 502 — portal <down>', filed: [], skipped: 0 };
const longAgo = new Date(Date.now() - 6 * 60 * 60_000).toISOString();

writeFileSync(
  join(DATA_DIR, 'portal-logins.json'),
  JSON.stringify({
    items: [
      login('pl_failed', failedRun),
      login('pl_done', { ...failedRun, id: 'run_b', status: 'done', note: 'Nothing new.' }),
      login('pl_dead', { id: 'run_c', status: 'running', startedAt: longAgo, by: '', note: '', filed: [], skipped: 0, scheduled: true }),
      login('pl_fresh', { id: 'run_d', status: 'running', startedAt: new Date().toISOString(), by: '', note: '', filed: [], skipped: 0 }),
    ],
  })
);

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const { failureRecipients, tellOfFailure, settleDeadRuns } = await import('../src/retrieve.ts');
const { retrievalFailedEmail } = await import('../src/mailer.ts');

// --- Who is told -------------------------------------------------------------
check('the set-up user, then whoever pressed', failureRecipients({ createdBy: 'a@x.sg' }, { by: 'b@x.sg' }), ['a@x.sg', 'b@x.sg']);
check('one person is told once', failureRecipients({ createdBy: 'A@x.sg' }, { by: 'a@x.sg' }), ['A@x.sg']);
check('a scheduled run has no presser', failureRecipients({ createdBy: 'a@x.sg' }, { by: '' }), ['a@x.sg']);
check('no address, nobody', failureRecipients({ createdBy: '' }, { by: 'robot' }), []);

// --- What it says ------------------------------------------------------------
const mail = retrievalFailedEmail({
  name: 'Cze Yang',
  portalName: 'SP Group',
  label: 'SP Group',
  username: 'accounts@example.com',
  entity: 'CY Business Management',
  reason: 'n8n answered 502 — portal <down>',
  when: '24 Nov 2026, 10:34 am',
  scheduled: true,
  url: 'https://cybills.cy-bm.sg/costs/retrieve',
});
check('subject names the portal and the entity', mail.subject, 'CYBills: SP Group retrieval failed — CY Business Management');
check('the reason is in the body, escaped', mail.html.includes('n8n answered 502 — portal &lt;down&gt;'), true);
check('a scheduled run says it will try again', mail.html.includes('next scheduled time'), true);
check('it links to the Retrieve page', mail.html.includes('https://cybills.cy-bm.sg/costs/retrieve'), true);
check('a label of its own is named', retrievalFailedEmail({ ...mail, name: '', portalName: 'SP Group', label: 'Office', username: 'u', entity: '', reason: '', when: '', scheduled: false, url: 'https://x' }).subject, 'CYBills: SP Group (Office) retrieval failed');

// --- Once per run ------------------------------------------------------------
const stored = () => (JSON.parse(readFileSync(join(DATA_DIR, 'portal-logins.json'), 'utf8')).items as Array<Record<string, any>>);
check('a failed run is told to both', await tellOfFailure('pl_failed'), ['setup@example.com', 'presser@example.com']);
check('…and marked', stored().find((l) => l.id === 'pl_failed')?.failedMailedRunId, 'run_a');
check('…and not told twice', await tellOfFailure('pl_failed'), []);
check('a run that worked is not told', await tellOfFailure('pl_done'), []);
check('an unknown login is nobody', await tellOfFailure('pl_none'), []);

// --- A run that died ---------------------------------------------------------
check('a run still running hours later is written down as failed', settleDeadRuns(), 1);
await new Promise((r) => setTimeout(r, 200));
const dead = stored().find((l) => l.id === 'pl_dead');
check('…as failed, with the reason', [dead?.run?.status, /never reported back/.test(dead?.run?.note || '')], ['failed', true]);
check('…and told', dead?.failedMailedRunId, 'run_c');
check('a run that has just started is left alone', stored().find((l) => l.id === 'pl_fresh')?.run?.status, 'running');
check('…and the sweep finds nothing more', settleDeadRuns(), 0);

await finish(failures);
