// A document being read SAYS it is being read, for as long as the read runs.
//
// The stuck-document sweep used to count its one-minute grace from the upload,
// which is the moment the document was accepted and has nothing to do with when
// its read will finish: fifteen receipts dropped in together are created within
// a second of each other, their reads go out in parallel, and a minute later
// every one that had not come back yet was filed into the inbox as "New —
// Needs: Category, Total" — the badge of a document the reader got NOTHING off.
// Clicking into one then offered "Re-read receipt" on a document that was being
// read at that very moment, and the fields filled in underneath the reviewer.
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-heartbeat-'));

const { insertBill, getBillById, noteReading, settleProcessing, sweepStuckProcessing } =
  await import('../src/store.js');

let pass = 0;
const ok = (name: string, cond: boolean) => {
  assert.ok(cond, name);
  console.log('PASS ', name);
  pass += 1;
};

const GRACE_MS = 60_000;
const ORG = 'cybm';

// Uploaded `agoMs` ago and still marked as being read.
const uploaded = (name: string, agoMs: number) => {
  const bill = insertBill({
    orgId: ORG, fileHash: `h-${name}`, fileName: `${name}.jpg`, supplier: '',
    invoiceNumber: '', documentType: '', currency: 'SGD', total: 0, tax: 0,
    date: '', category: '', categoryReason: '', projectReason: '', taxRate: '',
    taxRateReason: '', description: '', createdBy: '', storageKey: 'k', contentType: '',
    status: 'processing', kind: 'cost',
  } as any);
  // Reach past insertBill's own clock: the creation time is the creation time,
  // so the only way to have been uploaded a while ago is to have been.
  const stored = getBillById(ORG, bill.id)!;
  (stored as any).createdAt = new Date(Date.now() - agoMs).toISOString();
  return bill.id;
};

// --- the batch that started this -------------------------------------------
// Two receipts uploaded together, well past the grace. One is still being read
// and says so; the other's tab was closed mid-read and nothing has been heard.
const reading = uploaded('reading', GRACE_MS * 3);
const abandoned = uploaded('abandoned', GRACE_MS * 3);

ok('a heartbeat is taken while the document is being read', noteReading(ORG, reading));
sweepStuckProcessing(ORG);

ok('a read still running is left in Processing', getBillById(ORG, reading)?.status === 'processing');
ok('a read nobody is doing any more is filed into the inbox', getBillById(ORG, abandoned)?.status === 'new');

// --- the heartbeat stops when the browser does ------------------------------
// The sweep counts from the LAST beat, not from the first: a read that goes
// quiet for longer than the grace is a read that is no longer running.
const stale = getBillById(ORG, reading)!;
(stale as any).createdAt = new Date(Date.now() - GRACE_MS * 3).toISOString();
noteReading(ORG, reading);
// Wind the heartbeat itself back by winding the clock forward.
const realNow = Date.now;
Date.now = () => realNow() + GRACE_MS * 2;
sweepStuckProcessing(ORG);
Date.now = realNow;
ok('a heartbeat that stopped no longer holds the document', getBillById(ORG, reading)?.status === 'new');

// --- a heartbeat can only ever hold a document that is BEING read -----------
// Otherwise a late ping — the upload's last one, racing the finalize — would
// put a document that has already landed back into a state it has left.
ok('a document that is not processing refuses the heartbeat', noteReading(ORG, reading) === false);
ok('and a document that does not exist refuses it too', noteReading(ORG, 'bill_nope') === false);

// --- the settle forgets the beat -------------------------------------------
// The read has ended, so what it left behind must not keep the NEXT document of
// that id (or a re-read of this one) out of the sweep's hands.
const settled = uploaded('settled', GRACE_MS * 3);
noteReading(ORG, settled);
settleProcessing(ORG, settled, 'new');
ok('settling moves it out of Processing', getBillById(ORG, settled)?.status === 'new');
(getBillById(ORG, settled) as any).status = 'processing';
sweepStuckProcessing(ORG);
ok('and the forgotten beat does not hold it there', getBillById(ORG, settled)?.status === 'new');

console.log(`\n${pass} checks passed`);
