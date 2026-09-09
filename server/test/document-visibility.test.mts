// What a Standard user may see.
//
// The Edit privileges dialog has always offered three roles and an "Access all
// documents" toggle, and none of it reached the listing: every signed-in person
// in an entity saw every document and every claim in it, so "Standard" only
// ever meant "kept off the Users page and out of Business settings".
//
// It now means what it says. A Standard user sees their OWN submissions and
// those of the people who report to them — the Direct manager column on the
// Users page, which is the line a claim's approval already travels up. One
// level, deliberately: somebody who needs a whole tree gets accessAll, which is
// what that toggle is for.
//
// The trap this has to avoid is the one that killed the first attempt: filtered
// on the document's OWNER alone, a person's own upload vanished from every tab
// the moment that (editable) field drifted from their session. So the set is
// matched against createdBy — never rewritten — as well as the owner.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-visibility-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity Pte. Ltd.', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const jwt = (await import('jsonwebtoken')).default;
const { billsRouter } = await import('../src/bills.ts');
const { claimsRouter } = await import('../src/claims.ts');
const { insertBill } = await import('../src/store.ts');
const { ensure, save, generalUserFor } = await import('../src/users.ts');

const RED = 'org-red';

// Red Alpha's own people. Martin reports to nobody, Deanna reports to Martin,
// Astrid reports to Deanna — two levels, so the chain can be asked whether it
// is walked all the way up (it must not be).
const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, role: string, managerId = '', privileges = {}) =>
  ({
    ...seed, id, name, email, role, practice: false, practiceRole: 'Standard', general: false,
    allClients: false, clientAccess: [], extraAccess: [], organisationId: RED,
    deactivated: false, pending: false, removed: false, managerId, privileges,
  }) as never;
items.unshift(
  employee('emp_martin', 'Martin Lim', 'martin@redalphacyber.com', 'Standard'),
  employee('emp_deanna', 'Deanna Chua', 'deanna.chua@redalphacyber.com', 'Standard', 'emp_martin'),
  employee('emp_astrid', 'Astrid Test', 'astrid@redalphacyber.com', 'Standard', 'emp_deanna'),
  employee('emp_boss', 'Bee Admin', 'boss@redalphacyber.com', 'Business Admin'),
  employee('emp_wide', 'Wide Standard', 'wide@redalphacyber.com', 'Standard', '', { accessAll: true }),
  // The practice's own colleague, a Business Admin inside every client she can
  // open — she must keep seeing the whole book.
  { ...seed, id: 'col_kai', name: 'Kai Tan', email: 'kai@cy-bm.sg', practice: true, practiceRole: 'Standard', role: 'Business Admin', allClients: false, clientAccess: ['org-cybm', 'org-red'], deactivated: false, pending: false, removed: false } as never
);
save(items);

const GENERAL = generalUserFor('cybm', RED)!.email;

// The store mints its own ids, so each document is remembered under a readable
// name and the listings are compared by that.
const ids: Record<string, string> = {};
const doc = (name: string, createdBy: string, owner: string) => {
  ids[name] = insertBill({
    orgId: RED, kind: 'cost', status: 'new', documentType: 'Invoice', currency: 'SGD',
    supplier: 'Grab', total: '31.99', tax: '0', date: '2026-09-01', createdBy, owner,
  } as any).id;
};
const nameOf = (id: string) => Object.keys(ids).find((k) => ids[k] === id) ?? id;

doc('d-martin', 'martin@redalphacyber.com', 'martin@redalphacyber.com');
doc('d-deanna', 'deanna.chua@redalphacyber.com', 'deanna.chua@redalphacyber.com');
doc('d-astrid', 'astrid@redalphacyber.com', 'astrid@redalphacyber.com');
doc('d-general', 'kai@cy-bm.sg', GENERAL);
// Deanna uploaded this one and somebody then reassigned the owner away from
// her. Her own upload must not disappear because a field she does not control
// moved — that is the exact bug the first attempt at this shipped.
doc('d-drifted', 'deanna.chua@redalphacyber.com', GENERAL);
// And the mirror: uploaded by somebody else, made over to Deanna to work on.
doc('d-handed-over', 'boss@redalphacyber.com', 'deanna.chua@redalphacyber.com');

const claim = (id: string, claimFor: string, createdBy: string, approver: string, approverEmail: string) => ({
  id, workspaceId: 'cybm', orgId: RED, claimFor, type: 'Regular', name: 'Expense claim',
  claimDate: '2026-09-30', endDate: '2026-09-30', currency: 'SGD', transactions: [], history: [],
  approvalStatus: approverEmail ? 'awaiting_approval' : '', approver, approverEmail,
  decidedBy: '', decidedAt: '', archived: false, deleted: false, createdBy,
  createdAt: new Date(0).toISOString(),
});
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({
    items: [
      claim('c-deanna', 'Deanna Chua', 'deanna.chua@redalphacyber.com', 'Martin Lim', 'martin@redalphacyber.com'),
      claim('c-astrid', 'Astrid Test', 'astrid@redalphacyber.com', 'Deanna Chua', 'deanna.chua@redalphacyber.com'),
      claim('c-boss', 'Bee Admin', 'boss@redalphacyber.com', '', ''),
    ],
  })
);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/costs', billsRouter);
app.use('/api/claims', claimsRouter);
const server = app.listen(4657, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const as = (email: string, name: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name }, 'test-session-secret', { expiresIn: '1h' })}`;
const call = async (method: string, path: string, cookie: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4657${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': RED, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const docsFor = async (email: string, name: string) => {
  const r = await call('GET', '/api/costs/bills', as(email, name));
  return (r.body.bills as any[]).map((b) => nameOf(b.id)).sort();
};
const claimsFor = async (email: string, name: string) => {
  const r = await call('GET', '/api/claims', as(email, name));
  return (r.body.claims as any[]).map((c) => c.id).sort();
};

// --- The whole book, for the people who run it -------------------------------
const everything = ['d-astrid', 'd-deanna', 'd-drifted', 'd-general', 'd-handed-over', 'd-martin'];
check('a Business Admin sees the entire book', await docsFor('boss@redalphacyber.com', 'Bee Admin'), everything);
check('a practice colleague working the client sees it too', await docsFor('kai@cy-bm.sg', 'Kai Tan'), everything);
check('so does a Standard user given Access all documents', await docsFor('wide@redalphacyber.com', 'Wide Standard'), everything);

// --- A Standard user sees their own work, and their reports' -----------------
const deanna = await docsFor('deanna.chua@redalphacyber.com', 'Deanna Chua');
check('Deanna sees her own work and her report Astrid\'s', deanna, ['d-astrid', 'd-deanna', 'd-drifted', 'd-handed-over']);
check('her own upload survives the owner being moved off it', deanna.includes('d-drifted'), true);
check('a document made over to her is hers to work on', deanna.includes('d-handed-over'), true);
check('the general account paperwork is not hers', deanna.includes('d-general'), false);

check('Astrid, who manages nobody, sees only her own', await docsFor('astrid@redalphacyber.com', 'Astrid Test'), ['d-astrid']);

// One level. Astrid reports to Deanna, who reports to Martin — and Martin does
// NOT see Astrid's work. A whole tree is what accessAll is for.
// Everything of Deanna's is his to see, by either road: the two she uploaded
// and the one that was made over to her.
const martin = await docsFor('martin@redalphacyber.com', 'Martin Lim');
check('Martin sees his own and all of his direct report\'s', martin, ['d-deanna', 'd-drifted', 'd-handed-over', 'd-martin']);
check('and not his report\'s report\'s', martin.includes('d-astrid'), false);
check('nor the general account\'s', martin.includes('d-general'), false);

// --- The by-id roads, so the list is a rule and not a display detail ---------
let r = await call('GET', `/api/costs/bills/${ids['d-martin']}`, as('astrid@redalphacyber.com', 'Astrid Test'));
check('opening a hidden document by id is a 404', r.status, 404);
r = await call('GET', `/api/costs/bills/${ids['d-astrid']}`, as('astrid@redalphacyber.com', 'Astrid Test'));
check('her own opens', r.status, 200);
r = await call('GET', `/api/costs/bills/${ids['d-martin']}/where`, as('astrid@redalphacyber.com', 'Astrid Test'));
check('and a hidden one cannot be located either', r.status, 404);
r = await call('GET', `/api/costs/bills/${ids['d-astrid']}`, as('boss@redalphacyber.com', 'Bee Admin'));
check('an admin opens anybody document', r.status, 200);

// --- And a write it cannot see is a write it cannot make ---------------------
r = await call('PATCH', `/api/costs/bills/${ids['d-martin']}`, as('astrid@redalphacyber.com', 'Astrid Test'), { supplier: 'Rewritten' });
check('editing a hidden document is refused', r.status, 404);
r = await call('GET', `/api/costs/bills/${ids['d-martin']}`, as('boss@redalphacyber.com', 'Bee Admin'));
check('and nothing was written', r.body.bill?.supplier, 'Grab');
r = await call('DELETE', `/api/costs/bills/${ids['d-martin']}`, as('astrid@redalphacyber.com', 'Astrid Test'));
check('deleting one is refused too', r.status, 404);
r = await call('PATCH', `/api/costs/bills/${ids['d-astrid']}`, as('astrid@redalphacyber.com', 'Astrid Test'), { supplier: 'Her own' });
check('while her own still edits', r.status, 200);

// --- Claims follow the same line ---------------------------------------------
check('an admin sees every claim', await claimsFor('boss@redalphacyber.com', 'Bee Admin'), ['c-astrid', 'c-boss', 'c-deanna']);
check('Deanna sees her own claim and her report claim', await claimsFor('deanna.chua@redalphacyber.com', 'Deanna Chua'), ['c-astrid', 'c-deanna']);
check('Astrid sees only her own', await claimsFor('astrid@redalphacyber.com', 'Astrid Test'), ['c-astrid']);
// Martin is the named approver on Deanna's claim, so he must see it whoever
// raised it — otherwise the approval request arrives by email and leads to an
// empty list.
check('a claim routed to somebody for a decision is visible to them', await claimsFor('martin@redalphacyber.com', 'Martin Lim'), ['c-deanna']);

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
