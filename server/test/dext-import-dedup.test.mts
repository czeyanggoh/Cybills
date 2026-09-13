// A Dext import names the document it came from, and a second import of the
// same Item ID is refused — even with `force`, which the import sends to get
// past resemblance checks on purpose. Driven over real HTTP against the real
// server, so what is asserted is the route the import screen actually calls.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-dext-dedup-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.PORT = '4682';

const { insertBill, listBills } = await import('../src/store.ts');
const { dataScopeForOrg } = await import('../src/organisations.ts');
await import('../src/index.ts');
await new Promise((r) => setTimeout(r, 200));

const BASE = 'http://127.0.0.1:4682';
const scope = dataScopeForOrg('');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const post = async (body: Record<string, unknown>) => {
  const res = await fetch(`${BASE}/api/costs/bills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const row = { kind: 'cost', documentType: 'Receipt', supplier: 'Grab', date: '2026-08-20', total: '39.20', force: true };

const first = await post({ ...row, dextId: '21616969450' });
check('the first import of an Item ID is filed', first.status, 200);
check('and carries the id', first.body.bill?.dextId, '21616969450');

const again = await post({ ...row, dextId: '21616969450' });
check('the same Item ID again is refused, force or not', [again.status, again.body.error], [409, 'already_imported']);

const other = await post({ ...row, dextId: '21616981690' });
check('a different Item ID with the same figures is still filed', other.status, 200);

const plain = await post({ ...row });
check('a document with no Item ID is untouched by the rule', plain.status, 200);

// Imported before the id was stored: the file was named by it.
insertBill({ ...(listBills(scope)[0] as any), orgId: scope, dextId: undefined, fileName: '30000000001', fileHash: '' });
const legacy = await post({ ...row, dextId: '30000000001' });
check('an earlier import known only by its file name holds its id', legacy.status, 409);

// Removing a document must not make it impossible to bring back.
insertBill({ ...(listBills(scope)[0] as any), orgId: scope, dextId: '40000000002', fileName: '', fileHash: '', status: 'deleted' });
const back = await post({ ...row, dextId: '40000000002' });
check('a deleted document does not hold its id', back.status, 200);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures);
