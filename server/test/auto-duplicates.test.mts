// The whole-book duplicate check runs by itself. It used to be a button, so a
// document that became a duplicate AFTER it was uploaded — the second copy
// arrives later, or an edit makes two rows agree — sat unflagged until somebody
// remembered to press it. This covers that it now runs off the listing, that it
// skips an unchanged book, and that a workspace which turned duplicate checking
// Off gets none of it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-autodup-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

// Red Alpha has duplicate checking switched Off. Written before the first
// listing: the settings collection is cached in memory on first read, exactly
// as it is in the running app (where a save updates the cache too).
writeFileSync(
  join(DATA_DIR, 'settings.json'),
  JSON.stringify({ items: [{ workspaceId: 'cybm', key: 'cybills.extraction-settings.v1::org-red', value: { duplicateMode: 'Off' } }] })
);

const express = (await import('express')).default;
const { billsRouter } = await import('../src/bills.ts');
const { insertBill, updateBill } = await import('../src/store.ts');

const bill = (over: Record<string, unknown>) =>
  insertBill({
    orgId: 'cybm', kind: 'cost', status: 'new', documentType: 'Invoice', currency: 'SGD',
    category: '489 - Telephone', description: '', tax: '0', ...over,
  } as any);

// Two copies of one invoice, neither flagged: insertBill is the store, not the
// upload endpoint, so nothing has compared them yet — exactly the state the
// manual scan existed to clean up.
const original = bill({ supplier: 'Singtel', invoiceNumber: 'S-100', total: '120', date: '2026-07-31' });
const copy = bill({ supplier: 'Singtel', invoiceNumber: 'S-100', total: '120', date: '2026-07-31' });
const unique = bill({ supplier: 'AWS', invoiceNumber: 'A-1', total: '250', date: '2026-07-31' });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', billsRouter);
const server = app.listen(4609, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const list = async (orgId = 'org-cybm') => {
  const res = await fetch('http://127.0.0.1:4609/api/costs/bills', { headers: { 'X-Org-Id': orgId } as any });
  return (await res.json()).bills as any[];
};
const flagOn = async (id: string) => (await list()).find((b) => b.id === id)?.duplicateOfId || '';

check('nothing is flagged before the first listing', original.duplicateOfId || '', '');

// 1) Listing the inbox is enough — no scan call anywhere.
check('the later copy is flagged by the listing alone', await flagOn(copy.id), original.id);
check('the original stays clean', await flagOn(original.id), '');
check('an unrelated document is untouched', await flagOn(unique.id), '');

// 2) A document that becomes a duplicate later is caught on the next listing —
// the case the button was always too late for.
const edited = bill({ supplier: 'Grab', invoiceNumber: 'G-9', total: '30', date: '2026-08-01' });
const willMatch = bill({ supplier: 'Unknown supplier', invoiceNumber: '', total: '0', date: '' });
check('not a duplicate yet', await flagOn(willMatch.id), '');
updateBill('cybm', willMatch.id, { supplier: 'Grab', invoiceNumber: 'G-9', total: '30', date: '2026-08-01' } as any);
check('flagged once the edit made them agree', await flagOn(willMatch.id), edited.id);

// 3) The reviewer's "not a duplicate" is final — the automatic scan must never
// raise it again.
updateBill('cybm', copy.id, { duplicateDismissed: true } as any);
check('a dismissed pair stays dismissed', await flagOn(copy.id), '');

// 4) Off means off: a workspace that turned duplicate checking off gets no
// automatic flagging either.
const fresh = bill({ orgId: 'org-red', supplier: 'Adobe', invoiceNumber: 'AD-1', total: '80', date: '2026-08-02' });
const freshCopy = bill({ orgId: 'org-red', supplier: 'Adobe', invoiceNumber: 'AD-1', total: '80', date: '2026-08-02' });
const redRows = await list('org-red');
check('Off leaves the pair unflagged', redRows.find((b) => b.id === freshCopy.id)?.duplicateOfId || '', '');
check('…and the original too', redRows.find((b) => b.id === fresh.id)?.duplicateOfId || '', '');

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
