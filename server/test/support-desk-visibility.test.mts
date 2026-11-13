// The Support Desk is private to whoever filed a ticket, with two wider readers:
//  - a SITE ADMIN (an account owner / the practice's Owner or Practice Admin)
//    sees every ticket in every entity;
//  - a Business Admin sees the tickets filed in the entities they are Business
//    Admin of, and no others.
// Everybody else sees only their own. 404 rather than 403 for what they may not
// see, since whether a ticket exists is itself not theirs to learn. The Testing
// checklist is a shared worklist and stays open.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-desk-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';
process.env.OWNER_EMAILS = 'site.admin@cy-bm.sg';

const now = new Date(0).toISOString();
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_acme', orgId: 'cybm', name: 'Acme', tenantId: 't-a', tenantName: 'Acme', createdAt: now, createdBy: '' },
      { id: 'org_beta', orgId: 'cybm', name: 'Beta', tenantId: 't-b', tenantName: 'Beta', createdAt: now, createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { boardRouter } = await import('../src/board.ts');
const { ensure, save } = await import('../src/users.ts');

const items = ensure('cybm');
const template = items[0]!;
const person = (email: string, over: Record<string, unknown>) =>
  ({
    ...template,
    id: `u_${email}`,
    name: email.split('@')[0],
    email,
    practice: false,
    practiceRole: 'Standard',
    allClients: false,
    clientAccess: [],
    extraAccess: [],
    removed: false,
    deactivated: false,
    ...over,
  }) as never;

items.unshift(
  person('site.admin@cy-bm.sg', { practice: true, practiceRole: 'Owner', allClients: true, role: 'Business Admin' }),
  person('acme.admin@acme.example', { organisationId: 'org_acme', role: 'Business Admin' }),
  person('acme.staff@acme.example', { organisationId: 'org_acme', role: 'Standard' }),
  person('acme.staff2@acme.example', { organisationId: 'org_acme', role: 'Standard' }),
  person('beta.admin@beta.example', { organisationId: 'org_beta', role: 'Business Admin' }),
  person('beta.staff@beta.example', { organisationId: 'org_beta', role: 'Standard' })
);
save(items);

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/board', boardRouter);
const server = app.listen(4641, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const as = (email: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name: email }, 'test-session-secret', { expiresIn: '1h' })}`;

async function call(method: string, path: string, who: string, org: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:4641/api/board${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: as(who), 'X-Org-Id': org },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const texts = (r: { body: any }) => (r.body.items ?? []).map((i: any) => i.text).sort();

// --- Filing ------------------------------------------------------------------
// Somebody typing another person's name as the author must not be believed:
// the ticket belongs to the session.
const a1 = await call('POST', '/support', 'acme.staff@acme.example', 'org_acme', { text: 'acme staff ticket', author: 'Somebody Else' });
const a2 = await call('POST', '/support', 'acme.staff2@acme.example', 'org_acme', { text: 'acme staff2 ticket' });
const b1 = await call('POST', '/support', 'beta.staff@beta.example', 'org_beta', { text: 'beta staff ticket' });
const aa = await call('POST', '/support', 'acme.admin@acme.example', 'org_acme', { text: 'acme admin ticket' });
check('filing works', [a1.status, a2.status, b1.status, aa.status], [200, 200, 200, 200]);
check('the ticket belongs to the session, not the claimed author', a1.body.item.authorEmail, 'acme.staff@acme.example');
check('and to the entity they had open', a1.body.item.orgId, 'org_acme');

// --- A standard user ---------------------------------------------------------
let r = await call('GET', '/support', 'acme.staff@acme.example', 'org_acme');
check('a standard user sees only their own', texts(r), ['acme staff ticket']);
check('and is told it is their own view', r.body.scope, 'own');
check('they cannot manage it as staff', r.body.items[0].canManage, false);

r = await call('GET', '/support', 'acme.staff2@acme.example', 'org_acme');
check('a colleague in the same entity sees none of it', texts(r), ['acme staff2 ticket']);

// Reaching by id: the same 404 as a ticket that does not exist.
r = await call('POST', `/support/${a1.body.item.id}/comment`, 'acme.staff2@acme.example', 'org_acme', { text: 'hi' });
check('cannot comment on somebody else’s ticket', [r.status, r.body.error], [404, 'not_found']);
r = await call('PATCH', `/support/${a1.body.item.id}`, 'acme.staff2@acme.example', 'org_acme', { status: 'closed' });
check('cannot close it', [r.status, r.body.error], [404, 'not_found']);
r = await call('DELETE', `/support/${a1.body.item.id}`, 'acme.staff2@acme.example', 'org_acme');
check('cannot delete it', [r.status, r.body.error], [404, 'not_found']);

// Their own: reply and close are theirs; handing it to somebody is staff's.
r = await call('POST', `/support/${a1.body.item.id}/comment`, 'acme.staff@acme.example', 'org_acme', { text: 'more detail' });
check('the author may reply', r.status, 200);
r = await call('PATCH', `/support/${a1.body.item.id}`, 'acme.staff@acme.example', 'org_acme', { status: 'closed' });
check('and close their own case', [r.status, r.body.item?.status], [200, 'closed']);
r = await call('PATCH', `/support/${a1.body.item.id}`, 'acme.staff@acme.example', 'org_acme', { assignee: { id: 'x', name: 'X' } });
check('but not assign it', [r.status, r.body.error], [403, 'not_allowed']);

// --- A Business Admin --------------------------------------------------------
r = await call('GET', '/support', 'acme.admin@acme.example', 'org_acme');
check('a Business Admin sees every ticket of their entity', texts(r), ['acme admin ticket', 'acme staff ticket', 'acme staff2 ticket']);
check('and is told it is the entity’s view', r.body.scope, 'org');
check('with the staff controls', r.body.items.every((i: any) => i.canManage), true);

r = await call('PATCH', `/support/${a2.body.item.id}`, 'acme.admin@acme.example', 'org_acme', { assignee: { id: 'a', name: 'A' } });
check('and may assign one', [r.status, r.body.item?.assignee?.id], [200, 'a']);

// Visibility follows the TICKET's entity, not the header: naming Beta does not
// open Beta's tickets to an Acme admin.
check(
  'but never another entity’s tickets, even naming it',
  texts(await call('GET', '/support', 'acme.admin@acme.example', 'org_beta')).includes('beta staff ticket'),
  false
);
r = await call('GET', '/support', 'beta.admin@beta.example', 'org_beta');
check('the other entity’s admin sees theirs only', texts(r), ['beta staff ticket']);
r = await call('PATCH', `/support/${a1.body.item.id}`, 'beta.admin@beta.example', 'org_beta', { status: 'open' });
check('and cannot touch Acme’s', [r.status, r.body.error], [404, 'not_found']);

// A Business Admin of one entity is not an admin of another they merely work in.
// (Own tickets stay theirs wherever filed.)
const own = await call('POST', '/support', 'acme.admin@acme.example', 'org_acme', { text: 'second acme admin ticket' });
check('their own tickets stay theirs', own.status, 200);

// --- A site admin ------------------------------------------------------------
r = await call('GET', '/support', 'site.admin@cy-bm.sg', 'org_acme');
check('a site admin sees every ticket in every entity', texts(r).length, 5);
check('whichever entity they have open', texts(await call('GET', '/support', 'site.admin@cy-bm.sg', 'org_beta')).length, 5);
check('and is told so', r.body.scope, 'all');
check('each names its entity', r.body.items.map((i: any) => i.orgName).sort(), ['Acme', 'Acme', 'Acme', 'Acme', 'Beta']);
r = await call('DELETE', `/support/${b1.body.item.id}`, 'site.admin@cy-bm.sg', 'org_beta');
check('and may delete any', r.status, 200);

// --- Tickets filed before the desk was private --------------------------------
// They carry no owner, so nobody but a site admin can see them.
const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');
const all = loadCollection<any>('board_items');
all.push({
  id: 'legacy-1', workspaceId: 'cybm', board: 'support', text: 'legacy ticket', screenshots: [], status: 'open',
  author: 'Acme Staff', created_at: now, comments: [], assignee: null, seq: 1, deleted: false,
});
saveCollection('board_items', all);
check('a legacy ticket is hidden from its entity’s admin', texts(await call('GET', '/support', 'acme.admin@acme.example', 'org_acme')).includes('legacy ticket'), false);
check('and from a standard user', texts(await call('GET', '/support', 'acme.staff@acme.example', 'org_acme')).includes('legacy ticket'), false);
check('but a site admin sees it', texts(await call('GET', '/support', 'site.admin@cy-bm.sg', 'org_acme')).includes('legacy ticket'), true);

// --- Feature requests are the same desk; Testing is shared -------------------
await call('POST', '/features', 'acme.staff@acme.example', 'org_acme', { text: 'a feature' });
check('feature requests are private too', texts(await call('GET', '/features', 'acme.staff2@acme.example', 'org_acme')), []);
r = await call('GET', '/testing', 'acme.staff2@acme.example', 'org_acme');
check('the testing checklist stays shared', r.body.items.length > 0, true);
check('as a shared view', r.body.scope, 'shared');

await finish(failures, server);
