// R2 speaks S3, but not every part of it.
//
// From v3.729 the AWS SDK adds a CRC32 checksum header to every upload by
// default. Cloudflare R2 refuses it, so PutObject fails for a reason that looks
// nothing like its cause — not the credentials, not the bucket, not the key.
// And the failure hides: putBillFile catches it and writes to local disk
// instead, so receipts still open while the bucket quietly holds none of them.
//
// This checks what actually goes over the wire, because the options that
// prevent it are easy to lose in an SDK bump or a tidy-up, and nothing else
// would notice.
import { createServer } from 'node:http';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';

const seen: Array<Record<string, string | string[] | undefined>> = [];
const srv = createServer((req, res) => {
  seen.push({ ...req.headers });
  res.writeHead(200, { ETag: '"x"' });
  res.end();
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const port = (srv.address() as { port: number }).port;

const { r2Config } = await import('../src/storage.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// The real configuration, pointed at a local listener instead of Cloudflare so
// the request can be read. Everything else is exactly what ships.
async function put(config: S3ClientConfig) {
  const client = new S3Client({
    ...config,
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
  });
  await client.send(
    new PutObjectCommand({ Bucket: 'bk', Key: 'k.pdf', Body: Buffer.from('hi'), ContentType: 'application/pdf' })
  );
  return Object.keys(seen[seen.length - 1]!).filter((h) => h.includes('checksum')).sort();
}

// What the SDK does left alone — the thing R2 rejects. Asserted so this test
// still means something the day the SDK stops doing it.
const asShipped = await put({ region: 'auto' });
check('the SDK adds a checksum header by default', asShipped, [
  'x-amz-checksum-crc32',
  'x-amz-sdk-checksum-algorithm',
]);

// What CYBills sends.
check('CYBills sends none', await put(r2Config()), []);

check('and asks for none back', r2Config().responseChecksumValidation, 'WHEN_REQUIRED');

srv.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
