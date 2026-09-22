// Who sees which Support Desk issue.
//
// The boards were shared across the whole WORKSPACE — one room for every client
// at once. An issue is a person's report of something that went wrong in front
// of them, with a SCREENSHOT of the book it went wrong in attached, so that
// room handed one company's paperwork to every other company's staff.
//
// Three answers now, and the test is that they are three and not one: a person
// sees the issues they RAISED; a Business Admin runs an entity's book and sees
// every issue raised against it; a practice colleague holds client access
// rather than belonging to one entity, so their desk is every client they can
// open. Deliberately NOT widened by "Access all documents" (that toggle is
// about a book of costs, and a ticket is not a document) nor by the Direct
// manager line (a claim is routed to a manager to DECIDE; an issue is routed to
// the practice to fix).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-support-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity Pte. Ltd.', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
      { id: 'org-dart', orgId: 'cybm', name: 'DART Consulting', tenantId: 't-dart', tenantName: 'DART', createdAt: new Date(2).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { boardRouter } = await import('../src/board.ts');
const { ensure, save } = await import('../src/users.ts');
const { saveCollection } = await import('../src/jsonStore.ts');

const RED = 'org-red';
const DART = 'org-dart';

const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, role: string, org: string, managerId = '', privileges = {}) =>
  ({
    ...seed, id, name, email, role, practice: false, practiceRole: 'Standard', general: false,
    allClients: false, clientAccess: [], extraAccess: [], organisationId: org,
    deactivated: false, pending: false, removed: false, managerId, privileges,
  }) as never;
items.unshift(
  employee('emp_deanna', 'Deanna Chua', 'deanna@redalphacyber.com', 'Standard', RED),
  // Astrid reports to Deanna, so the manager line can be asked whether it
  // widens a support desk (it must not).
  employee('emp_astrid', 'Astrid Test', 'astrid@redalphacyber.com', 'Standard', RED, 'emp_deanna'),
  employee('emp_boss', 'Bee Admin', 'boss@redalphacyber.com', 'Business Admin', RED),
  employee('emp_wide', 'Wide Standard', 'wide@redalphacyber.com', 'Standard', RED, '', { accessAll: true }),
  employee('emp_dart', 'Dara Admin', 'dara@dartconsulting.com', 'Business Admin', DART),
  // The practice's own colleague, working both clients.
  { ...seed, id: 'col_kai', name: 'Kai Tan', email: 'kai@cy-bm.sg', practice: true, practiceRole: 'Standard', role: 'Business Admin', allClients: false, clientAccess: ['org-cybm', RED, DART], deactivated: false, pending: false, removed: false } as never
);
save(items);

// One issue raised back when the board recorded neither an entity nor a raiser.
// All it carries is Deanna's display NAME, which is what the backfill has to
// resolve — and the Testing checklist's own rows, which name nobody at all.
saveCollection('board_items', [
  {
    id: 'legacy-1', workspaceId: 'cybm', board: 'support', text: 'Legacy: the Costs list wraps',
    screenshots: [], status: 'open', author: 'Deanna Chua', created_at: new Date(0).toISOString(),
    comments: [], assignee: null, seq: 1, deleted: false,
  },
]);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/board', boardRouter);
const server = app.listen(4671, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const as = (email: string, name: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name }, 'test-session-secret', { expiresIn: '1h' })}`;
const call = async (method: string, path: string, who: [string, string], org: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4671${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org, Cookie: as(who[0], who[1]) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const DEANNA: [string, string] = ['deanna@redalphacyber.com', 'Deanna Chua'];
const ASTRID: [string, string] = ['astrid@redalphacyber.com', 'Astrid Test'];
const BOSS: [string, string] = ['boss@redalphacyber.com', 'Bee Admin'];
const WIDE: [string, string] = ['wide@redalphacyber.com', 'Wide Standard'];
const DARA: [string, string] = ['dara@dartconsulting.com', 'Dara Admin'];
const KAI: [string, string] = ['kai@cy-bm.sg', 'Kai Tan'];

const raise = async (who: [string, string], org: string, text: string) => {
  const r = await call('POST', '/api/board/support', who, org, { text, author: who[1] });
  return r.body.item.id as string;
};
const listFor = async (who: [string, string], org: string, board = 'support') => {
  const r = await call('GET', `/api/board/${board}`, who, org);
  return r.body;
};
const textsFor = async (who: [string, string], org: string) =>
  ((await listFor(who, org)).items as any[]).map((x) => x.text).sort();

const idDeanna = await raise(DEANNA, RED, 'Deanna: a receipt will not read');
await raise(ASTRID, RED, 'Astrid: the claim PDF is blank');
await raise(BOSS, RED, 'Bee: publishing is slow');
await raise(DARA, DART, 'Dara: the Xero link is dead');

// --- A person sees the issues they raised -----------------------------------
check('a Standard user sees only her own', await textsFor(DEANNA, RED), [
  'Deanna: a receipt will not read',
  'Legacy: the Costs list wraps',
]);
check(
  'her issue raised before the board recorded a raiser is still hers',
  ((await listFor(DEANNA, RED)).items as any[]).some((x) => x.id === 'legacy-1'),
  true
);
check('a direct report does not see her manager’s', await textsFor(ASTRID, RED), ['Astrid: the claim PDF is blank']);
check(
  'and a manager does not see her direct report’s — an issue is not a claim',
  (await textsFor(DEANNA, RED)).includes('Astrid: the claim PDF is blank'),
  false
);
check(
  '"Access all documents" is about documents, so it does not widen this',
  await textsFor(WIDE, RED),
  []
);

// --- A Business Admin runs the entity, and sees every issue in it ------------
// The legacy row is among them: the backfill filed it in its raiser's own
// entity, which is where she would raise it today, so it reaches her admin the
// same way her new one does.
check('a Business Admin sees every issue raised in the entity', await textsFor(BOSS, RED), [
  'Astrid: the claim PDF is blank',
  'Bee: publishing is slow',
  'Deanna: a receipt will not read',
  'Legacy: the Costs list wraps',
]);
check(
  'but never another client’s',
  (await textsFor(BOSS, RED)).some((t) => t.startsWith('Dara')),
  false
);
check('the other client’s admin sees only theirs', await textsFor(DARA, DART), ['Dara: the Xero link is dead']);
// Naming an entity she cannot open changes nothing: orgScope lands her back in
// her own, so the header is not a way into somebody else's desk. (In the app
// the X-Org-Id guard refuses that request outright, one layer above this.)
check(
  'and naming an entity she cannot open gets her her own desk, not its',
  await textsFor(DARA, RED),
  ['Dara: the Xero link is dead']
);

// --- A practice colleague's desk is every client they can open ---------------
check('a practice colleague sees every client’s', await textsFor(KAI, RED), [
  'Astrid: the claim PDF is blank',
  'Bee: publishing is slow',
  'Dara: the Xero link is dead',
  'Deanna: a receipt will not read',
  'Legacy: the Costs list wraps',
]);
const kaiRows = (await listFor(KAI, RED)).items as any[];
check(
  'an issue from another entity says whose it is',
  kaiRows.find((x) => x.text.startsWith('Dara'))?.orgName,
  'DART Consulting'
);
check(
  'and one from the entity they are standing in does not repeat it',
  'orgName' in (kaiRows.find((x) => x.text.startsWith('Bee')) ?? {}),
  false
);

// --- The board says which of the three answers it gave ----------------------
check('the scope is named for a Standard user', (await listFor(DEANNA, RED)).scope, 'own');
check('…for a Business Admin', (await listFor(BOSS, RED)).scope, 'entity');
check('…and for a colleague', (await listFor(KAI, RED)).scope, 'clients');
check('with the entity’s own name to say it with', (await listFor(BOSS, RED)).orgName, 'Red Alpha Cybersecurity Pte. Ltd.');

// --- The Testing checklist is the practice's own -----------------------------
check('a client’s Business Admin is not handed the practice’s QA list', ((await listFor(BOSS, RED, 'testing')).items as any[]).length, 0);
check('the practice has it', ((await listFor(KAI, RED, 'testing')).items as any[]).length > 30, true);

// --- And it is a rule, not a display detail ---------------------------------
// Every write asks the same question the list asked, and answers 404 rather
// than 403: whether somebody else's ticket exists is not the caller's to learn.
let r = await call('PATCH', `/api/board/support/${idDeanna}`, ASTRID, RED, { status: 'closed' });
check('closing somebody else’s issue is refused', r.status, 404);
r = await call('POST', `/api/board/support/${idDeanna}/comment`, ASTRID, RED, { text: 'me too' });
check('so is replying to it', r.status, 404);
r = await call('DELETE', `/api/board/support/${idDeanna}`, ASTRID, RED);
check('so is deleting it', r.status, 404);
r = await call('GET', '/api/board/support', DEANNA, RED);
check('and nothing was written', r.body.items.find((x: any) => x.id === idDeanna)?.status, 'open');
r = await call('PATCH', `/api/board/support/${idDeanna}`, DEANNA, RED, { status: 'closed' });
check('while her own closes', r.status, 200);
r = await call('POST', `/api/board/support/${idDeanna}/comment`, BOSS, RED, { text: 'looking at it' });
check('and the admin who runs her entity can reply to it', r.status, 200);

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll support-desk visibility checks passed.');
process.exit(failures ? 1 : 0);
