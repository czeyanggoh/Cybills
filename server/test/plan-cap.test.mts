// A subscription plan's monthly document limit: what counts, when reading stops,
// and who may set a plan. Past the limit a document is still FILED, only not READ.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-plan-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-sub', orgId: 'cybm', name: 'Subscriber Pte Ltd', tenantId: 't-sub', tenantName: 'Subscriber', createdAt: new Date(1).toISOString(), createdBy: '' },
    ],
  })
);

const R = await import('../src/planRules.ts');
const { insertBill } = await import('../src/store.ts');
const { documentsThisMonth, planStateFor, capRefusal, refuseIfOverPlan, planRouter } = await import('../src/plan.ts');
const { setOrganisationPlan } = await import('../src/organisations.ts');
const express = (await import('express')).default;

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- the rules ------------------------------------------------------------
check('the four levels carry 100 / 300 / 600 / 1500 documents', R.PLAN_LEVELS.map((p) => p.docCap), [100, 300, 600, 1500]);
check('a known level takes its cap', R.cleanPlan({ level: '69.90' }, 'a')?.docCap, 300);
check('a custom cap beats the level (an agreed exception)', R.cleanPlan({ level: '69.90', docCap: 450 }, 'a')?.docCap, 450);
check('an unknown level with no cap is no plan, never an unlimited one', R.cleanPlan({ level: '12.00' }, 'a'), null);
check('an unknown level with its own cap is a plan', R.cleanPlan({ level: 'special', docCap: 50 }, 'a')?.docCap, 50);
check('a cap of zero or less is no plan', R.cleanPlan({ level: 'x', docCap: 0 }, 'a'), null);
const plan = { level: '39.90', docCap: 100, since: '', setBy: '' };
check('no plan is unlimited', R.stateOf(undefined, 5000), null);
check('under 80% is ok', R.stateOf(plan, 79)?.state, 'ok');
check('80% is near', R.stateOf(plan, 80)?.state, 'near');
check('exactly the cap is at', R.stateOf(plan, 100)?.state, 'at');
check('more than the cap is over', R.stateOf(plan, 101)?.state, 'over');
check('the document that reaches the cap is still read', R.readsBlocked(R.stateOf(plan, 100)), false);
check('the one after it is not', R.readsBlocked(R.stateOf(plan, 101)), true);
check('no plan never blocks', R.readsBlocked(null), false);

// --- what counts ----------------------------------------------------------
const NOW = new Date('2026-11-15T04:00:00Z'); // 12:00 in Singapore
const mk = (over: Record<string, unknown>) =>
  insertBill({ orgId: 'org-sub', kind: 'cost', status: 'new', documentType: 'Invoice', currency: 'SGD', category: '', description: '', tax: '0', ...over } as any);
// A clock the test sets: the count asks the current time, and a test that read the
// real one would pass or fail by the month it is run in.
const RealDate = Date;
let clock = NOW.getTime();
globalThis.Date = class extends RealDate {
  constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(clock); }
  static now() { return clock; }
} as DateConstructor;
const at = (iso: string, fn: () => void) => { const was = clock; clock = RealDate.parse(iso); try { fn(); } finally { clock = was; } };

at('2026-11-02T01:00:00Z', () => { mk({ supplier: 'A' }); mk({ supplier: 'B' }); });
at('2026-11-10T01:00:00Z', () => {
  mk({ supplier: 'C', status: 'deleted' });
  mk({ supplier: 'D', status: 'merged' });
  mk({ supplier: 'E', dextId: 'dx-1' });
  mk({ supplier: 'F', emailLink: { messageId: 'm', from: 'x@y.z', links: [], status: 'awaiting_trust', note: '', at: '' } });
  mk({ supplier: 'G' });
});
at('2026-10-31T17:00:00Z', () => { mk({ supplier: 'H' }); }); // 1 Nov 01:00 in Singapore: this month
at('2026-10-30T01:00:00Z', () => { mk({ supplier: 'I' }); }); // last month
check('counts this month\'s real documents only (2 + G + the one at 1 Nov Singapore time)', documentsThisMonth('org-sub', NOW), 4);
check('another entity\'s count is its own', documentsThisMonth('org-other', NOW), 0);

// --- the gate -------------------------------------------------------------
check('an entity with no plan is not limited', capRefusal('cybm', 'org-sub'), null);
setOrganisationPlan('cybm', 'org-sub', { level: 'tiny', docCap: 4, since: '', setBy: '' });
check('at the cap, reading still goes ahead', capRefusal('cybm', 'org-sub'), null);
at('2026-11-12T01:00:00Z', () => { mk({ supplier: 'J' }); });
check('one more is over', planStateFor('cybm', 'org-sub')?.state, 'over');
check('the state names used and cap', planStateFor('cybm', 'org-sub')?.used, 5);

// a browser read route answers 402 once over
const fakeRes = () => { const r: any = { code: 0, body: null, status(c: number) { r.code = c; return r; }, json(b: unknown) { r.body = b; return r; } }; return r; };
const req = (org: string) => ({ header: (h: string) => (h.toLowerCase() === 'x-org-id' ? org : ''), headers: {} }) as any;
const res = fakeRes();
const blocked = refuseIfOverPlan(req('org-sub'), res);
check('over the plan the route answers 402 plan_cap_reached', [blocked, res.code, res.body?.error], [true, 402, 'plan_cap_reached']);
const nextMonth = fakeRes();
at('2026-12-01T01:00:00Z', () => { check('a new month reads again', refuseIfOverPlan(req('org-sub'), nextMonth), false); });

// --- who may set a plan ---------------------------------------------------
const app = express();
app.use(express.json());
app.use('/api/plan', planRouter);
const server = app.listen(0);
const port = (server.address() as any).port;
const call = (method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-org-id': 'org-sub' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json() }));

const set = await call('PUT', '/api/plan/org-sub', { level: '99.90' });
check('the practice sets a level and gets its cap back', [set.status, set.json.plan?.cap], [200, 600]);
const bad = await call('PUT', '/api/plan/org-sub', { level: 'nonsense' });
check('a plan with no usable cap is refused', [bad.status, bad.json.error], [400, 'invalid_plan']);
const missing = await call('PUT', '/api/plan/org-nope', { level: '39.90' });
check('an unknown entity is 404', missing.status, 404);
const cleared = await call('PUT', '/api/plan/org-sub', { clear: true });
check('clearing returns the entity to unlimited', [cleared.status, cleared.json.plan], [200, null]);
const read = await call('GET', '/api/plan');
check('the open entity reads its own plan (none now)', [read.status, read.json.plan], [200, null]);

server.close();
finish(failures);
