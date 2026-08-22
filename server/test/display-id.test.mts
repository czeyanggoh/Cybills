// The document number must be unique — it addresses the detail page, prints on
// exports and the claim PDF, and rides into the Xero bill's description.
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-ids-'));

const { nextDisplayId, itemIdFor, insertBill, listBills } = await import('../src/store.js');

let pass = 0;
const ok = (name: string, cond: boolean) => {
  assert.ok(cond, name);
  console.log('PASS ', name);
  pass += 1;
};

// --- the allocator ---------------------------------------------------------
const MS = Date.parse('2026-08-22T06:16:56Z'); // 14:16:56 in Singapore
const base = itemIdFor(`bill_${MS.toString(36)}_`);
ok('a free second gives the plain stamp', nextDisplayId(new Set(), MS) === base);
ok('the plain stamp is twelve digits', /^\d{12}$/.test(base));

const taken = new Set([base]);
const second = nextDisplayId(taken, MS);
ok('a taken stamp gives a suffixed number', second === `${base}1`);
taken.add(second);
ok('and the next one after that', nextDisplayId(taken, MS) === `${base}2`);

// Twenty documents in ONE second all get their own number.
const many = new Set<string>();
for (let i = 0; i < 20; i += 1) many.add(nextDisplayId(many, MS));
ok('twenty in one second are twenty distinct numbers', many.size === 20);
ok('the first of them keeps the plain stamp', many.has(base));

// A suffixed number can never be mistaken for another second's plain stamp:
// stamps are always twelve digits, suffixed ones are thirteen or more.
const nextSecond = itemIdFor(`bill_${(MS + 1000).toString(36)}_`);
ok('a suffixed number is longer than any plain stamp', `${base}1`.length > nextSecond.length);
ok('and is not equal to it', `${base}1` !== nextSecond);

// --- through the store -----------------------------------------------------
const make = (supplier: string) =>
  insertBill({
    orgId: 'cybm', fileHash: `h-${supplier}`, fileName: 'r.jpg', supplier,
    invoiceNumber: '', documentType: 'Receipt', currency: 'SGD', total: 10, tax: 0,
    date: '2026-08-22', category: '', categoryReason: '', projectReason: '', taxRate: '',
    taxRateReason: '', description: '', createdBy: '', storageKey: '', contentType: '',
    status: 'new', kind: 'cost',
  } as any);

// A tight batch: exactly the case that used to produce one number for many docs.
const batch = Array.from({ length: 25 }, (_, i) => make(`Supplier ${i}`));
const numbers = batch.map((b) => b.displayId);
ok('every inserted bill has a number', numbers.every(Boolean));
ok('a batch of 25 has 25 distinct numbers', new Set(numbers).size === 25);
ok('every id is still purely numeric', numbers.every((n) => /^\d+$/.test(n)));

// The creation time is the creation time — it is no longer bent to buy
// uniqueness, so the list's own sort field stays truthful.
const stamps = batch.map((b) => Date.parse(b.createdAt));
const span = Math.max(...stamps) - Math.min(...stamps);
ok('25 inserts span under a second of real time', span < 1000);
ok('no bill claims a creation time in the future', stamps.every((t) => t <= Date.now()));

// And the whole book agrees.
const all = listBills('cybm');
ok('every stored bill has a distinct number', new Set(all.map((b) => b.displayId)).size === all.length);

console.log(`\nall passed (${pass})`);
