// The Email tab keeps a mail for the retention window (60 days by default).
// Past it, a mail that became a document is handed to the document (still
// readable by it, no longer listed in the tab), a mail that filed nothing is
// deleted, and anything still waiting on somebody is left alone.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-mailret-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-a', orgId: 'cybm', name: 'Client A Pte Ltd', tenantId: 't-a', tenantName: 'A', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const { recordMail, loadMail, mailById } = await import('../src/mailThread.ts');
const { planRetention, runRetention, retentionDaysFor } = await import('../src/mailRetention.ts');
const { dataScopeForOrg, setOrganisationMailRetention } = await import('../src/organisations.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const scope = dataScopeForOrg('org-a');
const NOW = Date.parse('2026-11-08T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString();
const row = (id: string, ageDays: number, over: Record<string, unknown> = {}) =>
  recordMail({
    id, workspaceId: 'cybm', orgId: 'org-a', scope, userId: 'u1', to: 'a@cybills.sg', from: 'x@supplier.com',
    subject: id, text: 'hi', sentAt: daysAgo(ageDays), receivedAt: daysAgo(ageDays),
    attachments: [], documents: [], links: [], linkNote: '', linkFetchedAt: '', outcome: 'nothing', ...over,
  } as any);
const doc = { billId: 'b1', displayId: '1', fileName: 'x.pdf', via: 'attachment' as const };

row('old-doc', 90, { documents: [doc], outcome: 'documents' });
row('old-nothing', 90);
row('old-awaiting', 90, { outcome: 'awaiting_trust', pendingBillId: 'p1' });
row('young-nothing', 10);
row('young-doc', 10, { documents: [doc], outcome: 'documents' });

check('the default window is 60 days', retentionDaysFor('cybm', scope), 60);
const plan = planRetention(NOW, { ws: 'cybm', scope });
check('an old mail that became a document is handed to it', plan.handToDocuments.map((m) => m.id), ['old-doc']);
check('an old mail that filed nothing is removed', plan.remove.map((m) => m.id), ['old-nothing']);
check('an old mail still waiting on a sender is kept', plan.kept, 1);

const done = await runRetention(NOW, { ws: 'cybm', scope });
check('the run reports what it did', done, { handed: 1, removed: 1, kept: 1 });
check('the document keeps its mail, marked as living on the document', Boolean(mailById('old-doc')?.onDocuments), true);
check('the mail that filed nothing is gone', mailById('old-nothing'), null);
check('the one waiting on a sender is untouched', mailById('old-awaiting')?.onDocuments, undefined);
check('recent mail is untouched', loadMail().filter((m) => m.id.startsWith('young')).length, 2);
check('a second run has nothing left to do', (await runRetention(NOW, { ws: 'cybm', scope })).handed, 0);

setOrganisationMailRetention('cybm', 'org-a', 0);
row('ancient', 400);
check('0 days keeps mail for ever', planRetention(NOW, { ws: 'cybm', scope }).remove.length, 0);
setOrganisationMailRetention('cybm', 'org-a', 30);
check('a per-entity window overrides the default', planRetention(NOW, { ws: 'cybm', scope }).remove.map((m) => m.id).sort(), ['ancient']);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');
