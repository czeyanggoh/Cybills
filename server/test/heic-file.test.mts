// A stored HEIC is served as a JPEG (heic.ts). Detection is what decides
// whether a file is converted at all, so it is checked on each of the three
// signals a HEIC can arrive with — and a file that only CLAIMS to be HEIC but
// cannot be decoded must come back as nothing, so the route serves the
// original rather than failing. Decoding a real photo was checked by hand
// against one of the Yakson uploads (29 Oct 2026); a client's receipt is not a
// fixture, and there is no HEIC encoder to make one.
import { isHeicFile, heicToJpeg } from '../src/heic.ts';

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
};

const brand = (b: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from(`ftyp${b}`, 'latin1'), Buffer.alloc(16)]);

check('declared image/heic', isHeicFile('image/heic'));
check('declared image/heif', isHeicFile('image/HEIF'));
check('no type, .HEIC name', isHeicFile('', '20261002 Lisa Claim - $1.86 Snack Allowance (Eggs).HEIC'));
check('no type, no name, heic brand in the bytes', isHeicFile('', '', brand('heic')));
check('mif1 brand counts', isHeicFile('application/octet-stream', 'photo', brand('mif1')));
check('a JPEG is not HEIC', !isHeicFile('image/jpeg', 'receipt.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
check('an AVIF brand is not HEIC', !isHeicFile('', '', brand('avif')));
check('a PDF is not HEIC', !isHeicFile('application/pdf', 'invoice.pdf', Buffer.from('%PDF-1.7 aaaaaaaaaa')));

const garbage = await heicToJpeg(brand('heic'));
check('an undecodable HEIC gives null, not an exception', garbage === null);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
