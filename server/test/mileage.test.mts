// A mileage claim is a cost with no receipt behind it: a map route, an odometer
// photo, a log line. What it carries is a DISTANCE, and the money is distance ×
// the entity's rate per km — worked out by the server, never typed. Driven over
// real HTTP against the real server with a stubbed reader, so what is asserted
// is what the reader is asked, what it is allowed to answer, and what the store
// ends up holding.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-mileage-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';
process.env.PORT = '4662';

// The entity reimburses 0.60 a kilometre (Business settings → Extraction →
// Mileage). Seeded the way the browser's blobStore saves it.
writeFileSync(
  join(DATA_DIR, 'settings.json'),
  JSON.stringify({ items: [{ workspaceId: 'cybm', key: 'cybills.extraction-settings.v1', value: { mileageRate: '0.60' } }] })
);

// --- stub reader -------------------------------------------------------------
let answer: Record<string, unknown> = {};
let schemas: any[] = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    schemas.push(parsed.text?.format?.schema ?? parsed.text?.format ?? null);
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
        usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 } },
      })
    );
  });
});
await new Promise<void>((r) => stub.listen(4661, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4661';

const { insertBill, getBillById } = await import('../src/store.ts');
const { dataScopeForOrg } = await import('../src/organisations.ts');
// The real server, routes and all.
await import('../src/index.ts');
await new Promise((r) => setTimeout(r, 200));

const BASE = 'http://127.0.0.1:4662';
const scope = dataScopeForOrg('');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const baseAnswer = {
  supplier: '', date: '2026-08-26', documentType: 'Mileage', distanceKm: 13, invoiceNumber: '', currency: 'SGD',
  total: 0, tax: 0, category: 'Uncategorised', categoryReason: 'A journey, not a purchase.',
  description: 'Drive: Work (ST Engineering Jurong East) → MacRitchie Reservoir Park, 13 km',
  dueDate: '', period: '', cardLast4: '', baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0,
  supplierGstRegNo: '', taxLabel: '', billedTo: '', billedToRegNo: '', lineItems: [],
};

const read = async (ans: Record<string, unknown>) => {
  answer = ans;
  const res = await fetch(`${BASE}/api/costs/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: PNG, mediaType: 'image/png', accounts: [{ code: '429', name: 'General Expenses', description: 'Anything else' }] }),
  });
  return ((await res.json()) as any)?.data ?? null;
};

// --- what the reader is asked, and allowed to answer ------------------------
let d = await read(baseAnswer);
const schema = schemas[0];
const props = schema?.properties ?? schema?.schema?.properties ?? {};
check('the reader is offered "Mileage" as a document type', props.documentType?.enum, ['Receipt', 'Invoice', 'Mileage', 'Other']);
check('and asked for the distance in km', props.distanceKm?.type, 'number');
check('a map route reads as a mileage document', d?.documentType, 'Mileage');
check('carrying its distance', d?.distanceKm, 13);
check('and no supplier — nobody was paid', d?.supplier, '');
check('and no amount: that is worked out from the distance', d?.total, 0);

d = await read({ ...baseAnswer, documentType: 'Receipt', supplier: 'Grab', total: 13, distanceKm: 13 });
check('a distance on a RECEIPT is discarded — a fact about a journey belongs to one', d?.distanceKm, 0);

// --- the upload road: finalize prices it at the entity's rate ----------------
const processing = insertBill({
  orgId: scope, kind: 'cost', status: 'processing', supplier: '', invoiceNumber: '', documentType: 'Receipt',
  currency: 'SGD', date: '', category: '', total: 0, tax: 0, fileHash: 'h1', fileName: 'route.png',
  categoryReason: '', projectReason: '', taxRate: '', taxRateReason: '', description: '', createdBy: '',
  storageKey: '', contentType: '',
} as any);
let res = await fetch(`${BASE}/api/costs/bills/${processing.id}/finalize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...baseAnswer, checkDuplicates: false }),
});
let body = (await res.json()) as any;
check('finalize keeps the distance', body.bill?.distanceKm, 13);
check('fills in the entity’s rate, so the document keeps the rate it was priced at', body.bill?.mileageRate, 0.6);
check('and works out the total: 13 km × 0.60', body.bill?.total, 7.8);
check('with no tax — there is no tax invoice behind a journey', body.bill?.tax, 0);
check('a map route with no supplier and no amount is NOT "nothing read": it lands in the inbox, not set aside', body.bill?.status, 'new');

// --- the page: a rate changed on the document reprices it --------------------
const patch = async (id: string, fields: Record<string, unknown>) => {
  const r = await fetch(`${BASE}/api/costs/bills/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  return ((await r.json()) as any)?.bill;
};
let b = await patch(processing.id, { mileageRate: '0.80' });
check('a rate typed on the document beats the default', b?.mileageRate, 0.8);
check('and the total follows: 13 km × 0.80', b?.total, 10.4);

b = await patch(processing.id, { distanceKm: '20' });
check('a corrected distance follows too: 20 km × 0.80', b?.total, 16);

b = await patch(processing.id, { distanceKm: '' });
check('clearing the distance takes the total with it — no figure nobody can account for', b?.total, 0);

// A total typed straight onto a mileage document is overruled by its own figures.
b = await patch(processing.id, { distanceKm: '10', total: '99' });
check('a typed total on a mileage document gives way to distance × rate', b?.total, 8);

// A document with no rate anywhere waits: nothing is invented.
writeFileSync(join(DATA_DIR, 'settings.json'), JSON.stringify({ items: [] }));
const { saveCollection } = await import('../src/jsonStore.ts');
saveCollection('settings', []);
const bare = insertBill({
  orgId: scope, kind: 'cost', status: 'new', supplier: 'Cze Yang Goh', invoiceNumber: '', documentType: 'Receipt',
  currency: 'SGD', date: '2026-08-26', category: '429 - General Expenses', total: 22.2, tax: 0, fileHash: 'h2', fileName: 'r.png',
  categoryReason: '', projectReason: '', taxRate: '', taxRateReason: '', description: '', createdBy: '',
  storageKey: '', contentType: '',
} as any);
b = await patch(bare.id, { documentType: 'Mileage' });
check('becoming a mileage document with no distance leaves the total alone', b?.total, 22.2);
b = await patch(bare.id, { distanceKm: '13' });
check('a distance with no rate anywhere prices to nothing rather than to a guess', b?.total, 0);
check('and stores no rate', getBillById(scope, bare.id)?.mileageRate ?? null, null);
b = await patch(bare.id, { documentType: 'Receipt', total: '22.20' });
check('back to a receipt, the total is typed again', b?.total, 22.2);

// --- an ordinary edit costs nothing here -------------------------------------
b = await patch(bare.id, { supplier: 'Grab' });
check('an ordinary edit leaves the money alone', b?.total, 22.2);

stub.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll mileage tests passed.');
process.exit(0);
