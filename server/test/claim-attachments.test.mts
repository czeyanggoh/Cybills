// A claim's own supporting documents — the internal approval email chain, a
// quote, an HR form — attached to the claim itself and printed at the back of
// its PDF after the approval history. Stored like a receipt, served like one,
// and locked with the rest of the claim once it is approved.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-att-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { claimsRouter } = await import('../src/claims.ts');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/claims', claimsRouter);
const server = app.listen(4663, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const base = 'http://127.0.0.1:4663/api/claims';
const ORG = { 'X-Org-Id': 'org-red' };
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = ORG) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

// A 1×1 PNG, and some bytes that are not a PDF, PNG or JPG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DOCX = Buffer.from('not really a word document').toString('base64');

// --- the claim -----------------------------------------------------------------
let r = await call('POST', '/', { claimFor: 'Adrian Fong', name: 'Sep claim', endDate: '2026-09-30' });
const claimId = r.body.claim?.id as string;
check('a claim to attach to', typeof claimId, 'string');

// --- attaching -------------------------------------------------------------------
r = await call('POST', `/${claimId}/attachments`, { fileName: 'Approval email chain.png', fileBase64: PNG, mediaType: 'image/png' });
check('a PNG is attached', r.status, 200);
const att = r.body.attachment;
check('and comes back on the claim, named', r.body.claim?.attachments?.map((a: any) => a.fileName), ['Approval email chain.png']);
check('with its size', att?.size, Buffer.from(PNG, 'base64').length);
check('and who attached it', typeof att?.addedBy, 'string');
check('the history says so', r.body.claim?.history?.[0]?.text, 'Supporting document "Approval email chain.png" was attached');

r = await call('POST', `/${claimId}/attachments`, { fileName: 'minutes.docx', fileBase64: DOCX, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
check('a Word file is refused — the PDF could not carry it', [r.status, r.body.error], [415, 'unsupported_type']);

r = await call('POST', `/${claimId}/attachments`, { fileName: 'empty.pdf', fileBase64: '', mediaType: 'application/pdf' });
check('an empty file is refused', r.status, 400);

r = await call('POST', `/${claimId}/attachments`, { fileName: 'x.png', fileBase64: PNG, mediaType: 'image/png' }, { 'X-Org-Id': 'org-cybm' });
check('another entity cannot attach to this claim', r.status, 404);

// --- the bytes -------------------------------------------------------------------
let res = await fetch(`${base}/${claimId}/attachments/${att.id}/file`);
check('the file is served', res.status, 200);
check('as what it is', res.headers.get('content-type'), 'image/png');
check('under its own name', res.headers.get('content-disposition')?.includes('Approval email chain.png'), true);
check('byte for byte', Buffer.from(await res.arrayBuffer()).toString('base64'), PNG);

res = await fetch(`${base}/${claimId}/attachments/nope/file`);
check('an unknown attachment is a 404', res.status, 404);

// --- the claim is what lists them ----------------------------------------------
r = await call('GET', '', undefined);
const listed = r.body.claims?.find((c: any) => c.id === claimId);
check('the listing carries the attachments', listed?.attachments?.length, 1);

// --- removing --------------------------------------------------------------------
r = await call('POST', `/${claimId}/attachments`, { fileName: 'quote.pdf', fileBase64: PNG, mediaType: 'application/pdf' });
const second = r.body.attachment;
r = await call('DELETE', `/${claimId}/attachments/${second.id}`);
check('an attachment can be removed', r.status, 200);
check('and is gone from the claim', r.body.claim?.attachments?.map((a: any) => a.fileName), ['Approval email chain.png']);
check('the history keeps the fact', r.body.claim?.history?.[0]?.text, 'Supporting document "quote.pdf" was removed');
res = await fetch(`${base}/${claimId}/attachments/${second.id}/file`);
check('its bytes are no longer served', res.status, 404);
check('the other one still is', (await fetch(`${base}/${claimId}/attachments/${att.id}/file`)).status, 200);

// --- locked once approved --------------------------------------------------------
// Approval needs an approver; the store is sessionless here, so approve by
// hand the way the fixture tests do and check the lock holds.
const { readFileSync } = await import('node:fs');
const { saveCollection } = await import('../src/jsonStore.ts');
const stored = JSON.parse(readFileSync(join(DATA_DIR, 'claims.json'), 'utf8')).items as any[];
stored.find((c) => c.id === claimId).approvalStatus = 'approved';
saveCollection('claims', stored);
r = await call('POST', `/${claimId}/attachments`, { fileName: 'late.png', fileBase64: PNG, mediaType: 'image/png' });
check('an approved claim takes no more paper', [r.status, r.body.error], [409, 'claim_locked']);
r = await call('DELETE', `/${claimId}/attachments/${att.id}`);
check('and loses none', [r.status, r.body.error], [409, 'claim_locked']);
check('the file still opens on an approved claim', (await fetch(`${base}/${claimId}/attachments/${att.id}/file`)).status, 200);

if (failures) console.error(`\n${failures} failure(s)`);
else console.log('\nAll claim attachment tests passed.');
await finish(failures, server);
