// Line items survive a merge.
//
// Merging re-reads the combined PDF and creates a NEW document, and the create
// path used to ignore line items entirely — so a supplier opted into "Extract
// line items" produced rows on upload and lost every one of them the moment two
// pages were merged. The rule looked broken; it was the merge that dropped them.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-mergeli-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'Demo Co', tenantId: 't-1', tenantName: 'Demo', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const express = (await import('express')).default;
const { billsRouter } = await import('../src/bills.ts');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/costs', billsRouter);
const server = app.listen(4618, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const create = async (body: unknown) => {
  const res = await fetch('http://127.0.0.1:4618/api/costs/bills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()).bill;
};

const rows = [
  { description: 'Fare', net: '10.60', tax: '0', total: '10.60', category: 'Transport - Taxi', project: 'Site A' },
  { description: 'Platform & partner fee', net: '1.20', tax: '0', total: '1.20' },
  { description: 'Fuel Surcharge', net: '0.90', tax: '0', total: '0.90' },
];

const merged = await create({
  kind: 'cost', fileHash: 'merge_x', fileName: 'merged.pdf', supplier: 'Grab',
  documentType: 'Receipt', currency: 'SGD', total: '12.70', tax: '0', date: '2026-08-26',
  lineItems: rows, mergedFrom: ['a', 'b'], force: true,
});

check('a created document keeps its line items', merged.lineItems?.length, 3);
check('…with their descriptions', merged.lineItems.map((l: any) => l.description), ['Fare', 'Platform & partner fee', 'Fuel Surcharge']);
check('…adding up to the document', merged.lineItems.reduce((t: number, l: any) => t + Number(l.total), 0).toFixed(2), '12.70');
check('…keeping a line project', merged.lineItems[0].project, 'Site A');
check('…and every cell a string', merged.lineItems.every((l: any) => typeof l.net === 'string' && typeof l.tax === 'string'), true);

// Nothing sent, nothing stored — a document without a breakdown is normal.
const plain = await create({
  kind: 'cost', fileHash: 'plain_x', fileName: 'p.pdf', supplier: 'Koufu',
  documentType: 'Receipt', currency: 'SGD', total: '5', tax: '0', force: true,
});
check('a document with no rows has none', plain.lineItems ?? null, null);

server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
