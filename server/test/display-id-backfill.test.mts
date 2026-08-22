// Numbering documents that were stored before numbers were assigned. The one
// that has been carrying a number in URLs, exports and Xero must keep it; only
// the documents that were SHARING it can be renumbered.
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'cybills-backfill-'));
process.env.BILLS_DATA_DIR = DIR;

// Three documents created in the SAME second (so they derive one number), plus
// one a second later. None carries a displayId — this is the old shape.
const MS = Date.parse('2026-08-22T06:16:56Z');
const row = (ms: number, n: number) => ({
  id: `bill_${ms.toString(36)}_aaaaaaa${n}`,
  orgId: 'cybm', fileHash: `h${n}`, fileName: 'r.jpg', supplier: `S${n}`,
  invoiceNumber: '', documentType: 'Receipt', currency: 'SGD', total: 10, tax: 0,
  date: '2026-08-22', category: '', status: 'new', kind: 'cost',
  createdBy: '', storageKey: '', contentType: '', createdAt: new Date(ms).toISOString(),
});
mkdirSync(DIR, { recursive: true });
writeFileSync(
  join(DIR, 'bills.json'),
  JSON.stringify({ bills: [row(MS, 1), row(MS, 2), row(MS, 3), row(MS + 1000, 4)] }, null, 2),
);

const { listBills, getBillById, itemIdFor } = await import('../src/store.js');

let pass = 0;
const ok = (name: string, cond: boolean) => {
  assert.ok(cond, name);
  console.log('PASS ', name);
  pass += 1;
};

const all = listBills('cybm');
const byId = (n: number) => all.find((b) => b.id.endsWith(`aaaaaaa${n}`))!;
const legacy = itemIdFor(byId(1).id);

ok('every backfilled document has a number', all.every((b) => Boolean(b.displayId)));
ok('and they are all distinct', new Set(all.map((b) => b.displayId)).size === all.length);
ok('the oldest of the colliding three keeps the plain number', byId(1).displayId === legacy);
ok('the second gets a suffixed one', byId(2).displayId === `${legacy}1`);
ok('the third too', byId(3).displayId === `${legacy}2`);
ok('a document that never collided keeps its own number', byId(4).displayId === itemIdFor(byId(4).id));

// The URL that was published for the shared number still opens a document —
// the one that kept it — rather than 404ing.
ok('the legacy number still resolves', getBillById('cybm', legacy)?.id === byId(1).id);
// And each renumbered document is reachable by its NEW number.
ok('a renumbered document answers to its new number', getBillById('cybm', `${legacy}1`)?.id === byId(2).id);
ok('internal ids still resolve', getBillById('cybm', byId(3).id)?.id === byId(3).id);

// The backfill is written back, so it happens once and the numbers are stable.
const { readFileSync } = await import('node:fs');
const saved = JSON.parse(readFileSync(join(DIR, 'bills.json'), 'utf8')).bills;
ok('the numbers were persisted', saved.every((b: any) => Boolean(b.displayId)));

console.log(`\nall passed (${pass})`);
