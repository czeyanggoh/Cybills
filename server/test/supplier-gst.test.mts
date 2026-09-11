// A supplier's GST registration number is remembered.
//
// Input tax is claimed only on the supplier's Singapore GST number, read off
// the paper — and the reader misses it in small print ("GST No: M8-8001588-5"
// under a hardware shop's address), which codes the document No Tax and folds
// money the client can claim back into the cost. A registration number is a
// fact about the SUPPLIER, so once one document from them has been read with
// it, a later read that missed it is given it. Driven through the background
// read an emailed or WhatsApp'd document gets, with a stubbed reader, so what
// is asserted is what gets stored.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-supgst-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CY Business Management', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

let answer: Record<string, unknown> = {};
const stub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const out = JSON.stringify(answer);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        model: 'gpt-4o-stub',
        output_text: out,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      })
    );
  });
});
await new Promise<void>((r) => stub.listen(4631, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4631';

const { autoRead } = await import('../src/inbound.ts');
const { insertBill, getBillById, updateBill } = await import('../src/store.ts');
const { rememberedGstRegNo } = await import('../src/supplierGst.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {} } as never;

let n = 0;
const arrive = async () => {
  n += 1;
  const bill = insertBill({
    orgId: 'cybm', fileHash: `hash-${n}`, fileName: `r-${n}.png`, supplier: '', invoiceNumber: '', documentType: '',
    currency: '', total: 0, tax: 0, date: '', category: '', createdBy: 'dean@acme.sg', owner: 'dean@acme.sg',
    status: 'processing', kind: 'cost',
  } as never);
  await autoRead(req, 'cybm', 'org_one0001', 'openai', bill.id, PNG, 'image/png');
  return getBillById('cybm', bill.id)!;
};

const FIELDS = {
  supplier: '', date: '2026-08-11', documentType: 'Receipt', invoiceNumber: '', currency: 'SGD', total: 74.67, tax: 6.17,
  category: 'Uncategorised', categoryReason: '', noteFollowed: '', description: '', dueDate: '',
  period: '', cardLast4: '', supplierGstRegNo: '', taxLabel: 'GST %', billedTo: '', billedToRegNo: '',
  customer: '', rebillable: false, taxRate: '', taxRateReason: '', project: '', projectReason: '',
  baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0, lineItems: [],
};

// --- 1) Read with the number: claimed, and the evidence is KEPT --------------
answer = { ...FIELDS, supplier: 'Eng Guan & Co', invoiceNumber: '148001', supplierGstRegNo: 'M8-8001588-5' };
const first = await arrive();
check('a read with the supplier GST number claims the GST', first.tax, 6.17);
check('…and the number is stored on the document', first.supplierGstRegNo, 'M8-8001588-5');
check('…as READ, not remembered', Boolean(first.supplierGstRegNoRemembered), false);
check('…with the tax wording beside it', first.taxLabel, 'GST %');

// --- 2) The same supplier, number missed: remembered, and said so -------------
answer = { ...FIELDS, supplier: 'ENG GUAN & CO.', invoiceNumber: '148466' };
const second = await arrive();
check('a read that missed the number is given the supplier\'s', second.supplierGstRegNo, 'M8-8001588-5');
check('…marked as remembered', second.supplierGstRegNoRemembered, true);
check('…so the GST is claimed rather than folded into the cost', second.tax, 6.17);
check('…under a real code', Boolean(second.taxRate) && !/no tax/i.test(String(second.taxRate)), true);
check('…and the reason says the number was remembered, not read',
  /wasn't read off this document/.test(String(second.taxRateReason)), true);

// --- 3) A supplier nobody has seen a number for: declined, as before ---------
answer = { ...FIELDS, supplier: 'Fu Family Budget Store', invoiceNumber: '9' };
const stranger = await arrive();
check('a supplier never read with a number is still declined', stranger.tax, 0);
check('…with nothing remembered', Boolean(stranger.supplierGstRegNoRemembered), false);

// --- 4) A foreign number on the paper is never papered over ------------------
answer = { ...FIELDS, supplier: 'Eng Guan & Co', invoiceNumber: '148999', supplierGstRegNo: 'W10-1808-32000123' };
const foreign = await arrive();
check('a number read off the paper wins, even one that is not Singapore\'s', foreign.supplierGstRegNo, 'W10-1808-32000123');
check('…and so the tax is declined', foreign.tax, 0);

// --- 5) Only a READ number is a source --------------------------------------
// Take the one read document away: the remembered copy must not stand in for
// it, or a number could travel on for ever from a single misread.
updateBill('cybm', first.id, { status: 'deleted' });
check('a remembered number is never itself a source', await rememberedGstRegNo('Eng Guan & Co'), '');

// --- 6) Near names remember nothing ------------------------------------------
updateBill('cybm', first.id, { status: 'new' });
check('the name matches through case, punctuation and "& Co."', await rememberedGstRegNo('ENG GUAN AND CO.'), 'M8-8001588-5');
check('…but not a different company', await rememberedGstRegNo('Eng Guan Hardware'), '');

// --- 7) Two numbers read equally often is a disagreement, not an answer ------
answer = { ...FIELDS, supplier: 'Eng Guan & Co', invoiceNumber: '150000', supplierGstRegNo: '200512345K' };
await arrive();
check('an even split between two numbers remembers neither', await rememberedGstRegNo('Eng Guan & Co'), '');

await finish(failures, stub);
