// Import GST on the server: a document put on the GST account takes "GST on
// Imports" on every write, loses it when moved off, and publishes under that
// code or not at all.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

process.env.BILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-importgst-'));

const { keepPracticeNoTax } = await import('../src/practiceNoTax.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const base = { kind: 'cost', status: 'new', supplier: 'Gowell Logistics', total: 2297.85, tax: 0 } as any;

{
  const patch: Record<string, unknown> = { category: '820 - GST' };
  await keepPracticeNoTax({ ...base, category: '425 - Freight Inwards Charges', taxRate: 'No Tax', taxRateEdited: true }, patch);
  check('moved onto the GST account: the import code, over a hand pick', [patch.taxRate, patch.tax], ['GST on Imports', 0]);
}
{
  const patch: Record<string, unknown> = { category: '425 - Freight Inwards Charges' };
  await keepPracticeNoTax({ ...base, category: '820 - GST', taxRate: 'GST on Imports' }, patch);
  check('moved off it: the import code goes too', patch.taxRate, '');
}
{
  const patch: Record<string, unknown> = {};
  const changed = await keepPracticeNoTax({ ...base, category: '820 - GST', taxRate: 'No Tax', xeroInvoiceId: 'x' }, patch);
  check('a published document is left alone by the sweep', [changed, patch], [false, {}]);
}
{
  const patch: Record<string, unknown> = { category: '820 - GST' };
  await keepPracticeNoTax({ ...base, category: '425 - Freight', taxRate: 'No Tax', xeroInvoiceId: 'x' }, patch);
  check('but coded by a person, ready for Update in Xero', patch.taxRate, 'GST on Imports');
}
{
  const patch: Record<string, unknown> = {
    lineItems: [
      { category: '425 - Freight Inwards Charges', total: 95, tax: 0, taxRate: '' },
      { category: '820 - GST', total: 100, tax: 0, taxRate: '' },
    ],
  };
  await keepPracticeNoTax({ ...base, category: '425 - Freight Inwards Charges', taxRate: 'Standard-Rated Purchases' }, patch);
  check(
    'a mixed bill: only the GST row, and the document keeps its code',
    [(patch.lineItems as any[]).map((r) => r.taxRate), patch.taxRate],
    [['', 'GST on Imports'], undefined]
  );
}

finish(failures);
