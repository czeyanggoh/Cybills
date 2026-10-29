// An iPhone photo stored as HEIC, made into a JPEG.
//
// No browser but Safari can draw HEIC, so a document stored that way showed a
// broken image on its page, in the lightbox, in the claim PDF and in Xero —
// six Yakson claim photos uploaded before the upload converted them (29 Oct
// 2026). The upload now converts in the browser; this is the server's half,
// for a file already stored as one: `/bills/:id/file` converts it the first
// time it is asked for and stores the JPEG in its place, so every later reader
// gets a JPEG without being told anything.
//
// heic-convert carries a current libheif (1.19+). heic2any, the browser
// library tried first, answers "format not supported" for a current iPhone's
// HEIC, so the version matters. Loaded on demand: it is a few MB of
// WebAssembly that almost no request needs.

// Known by the declared type, else the name, else the bytes ("ftyp" at 4 and a
// HEIF brand at 8) — Windows often gives a .HEIC no type at all.
export function isHeicFile(contentType: string, fileName = '', bytes?: Buffer): boolean {
  if (/^image\/hei[cf]/i.test(contentType)) return true;
  if (/\.hei[cf]$/i.test(fileName)) return true;
  if (bytes && bytes.length > 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    return /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(bytes.toString('latin1', 8, 12));
  }
  return false;
}

// JPEG bytes, or null when the file cannot be decoded (it is then served as it
// is, which is no worse than before).
export async function heicToJpeg(bytes: Buffer): Promise<Buffer | null> {
  try {
    const name = 'heic-convert';
    const mod = await import(name);
    const convert = mod.default ?? mod;
    const out = await convert({ buffer: bytes, format: 'JPEG', quality: 0.85 });
    return Buffer.from(out);
  } catch (err) {
    console.error('[heic] could not convert', err);
    return null;
  }
}
