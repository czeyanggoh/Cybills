// Inbound email: what arrives, who it lands on, and what the covering message
// does.
//
// Somebody emailing a receipt in writes a line with it — "recharge this to
// CY-Biz" — and that line IS the instruction. Reading the attachment while
// throwing the message away loses the only part that says what to do with it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-inbound-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.INBOUND_SECRET = 'test-inbound-secret';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { inboundRouter } = await import('../src/inbound.ts');
const { ensure, save } = await import('../src/users.ts');
const { listBills } = await import('../src/store.ts');

// One person with a known handle: the local-part an emailed document is filed by.
const users = ensure('cybm');
const me = users.find((u) => u.email === 'astridy2004@gmail.com')!;
me.emailHandle = 'astrid4';
me.organisationId = 'org_one0001';
save(users);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api/inbound', inboundRouter);
const server = app.listen(4619, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const post = async (body: unknown, secret = 'test-inbound-secret') => {
  const res = await fetch('http://127.0.0.1:4619/api/inbound/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': secret },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const pdf = Buffer.from('%PDF-1.4 not a real pdf').toString('base64');
const message = {
  to: 'astrid4@cybills.sg',
  from: 'astridy2004@gmail.com',
  subject: '',
  text: 'recharge this to CY-Biz.',
  attachments: [{ filename: '21573635400.pdf', contentType: 'application/pdf', contentBase64: pdf }],
};

// --- The guard ---------------------------------------------------------------
let r = await post(message, 'wrong-secret');
check('a wrong secret is refused', r.status, 401);

// --- An unknown handle is SAID, not swallowed --------------------------------
r = await post({ ...message, to: 'nobody@cybills.sg' });
check('an unknown recipient is a 404', [r.status, r.body.error], [404, 'unknown_recipient']);
check('…naming the address it could not place', r.body.to, 'nobody@cybills.sg');

// --- The document lands ------------------------------------------------------
r = await post(message);
check('a document is filed', [r.status, r.body.kind, r.body.created], [200, 'documents', 1]);

const filed = listBills('cybm').filter((b) => b.fileName === '21573635400.pdf');
check('…once', filed.length, 1);
check('…owned by the person it was addressed to', filed[0].owner, 'astridy2004@gmail.com');
check('…with the file kept', Boolean(filed[0].storageKey), true);

// The covering message rides with the document, which is what lets the read
// (and a person, later) see what the sender asked for.
check('…and the covering message stored', (filed[0] as any).email?.text, 'recharge this to CY-Biz.');
check('…with who sent it', (filed[0] as any).email?.from, 'astridy2004@gmail.com');

// --- A Worker that forwards only the raw MIME --------------------------------
// The envelope recipient is the authority, but a Worker sending raw MIME alone
// supplies none — and the local-part is how a document gets filed, so every
// such delivery used to answer "unknown recipient".
const raw = Buffer.from(
  [
    'From: astridy2004@gmail.com',
    'To: astrid4@cybills.sg',
    'Subject: receipt',
    'Content-Type: text/plain',
    '',
    'recharge this to CY-Biz.',
    '',
  ].join('\r\n'),
).toString('base64');
r = await post({ raw });
check('raw MIME alone still finds the recipient', r.status, 200);
check('…and reads the message off it', r.body.kind, 'documents');

// --- Only documents ----------------------------------------------------------
r = await post({
  ...message,
  attachments: [{ filename: 'signature.txt', contentType: 'text/plain', contentBase64: pdf }],
});
check('a non-document attachment files nothing', r.body.created, 0);

// --- A standing rule, and a note about one document --------------------------
// "everything from Grab is travel" is a policy; "recharge this to CY-Biz" is an
// instruction about THIS receipt. The specific one wins, or writing it was
// pointless — and the reason says which was followed.
const { overlaySupplierRule } = await import('../src/inbound.ts');
const grabRule = { category: '493 - Travel - National', project: 'Ops' };

{
  // No note: the rule decides, as it always has.
  const patch: Record<string, unknown> = { category: '261 - Reimbursement - No GST' };
  overlaySupplierRule(patch, grabRule, { supplier: 'Grab', noteFollowed: '' });
  check('with no note, the standing rule wins', patch.category, '493 - Travel - National');
  check('…and says so', /Standing rule/.test(String(patch.categoryReason)), true);
}

{
  // A note the reader acted on: its category survives the rule.
  const patch: Record<string, unknown> = { category: '261 - Reimbursement - No GST' };
  overlaySupplierRule(patch, grabRule, {
    supplier: 'Grab',
    noteFollowed: 'The sender asked to recharge this to CY-Biz — coded to the recharge account.',
  });
  check('a note about this document beats the rule', patch.category, '261 - Reimbursement - No GST');
  check('…and the reason quotes the email', /From the email that sent this: The sender asked to recharge/.test(String(patch.categoryReason)), true);
  check('…while the rule still fills what the note did not', patch.project, 'Ops');
}

{
  // A note that said nothing about coding leaves the rule alone.
  const patch: Record<string, unknown> = { category: '261 - Reimbursement - No GST' };
  overlaySupplierRule(patch, grabRule, { supplier: 'Grab', noteFollowed: '   ' });
  check('a note with nothing in it changes nothing', patch.category, '493 - Travel - National');
}

{
  // The money is never up for negotiation.
  const patch: Record<string, unknown> = { total: 12.7, tax: 0, category: '261 - Reimbursement - No GST' };
  overlaySupplierRule(patch, { ...grabRule, taxRate: 'No Tax' }, { supplier: 'Grab', noteFollowed: 'recharge to CY-Biz' });
  check('the total is untouched', patch.total, 12.7);
  check('…and the tax code still follows the rule', patch.taxRate, 'No Tax');
}

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
