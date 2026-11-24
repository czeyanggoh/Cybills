// Approval by WhatsApp. The ticked claims go to the entity's approval group as
// PDFs and one message carrying a link; the link opens a page holding exactly
// those claims, and the decision is made in CYBills by the people who could
// always make it. Driven over real HTTP, with a stub standing in for
// CYWorkspace (which runs the WhatsApp number), so what is asserted is the
// request that actually goes out.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claim-wa-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4652';
process.env.CYWORKSPACE_API_KEY = 'cyws-key';
process.env.APP_ORIGIN = 'https://cybills.example';
process.env.CLAIM_DECISION_NOTICE_MS = '50';

// --- The stand-in CYWorkspace ---------------------------------------------------
const sends: any[] = [];
let failSend = false;
const cyws = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url || '/', 'http://x');
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-api-key'] !== 'cyws-key') return json(401, { error: 'invalid_api_key' });
    if (url.pathname === '/api/webhooks/cybills/groups') {
      return json(200, { groups: url.searchParams.get('tenant_id') === 't-red' ? [{ chat_id: 'g-accts@g.us', name: 'Accts - Red Alpha' }, { chat_id: 'g-pay@g.us', name: 'Payments' }] : [] });
    }
    if (url.pathname === '/api/webhooks/cybills/send-to-group') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (failSend) return json(502, { error: 'send_failed', message: 'WhatsApp is not connected' });
      sends.push(body);
      return json(200, { data: { chat_id: body.chat_id, name: 'Accts - Red Alpha', files: (body.files || []).map((f: any) => f.filename), text_sent: true } });
    }
    json(404, {});
  });
});
cyws.listen(4652, '127.0.0.1');
await new Promise((r) => cyws.once('listening', r));

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
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { claimsRouter, approvalRequestText } = await import('../src/claims.ts');
const { ensure, save } = await import('../src/users.ts');

const items = ensure('cybm');
const seedColleague = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ ...seedColleague, id, name, email, practice: false, practiceRole: 'Standard', role, allClients: false, clientAccess: [], organisationId: 'org-red', deactivated: false, pending: false, managerId: '', ...extra }) as never;
items.unshift(
  employee('emp_martin', 'Martin Lim', 'martin@redalpha.example', 'Business Admin'),
  employee('emp_astrid', 'Astrid Test', 'astrid@redalpha.example', 'Standard', { managerId: 'emp_martin' }),
  employee('emp_ben', 'Ben Loose', 'ben@redalpha.example', 'Standard'),
  employee('emp_other', 'Other Person', 'other@redalpha.example', 'Standard')
);
save(items);

const claimRow = (id: string, claimFor: string, total: string, extra: Record<string, unknown> = {}) => ({
  id, workspaceId: 'cybm', orgId: 'org-red', claimFor, type: 'Regular', name: `${claimFor.split(' ')[0]} claim`,
  claimDate: '2026-11-23', endDate: '2026-11-30', currency: 'SGD',
  transactions: [{ itemId: `i-${id}`, date: '2026-11-20', supplier: 'Clinic', category: 'Medical', net: total, tax: '0', total }],
  history: [], approvalStatus: '', approver: '', approverEmail: '',
  decidedBy: '', decidedAt: '', archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
  ...extra,
});
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({
    items: [
      claimRow('a-1', 'Astrid Test', '190.00'),
      claimRow('b-1', 'Ben Loose', '45.50'),
      claimRow('a-done', 'Astrid Test', '10.00', { approvalStatus: 'approved', decidedBy: 'Martin Lim', decidedAt: new Date(2).toISOString() }),
      claimRow('a-bad', 'Astrid Test', '10.00', { transactions: [{ itemId: 'i-bad', date: '', supplier: 'Grab', category: 'Medical', net: '10', tax: '0', total: '10' }] }),
    ],
  })
);

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());
app.use('/api/claims', claimsRouter);
const server = app.listen(4651, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const as = (email: string, name: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name }, 'test-session-secret', { expiresIn: '1h' })}`;
const MARTIN = as('martin@redalpha.example', 'Martin Lim');
const ASTRID = as('astrid@redalpha.example', 'Astrid Test');
const OTHER = as('other@redalpha.example', 'Other Person');
const call = async (method: string, path: string, cookie: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4651/api/claims${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': 'org-red', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

// --- The message ----------------------------------------------------------------
const text = approvalRequestText({
  claims: [
    { claimFor: 'Sandy', name: 'Sandy Expenses Claim', currency: 'SGD', total: '190.00' },
    { claimFor: 'Ben', name: 'Ben claim', currency: 'SGD', total: '1045.5' },
  ],
  requestedBy: 'HQ', entityName: 'Nucleo', note: 'Thanks', url: 'https://x/approvals/apr_1?org=o',
});
check('several claims: counted, listed, totalled and linked', text, [
  '*2 expense claims for approval*', 'Nucleo · requested by HQ', '',
  '1. Sandy · Sandy Expenses Claim · SGD 190.00', '2. Ben · Ben claim · SGD 1,045.50', 'Total SGD 1,235.50',
  '', 'Thanks', '', 'Review and approve all here:', 'https://x/approvals/apr_1?org=o',
].join('\n'));

// --- The group is the entity's setting, chosen by its admin ----------------------
let r = await call('POST', '/approval-requests', ASTRID, { claimIds: ['a-1'] });
check('no group chosen yet: nothing is sent', [r.status, r.body.error, sends.length], [409, 'no_group', 0]);

r = await call('PUT', '/approval-group', ASTRID, { chatId: 'g-accts@g.us' });
check('a Standard user cannot choose the group', r.status, 403);
r = await call('GET', '/approval-group?candidates=1', ASTRID);
check('nor is a Standard user shown the groups on offer', [r.body.canManage, r.body.candidates], [false, undefined]);
r = await call('GET', '/approval-group?candidates=1', MARTIN);
check('the Business Admin is offered the groups linked to this organisation', r.body.candidates?.map((g: any) => g.name), ['Accts - Red Alpha', 'Payments']);
r = await call('PUT', '/approval-group', MARTIN, { chatId: 'g-elsewhere@g.us' });
check('a group CYWorkspace does not offer for this entity is refused', [r.status, r.body.error], [404, 'group_not_linked']);
r = await call('PUT', '/approval-group', MARTIN, { chatId: 'g-accts@g.us' });
check('the admin chooses the group', r.body.group, { chatId: 'g-accts@g.us', name: 'Accts - Red Alpha' });

// --- Refusals leave the group untouched -----------------------------------------
r = await call('POST', '/approval-requests', ASTRID, { claimIds: ['a-1', 'a-bad'] });
check('one incomplete claim stops the whole request', [r.status, r.body.error, r.body.problems?.[0]?.claimId, sends.length], [422, 'claims_not_ready', 'a-bad', 0]);
r = await call('POST', '/approval-requests', ASTRID, { claimIds: ['a-done'] });
check('an approved claim is not sent again', [r.status, r.body.error], [409, 'already_approved']);
r = await call('POST', '/approval-requests', OTHER, { claimIds: ['a-1'] });
check("somebody else's claim cannot be sent by a bystander", r.status, 404);

failSend = true;
r = await call('POST', '/approval-requests', ASTRID, { claimIds: ['a-1'] });
check('a send WhatsApp refused is reported in its words', [r.status, /WhatsApp is not connected/.test(r.body.message)], [502, true]);
r = await call('GET', '/', MARTIN);
check('and the claim is left as it was', r.body.claims.find((c: any) => c.id === 'a-1')?.approvalStatus, '');
failSend = false;

// --- The send -------------------------------------------------------------------
r = await call('POST', '/approval-requests', MARTIN, { claimIds: ['a-1', 'b-1', 'a-done'], note: 'For approval. Thanks' });
check('several claims go in one request', [r.status, r.body.request?.claims, r.body.skipped?.[0]?.claimId], [200, 2, 'a-done']);
const rid = r.body.request?.id;
const sent = sends[0];
check('to the chosen group of this tenant', [sent?.tenant_id, sent?.chat_id], ['t-red', 'g-accts@g.us']);
check('one PDF per claim', sent?.files?.map((f: any) => [f.filename, f.mimetype, Buffer.from(f.base64, 'base64').subarray(0, 4).toString()]), [
  ['Astrid claim.pdf', 'application/pdf', '%PDF'], ['Ben claim.pdf', 'application/pdf', '%PDF'],
]);
check('the message links to the request, in its entity', sent?.text.includes(`https://cybills.example/approvals/${rid}?org=org-red`), true);
check('and lists both claims with the total', [/1\. Astrid Test · Astrid claim · SGD 190\.00/.test(sent?.text), /Total SGD 235\.50/.test(sent?.text), /For approval\. Thanks/.test(sent?.text)], [true, true, true]);
const after = r.body.claims;
check('a claimant with a manager is routed to them', [after[0].approvalStatus, after[0].approver], ['awaiting_approval', 'Martin Lim']);
check('one with none is open to whoever may decide here', [after[1].approvalStatus, after[1].approver], ['awaiting_approval', '']);
check('and the trail says where it went', after[0].history[0].text, 'This claim was submitted for approval to Martin Lim in the WhatsApp group "Accts - Red Alpha"');

// --- The page behind the link ---------------------------------------------------
r = await call('GET', `/approval-requests/${rid}`, MARTIN);
check('the approver sees both claims and may decide both', r.body.claims?.map((c: any) => [c.id, c.canDecide]), [['a-1', true], ['b-1', true]]);
r = await call('GET', `/approval-requests/${rid}`, ASTRID);
check('the claimant sees only her own, and may not decide it', [r.body.claims?.map((c: any) => [c.id, c.canDecide]), r.body.request?.hidden], [[['a-1', false]], 1]);
r = await call('GET', '/approval-requests/apr_nope', MARTIN);
check('an unknown request is a 404', r.status, 404);

// --- Deciding, and the group hearing of it once ----------------------------------
r = await call('POST', '/a-1/approve', ASTRID);
check('the link gives nobody the right to approve their own claim', r.status, 403);
r = await call('POST', '/a-1/approve', MARTIN);
const r2 = await call('POST', '/b-1/reject', MARTIN, { reason: 'No receipt' });
check('the approver decides in CYBills', [r.status, r2.status], [200, 200]);
await new Promise((res) => setTimeout(res, 400));
check('and the group is told once, for both', [sends.length, sends[1]?.files?.length, sends[1]?.text], [2, 0, [
  '✅ Approved: Astrid Test · Astrid claim · SGD 190.00',
  '❌ Rejected: Ben Loose · Ben claim · SGD 45.50 (No receipt)',
  'by Martin Lim, in CYBills',
].join('\n')]);

r = await call('POST', '/approval-requests', MARTIN, { claimIds: ['b-1'] });
check('a rejected claim can be fixed and sent again', [r.status, r.body.claims?.[0]?.approvalStatus], [200, 'awaiting_approval']);

server.close();
cyws.close();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
