// Image sharing: the signed, expiring link an export writes into its Image
// column (and a claim PDF into its Item IDs).
//
// The file route used to be public, on the reasoning that a bill id is an
// unguessable capability token. It is not — an Item ID is a timestamp, so a
// day of receipts could be enumerated by counting. Now the capability is
// explicit: a token that names one document, expires, and is signed. This
// covers what it must refuse (another id, a tampered mac, an expired link, an
// entity that has switched Image sharing off) and what it must still allow.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-share-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-secret';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { billsRouter } = await import('../src/bills.ts');
const { shareToken, verifyShareToken } = await import('../src/shareLinks.ts');
const { insertBill, setBillFile } = await import('../src/store.ts');
const { putBillFile } = await import('../src/storage.ts');
const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');

const mk = async (orgId: string, supplier: string, withFile: boolean) => {
  const bill = insertBill({
    orgId, kind: 'cost', status: 'ready', supplier, documentType: 'Receipt',
    currency: 'SGD', date: '2026-08-26', category: '429 - General Expenses',
    description: supplier, total: '10', tax: '0',
  } as any);
  if (withFile) {
    const stored = await putBillFile(orgId, `${bill.id}-hash`, 'image/png', Buffer.from('not-really-a-png'));
    setBillFile(orgId, bill.id, stored.storageKey, stored.contentType);
  }
  return bill;
};

const withFile = await mk('cybm', 'Grab', true);
const noFile = await mk('cybm', 'Singtel', false);
const redFile = await mk('org-red', 'AWS', true);

const app = express();
app.use(express.json());
app.use('/api/costs', billsRouter);
const server = app.listen(4611, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = 'http://127.0.0.1:4611/api/costs';

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const mint = async (ids: string[]) => {
  const res = await fetch(`${base}/share-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  return (await res.json()).links as Record<string, string>;
};
const fileStatus = async (id: string, token = '') => {
  const res = await fetch(`${base}/bills/${encodeURIComponent(id)}/file${token ? `?s=${encodeURIComponent(token)}` : ''}`);
  return res.status;
};
const setSharing = (org: string, on: boolean) => {
  const items = loadCollection<{ workspaceId: string; key: string; value: unknown }>('settings');
  const key = `cybills.export-settings.v1::${org}`;
  const rec = items.find((s) => s.key === key);
  if (rec) rec.value = { imageSharing: on };
  else items.push({ workspaceId: 'cybm', key, value: { imageSharing: on } });
  saveCollection('settings', items);
};

// --- the token itself -------------------------------------------------------
const tok = shareToken(withFile.id);
check('a fresh token verifies for its own document', verifyShareToken(withFile.id, tok), true);
check('the same token does not open another document', verifyShareToken(redFile.id, tok), false);
check('a tampered mac is refused', verifyShareToken(withFile.id, `${tok}x`), false);
check('an empty token is refused', verifyShareToken(withFile.id, ''), false);
// Pushing the clock past the expiry: the exp is signed, so it can't be edited.
const expired = shareToken(withFile.id, Date.now() - 40 * 24 * 60 * 60 * 1000);
check('an expired link is refused', verifyShareToken(withFile.id, expired), false);
const [, mac] = tok.split('.');
const far = Date.now() + 365 * 24 * 60 * 60 * 1000;
check('extending the expiry by hand is refused', verifyShareToken(withFile.id, `${far}.${mac}`), false);

// --- minting ----------------------------------------------------------------
const links = await mint([withFile.id, noFile.id]);
check('a document with a stored file gets a link', typeof links[withFile.id] === 'string' && links[withFile.id].includes('?s='), true);
check('a document with no file gets none', links[noFile.id] ?? null, null);
check('the minted link verifies', verifyShareToken(withFile.id, new URL(`http://x${links[withFile.id]}`).searchParams.get('s') || ''), true);

// --- the route --------------------------------------------------------------
const minted = new URL(`http://x${links[withFile.id]}`).searchParams.get('s') || '';
check('a minted link opens the file', await fileStatus(withFile.id, minted), 200);
// Presented for a different document the token simply doesn't verify, so the
// request arrives at the route as an ordinary tokenless one — which the app's
// session guard (index.ts) refuses before it ever gets here. This test mounts
// the router alone, so it checks the verification rather than that 401.
check('the same link does not authorise another document', verifyShareToken(redFile.id, minted), false);

// Switching Image sharing off revokes the links already exported.
setSharing('org-cybm', false);
check('sharing off: the exported link stops opening', await fileStatus(withFile.id, minted), 404);
check('sharing off: nothing new is minted', Object.keys(await mint([withFile.id])).length, 0);
setSharing('org-cybm', true);
check('sharing back on: the same link opens again', await fileStatus(withFile.id, minted), 200);

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
