// Expense claims are per client entity. Claims were built when CYBills served
// one company, so they were scoped by a constant workspace id and every entity
// saw the same list. This covers the scoping and the backfill that gives the
// claims written before it an entity of their own.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claims-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

// Two linked entities. Both records live in the workspace scope ('cybm') —
// that is how organisations are stored — while their books do not.
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
const { claimsRouter } = await import('../src/claims.ts');
const { insertBill } = await import('../src/store.ts');

// A bill in each entity's book. 'org-cybm' is the primary org, whose data scope
// is the legacy 'cybm'; every other entity keeps its own id.
const cybmBill = insertBill({
  orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'Singtel', invoiceNumber: 'S-1',
  documentType: 'Invoice', currency: 'SGD', date: '2026-07-31', category: '489 - Telephone',
  description: 'CYBM broadband', total: '100', tax: '0',
} as any);
const redBill = insertBill({
  orgId: 'org-red', kind: 'cost', status: 'ready', supplier: 'AWS', invoiceNumber: 'A-1',
  documentType: 'Invoice', currency: 'SGD', date: '2026-07-31', category: '470 - IT Services',
  description: 'Red Alpha hosting', total: '250', tax: '0',
} as any);

// A claim written before entity scoping: no orgId, one item from Red Alpha's
// book — and one with no items at all.
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({
    items: [
      {
        id: 'legacy-red', workspaceId: 'cybm', claimFor: 'Cze Yang Goh', type: 'Regular',
        name: 'test claim CY', claimDate: '', endDate: '2026-07-31', currency: 'SGD',
        transactions: [{ itemId: redBill.id, date: '2026-07-31', supplier: 'AWS', category: '470 - IT Services', net: '250', tax: '0', total: '250' }],
        history: [], approvalStatus: 'approved', approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
        archived: true, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
        hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
      },
      {
        id: 'legacy-empty', workspaceId: 'cybm', claimFor: 'Cze Yang Goh', type: 'Regular',
        name: 'Expense claim', claimDate: '', endDate: '', currency: 'SGD',
        transactions: [], history: [], approvalStatus: '', approver: '', approverEmail: '',
        decidedBy: '', decidedAt: '', archived: false, deleted: false, createdBy: '',
        createdAt: new Date(0).toISOString(), hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
      },
    ],
  })
);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/claims', claimsRouter);
const server = app.listen(4605, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const base = 'http://127.0.0.1:4605/api/claims';
const asOrg = (orgId: string) => (orgId ? { 'X-Org-Id': orgId } : {});
const list = async (orgId: string) => {
  const res = await fetch(base, { headers: asOrg(orgId) as any });
  return (await res.json()).claims as any[];
};
const post = async (orgId: string, path: string, body: unknown) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...asOrg(orgId) } as any,
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// 1) The backfill: a legacy claim lands in the entity its own items came from.
check('legacy claim follows its items to Red Alpha', (await list('org-red')).map((c) => c.id), ['legacy-red']);
check('an itemless legacy claim stays in the primary book', (await list('org-cybm')).map((c) => c.id), ['legacy-empty']);
check('the backfill is written back to disk',
  JSON.parse(readFileSync(join(DATA_DIR, 'claims.json'), 'utf8')).items.map((c: any) => [c.id, c.orgId]),
  [['legacy-red', 'org-red'], ['legacy-empty', 'cybm']]);

// 2) A new claim belongs to the entity it was created in, and nobody else.
const made = await post('org-red', '/', { name: 'Red Alpha kit' });
check('created in Red Alpha', made.body.claim.orgId, 'org-red');
check('Red Alpha sees both of its claims', (await list('org-red')).length, 2);
check('CYBM does not see it', (await list('org-cybm')).map((c) => c.name), ['Expense claim']);
check('no entity selected falls back to the primary book', (await list('')).map((c) => c.name), ['Expense claim']);

// 3) A claim can't be reached, or mutated, from another entity.
check('renaming it from CYBM is a 404', (await post('org-cybm', `/${made.body.claim.id}/update`, { name: 'Stolen' })).status, 404);
check('renaming it from Red Alpha works', (await post('org-red', `/${made.body.claim.id}/update`, { name: 'Red Alpha kit v2' })).status, 200);

// 4) Items come from the claim's own book — another entity's bill can't be added.
const addedForeign = await post('org-red', `/${made.body.claim.id}/items`, {
  items: [{ itemId: cybmBill.id, date: '2026-07-31', supplier: 'Singtel', category: '489 - Telephone', net: '100', tax: '0', total: '100' }],
});
check('adding CYBM’s bill to a Red Alpha claim is refused', [addedForeign.status, addedForeign.body.error], [409, 'foreign_item']);

const addedOwn = await post('org-red', `/${made.body.claim.id}/items`, {
  items: [{ itemId: redBill.id, date: '2026-07-31', supplier: 'AWS', category: '470 - IT Services', net: '250', tax: '0', total: '250' }],
});
check('adding its own entity’s bill works', addedOwn.status, 200);

// 5) Descriptions are read from the claim's own book, never across entities.
const red = (await list('org-red')).find((c) => c.id === made.body.claim.id);
check('the line description comes from Red Alpha’s bill', red.transactions[0].description, 'Red Alpha hosting');

// 6) The scheduled auto-filer builds claims too, so it files into an entity —
// and never folds one entity's documents into another's open auto claim.
const { fileAutoClaim } = await import('../src/claims.ts');
const auto = (org: string) =>
  fileAutoClaim('cybm', org, {
    claimFor: 'Astrid', periodEnd: '2026-08-31', periodLabel: '31 Aug 2026',
    name: 'Auto claim — 31 Aug 2026', txns: [], by: 'Automation',
  });
const autoRed = auto('org-red');
check('the auto-filer creates a claim', autoRed.created, true);
check('it belongs to the entity it filed for', (await list('org-red')).some((c) => c.id === autoRed.claimId), true);
check('and not to the other entity', (await list('org-cybm')).some((c) => c.id === autoRed.claimId), false);

const autoCybm = auto('org-cybm');
check('the same period in another entity gets its own claim', [autoCybm.created, autoCybm.claimId !== autoRed.claimId], [true, true]);
check('filing Red Alpha’s period again reuses its own open claim', auto('org-red').claimId, autoRed.claimId);

server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
