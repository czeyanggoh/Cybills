// The daily digest: what a colleague is emailed about their clients each day.
//
// Asserted over real HTTP for the settings, and through the same functions the
// clock calls for the sending: which documents a digest carries (only the
// clients the colleague can open, only the people named), that it goes out once
// a day and not before its hour, and that a send that fails is recorded rather
// than retried all day into somebody's inbox.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-digest-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.APP_ORIGIN = 'https://cybills.example';
// Never a real mailbox from a test, whatever server/.env says.
process.env.SMTP_HOST = '';
process.env.GRAPH_CLIENT_ID = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-0', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org_dart', orgId: 'cybm', name: 'Dart Consulting (SGD)', tenantId: 't-1', tenantName: 'Dart', createdAt: new Date(1).toISOString(), createdBy: '' },
      { id: 'org_red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-2', tenantName: 'Red Alpha', createdAt: new Date(2).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { ensure, save, full } = await import('../src/users.ts');
const { insertBill } = await import('../src/store.ts');
const { dataScopeForOrg } = await import('../src/organisations.ts');
const { digestRouter, buildDigest, runDueDigests, digestFor } = await import('../src/digest.ts');
const { dailyDigestEmail } = await import('../src/mailer.ts');

const users = ensure('cybm');
const yuyu = full({ name: 'Kai Test', email: 'kai.test@cy-bm.sg', practice: true, practiceRole: 'Standard', clientAccess: ['org_dart'], organisationId: 'org_cybm' }, 'cybm');
const finance = full({ name: 'Dart Finance', email: 'finance@dart.com.sg', organisationId: 'org_dart', role: 'Standard' }, 'cybm');
users.push(yuyu, finance);
save(users);

const doc = (org: string, o: Record<string, unknown>) =>
  insertBill({
    orgId: dataScopeForOrg(org), fileHash: String(Math.random()), fileName: 'x.pdf', supplier: 'CARROTSTICKS&CRAVINGS', invoiceNumber: '1159277',
    documentType: 'Receipt', currency: 'SGD', total: 241.98, tax: 0, date: '2026-06-25', category: '',
    createdBy: 'kai.test@cy-bm.sg', owner: 'kai.test@cy-bm.sg', storageKey: '', contentType: '', status: 'new', kind: 'cost', ...o,
  } as any);

const hers = doc('org_dart', { owner: 'finance@dart.com.sg', description: '* Food and beverage order' });
const mailed = doc('org_dart', { owner: 'dart.general@cybills.local', email: { from: 'Dart Finance <finance@dart.com.sg>', to: '', subject: '', date: '', text: '' } });
doc('org_dart', { owner: 'someone@dart.com.sg' }); // somebody else's
doc('org_dart', { owner: 'finance@dart.com.sg', paid: true }); // paid at the till
doc('org_dart', { owner: 'finance@dart.com.sg', xeroInvoiceId: 'inv-1', status: 'archived' }); // already in Xero
doc('org_red', { owner: 'finance@dart.com.sg' }); // a client Yu Yu cannot open

const app = express();
app.use(express.json());
app.use('/api/digests', digestRouter);
const server = app.listen(4655, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const api = async (path: string, method = 'GET', body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4655/api/digests${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

let r = await api(`/${yuyu.id}`);
check('an unset digest reads as off', r.body.digest.enabled, false);
check('only the clients she can open are offered', r.body.clients.map((c: any) => c.id), ['org_dart']);
check("the client's own people are offered as filters", r.body.clients[0].people.some((p: any) => p.email === 'finance@dart.com.sg'), true);

r = await api(`/${yuyu.id}`, 'PUT', {
  enabled: true,
  hour: 8,
  clients: [
    { orgId: 'org_dart', addresses: ['Finance@Dart.com.sg', 'not-an-address'] },
    { orgId: 'org_red', addresses: [] },
  ],
});
check('a client she cannot open is not saved', r.body.digest.clients, [{ orgId: 'org_dart', addresses: ['finance@dart.com.sg'] }]);
check('unpaid only by default', r.body.digest.unpaidOnly, true);

const digest = digestFor('cybm', yuyu.id)!;
const rows = await buildDigest('cybm', digest, yuyu as any, '2000-01-01T00:00:00Z');
check('her unpaid documents, uploaded or emailed in, and nothing else', rows.map((x) => x.url.split('/costs/')[1].split('?')[0]).sort(), [hers.displayId, mailed.displayId].sort());
check('the row reads the way Dext lays it out', {
  entity: rows[0].entity, supplier: rows[0].supplier, total: rows[0].total, currency: rows[0].currency,
}, { entity: 'Dart Consulting (SGD)', supplier: 'CARROTSTICKS&CRAVINGS', total: '241.98', currency: 'SGD' });
check('the link opens the document in its entity', rows[0].url.startsWith('https://cybills.example/costs/') && rows[0].url.endsWith('?org=org_dart'), true);
check('the star a read writes is not mailed', rows.some((x) => x.description === 'Food and beverage order'), true);
check('an emailed document names who sent it', rows.some((x) => x.owner.includes('sent by Dart Finance <finance@dart.com.sg>')), true);

const html = dailyDigestEmail({ name: 'Kai Test', day: '23 Sep 2026', rows, newCount: 0, unpaidOnly: true, settingsUrl: 'x' }).html;
check('the email escapes what it prints', html.includes('CARROTSTICKS&amp;CRAVINGS'), true);

// 07:00 in Singapore is 23:00 UTC the day before; 08:30 is 00:30 UTC.
let sent = await runDueDigests(new Date('2026-09-22T23:00:00Z'));
check('nothing goes out before its hour', digestFor('cybm', yuyu.id)!.lastSentDay ?? '', '');
sent = await runDueDigests(new Date('2026-09-23T00:30:00Z'));
const after = digestFor('cybm', yuyu.id)!;
check('at its hour it is attempted and counted as the day', after.lastSentDay, '2026-09-23');
check('with no mailbox, the failure is recorded, not hidden', [after.lastResult?.sent, after.lastResult?.count, after.lastResult?.error], [false, 2, 'mail_not_configured']);
check('a failed send does not move "new since" forward', after.lastSentAt ?? '', '');
await runDueDigests(new Date('2026-09-23T05:00:00Z'));
check('and it is not retried all day', digestFor('cybm', yuyu.id)!.lastResult?.at, '2026-09-23T00:30:00.000Z');
check('nothing counted as sent', sent, 0);

await finish(failures, server);
