// The files, and the records, kept somewhere other than this one VPS.
//
// For weeks every upload fell back to local disk because the bucket refused
// CYBills' key, and nothing on screen said so. This drives the three halves of
// the repair against a stub S3 standing in for R2: what a refusing bucket looks
// like on the practice's storage status, the move of the local files into the
// bucket (checked there before any record is pointed at it, local copy kept),
// and the daily backup of the record files with its retention.
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- A stub S3: path-style PUT / GET / HEAD / DELETE / ListObjectsV2 ----------
const objects = new Map<string, Buffer>();
let refuse = false;
const srv = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://x');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    if (refuse || bucket !== 'bk') {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      return res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
    }
    if (req.method === 'PUT') {
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { ETag: '"x"' });
      return res.end();
    }
    if (req.method === 'HEAD' || req.method === 'GET') {
      if (!key && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(
          `<?xml version="1.0"?><ListBucketResult><Name>bk</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>` +
            keys.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)!.length}</Size></Contents>`).join('') +
            '</ListBucketResult>'
        );
      }
      const body = objects.get(key);
      if (!body) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        return res.end(req.method === 'HEAD' ? undefined : '<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>');
      }
      res.writeHead(200, { 'Content-Length': String(body.length), 'Content-Type': 'application/octet-stream', ETag: '"x"' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(400);
    res.end();
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const port = (srv.address() as { port: number }).port;

// --- A data directory with files on local disk -------------------------------
const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-storage-care-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.R2_ACCOUNT_ID = 'acct';
process.env.R2_ACCESS_KEY_ID = 'a';
process.env.R2_SECRET_ACCESS_KEY = 'b';
process.env.R2_BUCKET = 'bk';
process.env.R2_ENDPOINT = `http://127.0.0.1:${port}`;
mkdirSync(join(DATA_DIR, 'files'));
const receipt = Buffer.from('%PDF-1.4 a receipt');
const photo = Buffer.from('a photo of a receipt');
const body = Buffer.from('<p>the mail</p>');
writeFileSync(join(DATA_DIR, 'files', 'org_a_h1.pdf'), receipt);
writeFileSync(join(DATA_DIR, 'files', 'org_a_claim_c1_h2.jpg'), photo);
writeFileSync(join(DATA_DIR, 'files', 'org_a_h3'), body);
const now = new Date().toISOString();
const bill = (id: string, storageKey: string) => ({
  id, orgId: 'org_a', kind: 'cost', status: 'new', createdAt: now, storageKey, contentType: 'application/pdf',
});
writeFileSync(
  join(DATA_DIR, 'bills.json'),
  JSON.stringify({
    bills: [
      bill('bill_1', 'local:org_a_h1.pdf'),
      bill('bill_2', 'local:org_a_h1.pdf'), // the same upload twice shares one file
      bill('bill_3', 'local:org_a_gone.pdf'), // a record whose file is not on disk
      bill('bill_4', 'r2:bills/org_a/h9.pdf'), // already in the bucket
    ],
  })
);
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({ items: [{ id: 'c1', orgId: 'org_a', attachments: [{ id: 'att1', storageKey: 'local:org_a_claim_c1_h2.jpg', contentType: 'image/jpeg' }] }] })
);
writeFileSync(join(DATA_DIR, 'email-thread.json'), JSON.stringify({ items: [{ id: 'mail_1', bodyKey: 'local:org_a_h3' }] }));

const { storageStatus, moveLocalFilesToBucket, backupRecords } = await import('../src/storageCare.ts');
const { putBillFile, getBillFile } = await import('../src/storage.ts');
const { listBillsAcrossScopes } = await import('../src/store.ts');
const { loadCollection } = await import('../src/jsonStore.ts');
const { practiceDayKey } = await import('../src/usage.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const keyOf = (id: string) => listBillsAcrossScopes().find((b) => b.id === id)?.storageKey;

// --- A refusing bucket is said out loud ---------------------------------------
refuse = true;
const fellBack = await putBillFile('org_a', 'h5', 'application/pdf', Buffer.from('new upload'));
check('a refused upload still lands on local disk', fellBack.storageKey.startsWith('local:'), true);
let status = storageStatus();
check('and the status says the bucket is refusing', status.problems.some((p) => p.includes('refusing requests')), true);
check('naming what it said', status.health.lastFailureMessage.includes('AccessDenied'), true);

const refusedMove = await moveLocalFilesToBucket();
check('a move into a refusing bucket moves nothing', refusedMove.moved, 0);
check('and says why', refusedMove.error.includes('Could not copy'), true);
check('the records still point at the disk', keyOf('bill_1'), 'local:org_a_h1.pdf');

// --- The move ----------------------------------------------------------------
refuse = false;
const moved = await moveLocalFilesToBucket();
check('every file on disk is moved', moved.moved, 3);
check('both documents sharing one file point at one copy', [keyOf('bill_1'), keyOf('bill_2')], [
  'r2:bills/local/org_a_h1.pdf',
  'r2:bills/local/org_a_h1.pdf',
]);
check('the bucket holds the same bytes', objects.get('bills/local/org_a_h1.pdf')?.equals(receipt), true);
check('a record whose file is gone is left as it was', keyOf('bill_3'), 'local:org_a_gone.pdf');
check('one already in the bucket is untouched', keyOf('bill_4'), 'r2:bills/org_a/h9.pdf');
const claims = loadCollection<{ attachments: Array<{ storageKey: string }> }>('claims');
check('a claim’s supporting document moves too', claims[0].attachments[0].storageKey, 'r2:bills/local/org_a_claim_c1_h2.jpg');
const mail = loadCollection<{ bodyKey: string }>('email-thread');
check('and a mirrored mail’s stored body', mail[0].bodyKey, 'r2:bills/local/org_a_h3');
check('the local copy is kept', existsSync(join(DATA_DIR, 'files', 'org_a_h1.pdf')), true);
const read = await getBillFile(keyOf('bill_1')!);
const chunks: Buffer[] = [];
for await (const c of read!.body) chunks.push(Buffer.from(c));
check('and the document reads back from the bucket', Buffer.concat(chunks).equals(receipt), true);

const again = await moveLocalFilesToBucket();
check('running it again moves nothing more', again.moved, 0);
status = storageStatus();
check('nothing on disk is reported once moved', status.localFiles, 0);
check('the vanished file is named', status.move.missing, ['local:org_a_gone.pdf']);

// --- The backup ----------------------------------------------------------------
check('no backup yet is a problem', storageStatus().problems.some((p) => p.includes('not been backed up')), true);
const old = '2020-01-01';
objects.set(`backups/cybills/${old}/bills.json.gz`, Buffer.from('old'));
const backup = await backupRecords();
check('the backup ran', backup.ok, true);
const day = practiceDayKey(new Date());
const saved = objects.get(`backups/cybills/${day}/bills.json.gz`);
check('bills.json is in it, gzipped', JSON.parse(gunzipSync(saved!).toString()).bills.length, 4);
check('so are the other record files', objects.has(`backups/cybills/${day}/claims.json.gz`), true);
check('a day past the window is removed', objects.has(`backups/cybills/${old}/bills.json.gz`), false);
status = storageStatus();
check('and the status has nothing left to say', status.problems, []);
check('it records the day', status.backup.lastDay, day);
check('the record file on disk is untouched', JSON.parse(readFileSync(join(DATA_DIR, 'bills.json'), 'utf8')).bills.length, 4);

srv.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
