// WHICH country's GST rules a client entity's book is read under, server-side.
//
// The browser half is pure and tested at the repo root (test/gst-jurisdiction).
// What only the server can get wrong is the CONTEXT: resolving the country for
// an entity a background read has no browser to ask, and carrying it into the
// three places that decide money — the tax code, the reader's own prompt, and
// the motor-vehicle rule that must not leave Singapore.
//
// Driven through `autoRead`, the road an emailed or WhatsApp'd document takes,
// against a stubbed reader whose request is CAPTURED — so what is asserted
// about the prompt is the prompt that actually goes out, not one assembled
// again by the test.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-jurisdiction-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_EXTRACT_MODEL = 'gpt-4o-stub';
process.env.LLM_PROVIDER = 'openai';
process.env.ANTHROPIC_API_KEY = '';

// Two entities, neither linked to Xero — so the country has to come off each
// one's own Business profile, which is the case that matters: an entity with no
// tenant cannot be asked, and a bridge entity never has one at all.
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_au0001', orgId: 'cybm', name: 'Bondi Trading Pty Ltd', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org_sg0001', orgId: 'cybm', name: 'EXCELLENCE A.S PTE. LTD.', tenantId: '', tenantName: '', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

let answer: Record<string, unknown> = {};
let lastRequest = '';
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    lastRequest = body;
    const out = JSON.stringify(answer);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-4o-stub', output_text: out,
        output: [{ type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: out, annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      })
    );
  });
});
await new Promise<void>((r) => stub.listen(4649, '127.0.0.1', r));
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4649';

const { autoRead } = await import('../src/inbound.ts');
const { insertBill, getBillById, updateBill } = await import('../src/store.ts');
const { countryForOrg, packForOrg } = await import('../src/jurisdiction.ts');
const { keepMotorVehicleNoTax, enforceMotorVehicleNoTax } = await import('../src/motorVehicle.ts');
const { saveCollection } = await import('../src/jsonStore.ts');
const { WORKSPACE_ID } = await import('../src/workspace.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const has = (name: string, text: string, needle: string) => {
  const ok = String(text || '').includes(needle);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL does not contain ${JSON.stringify(needle)}`}  ${name}`);
};
const hasNot = (name: string, text: string, needle: string) => {
  const ok = !String(text || '').includes(needle);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL contains ${JSON.stringify(needle)}`}  ${name}`);
};

// Each entity's own profile, and its own chart of tax codes. The codes are the
// ones Xero actually ships for an organisation in each country — an Australian
// chart has no "No Tax" at all, which is why the zero code cannot be a constant.
const AU_RATES = [
  { name: 'GST on Expenses', code: 'INPUT', rate: 10 },
  { name: 'GST Free Expenses', code: 'EXEMPTEXPENSES', rate: 0 },
  { name: 'BAS Excluded', code: 'BASEXCLUDED', rate: 0 },
  { name: 'Input Taxed', code: 'INPUTTAXED', rate: 0 },
];
const SG_RATES = [
  { name: 'Standard-Rated Purchases', code: 'INPUTY24', rate: 9 },
  { name: 'No Tax', code: 'NONE', rate: 0 },
];
saveCollection('settings', [
  { workspaceId: WORKSPACE_ID, key: 'cybills.business-profile.v1::org_au0001', value: { country: 'Australia', gstRegistered: 'Yes' } },
  { workspaceId: WORKSPACE_ID, key: 'cybills.business-profile.v1::org_sg0001', value: { country: 'Singapore', gstRegistered: 'Yes' } },
  { workspaceId: WORKSPACE_ID, key: 'cybills.lists.v1::org_au0001', value: { added: { taxRates: AU_RATES } } },
  { workspaceId: WORKSPACE_ID, key: 'cybills.lists.v1::org_sg0001', value: { added: { taxRates: SG_RATES } } },
]);

// --- 1) Resolving the country ------------------------------------------------
check('the profile decides', await countryForOrg(WORKSPACE_ID, 'org_au0001'), 'Australia');
check('…per entity, in the same workspace', await countryForOrg(WORKSPACE_ID, 'org_sg0001'), 'Singapore');
// The safety of the whole change: an entity nobody has answered for behaves
// exactly as every book did before there were two jurisdictions.
check('an entity with no profile at all is Singapore', await countryForOrg(WORKSPACE_ID, 'org_none0001'), 'Singapore');
check('the pack comes back with it', (await packForOrg(WORKSPACE_ID, 'org_au0001'))?.key, 'AU');
check('…and Singapore blocks motor vehicle input tax where Australia does not', [
  (await packForOrg(WORKSPACE_ID, 'org_sg0001'))?.blocksMotorVehicle,
  (await packForOrg(WORKSPACE_ID, 'org_au0001'))?.blocksMotorVehicle,
], [true, false]);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const req = { headers: {} } as never;
let n = 0;
const blank = (scope: string) => {
  n += 1;
  return insertBill({
    orgId: scope, fileHash: `hash-${n}`, fileName: `r-${n}.png`, supplier: '', invoiceNumber: '',
    documentType: 'Receipt', currency: '', total: 0, tax: 0, date: '', category: '', createdBy: 'dean@acme.com',
    owner: 'dean@acme.com', status: 'processing', kind: 'cost',
  } as never);
};
const FIELDS = {
  supplier: '', date: '2026-09-01', documentType: 'Receipt', invoiceNumber: 'INV-1', currency: 'AUD',
  total: 110, tax: 10, category: 'Uncategorised', categoryReason: '', noteFollowed: '', description: 'Supplies', dueDate: '',
  period: '', cardLast4: '', supplierGstRegNo: '', taxLabel: 'GST 10%', taxRatePrinted: 10, motorVehicle: false,
  billedTo: '', billedToRegNo: '', customer: '', rebillable: false, taxRate: '', taxRateReason: '', project: '', projectReason: '',
  baseCurrency: '', baseTotal: 0, baseTax: 0, exchangeRate: 0, lineItems: [],
};

// --- 2) The reader is told what to look for ----------------------------------
// A reader hunting for a UEN on an Australian invoice and a gate refusing the
// ABN it was never asked to read is the same bug seen from both ends, so the
// prompt is assembled from the same pack the decision asks.
answer = { ...FIELDS, supplier: 'Bunnings', supplierGstRegNo: '51 824 753 556' };
const auRead = blank('au-scope');
await autoRead(req, 'au-scope', 'org_au0001', 'openai', auRead.id, PNG, 'image/png');
has('the Australian prompt asks for an ABN', lastRequest, 'Australian Business Number');
has('…and warns off the ACN', lastRequest, 'ACN');
// Not "never says UEN": the currency field names both, because telling a "$"
// beside an ABN from one beside a UEN is how a symbol is resolved to AUD or
// SGD, and that is true in either book. What must not travel is the
// REGISTRATION the read is sent looking for.
hasNot('…and never sends it looking for a UEN', lastRequest, 'Singapore UEN or GST registration number');

answer = { ...FIELDS, supplier: 'Sheng Siong', currency: 'SGD', total: 109, tax: 9, taxLabel: 'GST 9%', taxRatePrinted: 9, supplierGstRegNo: '201614382R' };
const sgRead = blank('sg-scope');
await autoRead(req, 'sg-scope', 'org_sg0001', 'openai', sgRead.id, PNG, 'image/png');
has('the Singapore prompt still asks for a UEN', lastRequest, 'UEN');
hasNot('…and says nothing about an ABN', lastRequest, 'Australian Business Number');

// --- 3) The code each book gets ----------------------------------------------
const au = getBillById('au-scope', auRead.id)!;
check('an ABN invoice at 10% is claimed', au.taxRate, 'GST on Expenses');
check('…with its GST recorded', [au.total, au.tax], [110, 10]);
const sg = getBillById('sg-scope', sgRead.id)!;
check('and a UEN invoice at 9% is claimed in Singapore', sg.taxRate, 'Standard-Rated Purchases');
check('…with its GST recorded', [sg.total, sg.tax], [109, 9]);

// The evidence is the entity's own. A UEN proves nothing in an Australian book,
// and an Australian chart's way of saying "nothing claimed" is GST Free
// Expenses — "No Tax" is not in it.
answer = { ...FIELDS, supplier: 'Sheng Siong', supplierGstRegNo: '201614382R' };
const crossed = blank('au-scope');
await autoRead(req, 'au-scope', 'org_au0001', 'openai', crossed.id, PNG, 'image/png');
const cross = getBillById('au-scope', crossed.id)!;
check('a UEN is no evidence in an Australian book', cross.taxRate, 'GST Free Expenses');
check('…and the tax stays inside the cost', [cross.total, cross.tax], [110, 0]);
has('…for a reason that names the ABN it wanted', String(cross.taxRateReason), 'ABN');
hasNot('…and never mentions Singapore', String(cross.taxRateReason), 'Singapore');

// --- 4) The motor vehicle rule does not leave Singapore ----------------------
// The one that costs real money if it travels: an Australian business claims
// the GST on fuel, parking and running costs like any other expense.
answer = { ...FIELDS, supplier: 'Ampol', supplierGstRegNo: '51 824 753 556', motorVehicle: true, description: 'Fuel' };
const auFuel = blank('au-scope');
await autoRead(req, 'au-scope', 'org_au0001', 'openai', auFuel.id, PNG, 'image/png');
const fuel = getBillById('au-scope', auFuel.id)!;
check('an Australian petrol receipt keeps its credit', fuel.taxRate, 'GST on Expenses');
check('…and its GST', [fuel.total, fuel.tax], [110, 10]);

answer = { ...FIELDS, supplier: 'SPC', currency: 'SGD', total: 109, tax: 9, taxLabel: 'GST 9%', taxRatePrinted: 9,
  supplierGstRegNo: '201614382R', motorVehicle: true, description: 'Petrol' };
const sgFuel = blank('sg-scope');
await autoRead(req, 'sg-scope', 'org_sg0001', 'openai', sgFuel.id, PNG, 'image/png');
const petrol = getBillById('sg-scope', sgFuel.id)!;
check('a Singapore petrol receipt is still No Tax', petrol.taxRate, 'No Tax');
check('…with the GST left in the cost', [petrol.total, petrol.tax], [109, 0]);

// The write path and the stored-book sweep ask the same question, or an
// Australian book would have its fuel credits stripped on every listing.
const auMoved = insertBill({ orgId: 'au-scope', fileHash: 'hash-moved-au', fileName: 'm.png', supplier: 'Ampol',
  documentType: 'Receipt', currency: 'AUD', total: 110, tax: 10, date: '2026-09-01', category: '429 - General Expenses',
  taxRate: 'GST on Expenses', createdBy: 'dean@acme.com', owner: 'dean@acme.com', status: 'new', kind: 'cost' } as never);
const auPatch: Record<string, unknown> = { category: '449 - Motor Vehicle Expenses' };
check('moving an Australian document onto a motor account changes nothing',
  await keepMotorVehicleNoTax(auMoved, auPatch, { ws: WORKSPACE_ID, orgId: 'org_au0001' }), false);
check('…so its GST is untouched', auPatch, { category: '449 - Motor Vehicle Expenses' });

const sgMoved = insertBill({ orgId: 'sg-scope', fileHash: 'hash-moved-sg', fileName: 'm.png', supplier: 'SPC',
  documentType: 'Receipt', currency: 'SGD', total: 109, tax: 9, date: '2026-09-01', category: '429 - General Expenses',
  taxRate: 'Standard-Rated Purchases', createdBy: 'dean@acme.com', owner: 'dean@acme.com', status: 'new', kind: 'cost' } as never);
const sgPatch: Record<string, unknown> = { category: '449 - Motor Vehicle Expenses' };
check('and the same move in a Singapore book still gives the GST up',
  await keepMotorVehicleNoTax(sgMoved, sgPatch, { ws: WORKSPACE_ID, orgId: 'org_sg0001' }), true);
check('…to No Tax, with the total unmoved', [sgPatch.taxRate, sgPatch.tax], ['No Tax', 0]);

const auStored = insertBill({ orgId: 'au-scope', fileHash: 'hash-stored-au', fileName: 's.png', supplier: 'Ampol',
  documentType: 'Receipt', currency: 'AUD', total: 110, tax: 10, date: '2026-09-01', category: '449 - Motor Vehicle Expenses',
  taxRate: 'GST on Expenses', createdBy: 'dean@acme.com', owner: 'dean@acme.com', status: 'new', kind: 'cost' } as never);
updateBill('au-scope', auMoved.id, {}); // bump the book so the sweep runs
await enforceMotorVehicleNoTax('au-scope', { ws: WORKSPACE_ID, orgId: 'org_au0001' });
check('the sweep leaves an Australian book alone',
  [getBillById('au-scope', auStored.id)!.taxRate, getBillById('au-scope', auStored.id)!.tax], ['GST on Expenses', 10]);

const sgStored = insertBill({ orgId: 'sg-scope', fileHash: 'hash-stored-sg', fileName: 's.png', supplier: 'SPC',
  documentType: 'Receipt', currency: 'SGD', total: 109, tax: 9, date: '2026-09-01', category: '449 - Motor Vehicle Expenses',
  taxRate: 'Standard-Rated Purchases', createdBy: 'dean@acme.com', owner: 'dean@acme.com', status: 'new', kind: 'cost' } as never);
updateBill('sg-scope', sgMoved.id, {});
await enforceMotorVehicleNoTax('sg-scope', { ws: WORKSPACE_ID, orgId: 'org_sg0001' });
check('…and still puts a stored Singapore petrol receipt right',
  [getBillById('sg-scope', sgStored.id)!.taxRate, getBillById('sg-scope', sgStored.id)!.tax], ['No Tax', 0]);

await finish(failures, stub);
