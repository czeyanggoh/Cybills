// The listing's tax-code backfill leaves a document alone while it is being
// read, and while it has no total.
//
// An HPL rental invoice printing "GST @ 9% 348.48" was uploaded, and while its
// read was in flight a listing decided its tax code from the empty document —
// total 0, tax 0, so "No tax is shown on this document … Coded No Tax". The
// upload then kept that code (it decides only where none is set) and the GST
// the read found was folded into the cost by the No Tax rule.
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-tax-backfill-'));

const { mayBackfillTaxRate } = await import('../src/taxRules.js');

let pass = 0;
const ok = (name: string, cond: boolean) => {
  assert.ok(cond, name);
  console.log('PASS ', name);
  pass += 1;
};

const doc = (o: Record<string, unknown> = {}) => ({
  kind: 'cost', status: 'new', total: 4220.48, tax: 348.48, taxRate: '', ...o,
});

ok('an undecided cost with figures is backfilled', mayBackfillTaxRate(doc()));
ok('a document still being read is not', !mayBackfillTaxRate(doc({ status: 'processing', total: 0, tax: 0 })));
ok('nor one being read that already has figures', !mayBackfillTaxRate(doc({ status: 'processing' })));
ok('nor one with no total', !mayBackfillTaxRate(doc({ total: 0, tax: 0 })));
ok('nor one whose total is blank', !mayBackfillTaxRate(doc({ total: '', tax: '' })));
ok('a credit note typed negative still is', mayBackfillTaxRate(doc({ total: -530, tax: 0 })));
ok('a code already set is left alone', !mayBackfillTaxRate(doc({ taxRate: 'No Tax' })));
ok('a blank somebody chose is left alone', !mayBackfillTaxRate(doc({ taxRateCleared: true })));
ok('a published document is left alone', !mayBackfillTaxRate(doc({ xeroInvoiceId: 'inv-1' })));
ok('a sale is left alone', !mayBackfillTaxRate(doc({ kind: 'sales' })));

console.log(`\n${pass} passed`);
