// What a file IS, for the reader — decided from the bytes, never taken on
// trust from the road it arrived by.
//
// The upload road is strict: the browser supplies `file.type`, and /extract
// refuses anything that is not exactly one of the five types the reader
// takes. The two roads nobody is watching were not. An emailed attachment
// carried whatever the Worker's MIME parser reported — `application/octet-
// stream` from a mail client that never sets one, `image/jpg` from a phone,
// `application/pdf; name="x.pdf"` with its parameters still on — and a
// WhatsApp'd file whatever CYWS or the signed URL said. The filing filter let
// all of those through (the NAME said .pdf), and the reader was then handed the
// raw string: it treats only exactly `application/pdf` as a PDF, so a PDF under
// any other label went to OpenAI as an IMAGE with a bogus data URL, the API
// refused it, and the read ended as "Auto-read didn't complete". The same
// invoice, uploaded by hand a minute later, read fine.
//
// So the type the reader is given is worked out here, in one place for both
// roads: the magic bytes first (a PDF starts with %PDF whatever its label), the
// declared type second (lowercased, parameters stripped, the common misspellings
// folded), the file's extension last. Anything that is none of the five is
// reported as '' so the read can SAY the file is a kind it cannot read — a HEIC
// off an iPhone, a TIFF scan — rather than fail against the API and leave a
// note that names the wrong cause.

export const READER_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'] as const;
export type ReaderMedia = (typeof READER_MEDIA)[number];

const ALIASES: Record<string, ReaderMedia> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'application/x-pdf': 'application/pdf',
};

const BY_EXT: Record<string, ReaderMedia> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
};

const isReaderMedia = (s: string): s is ReaderMedia => (READER_MEDIA as readonly string[]).includes(s);

// The bytes say what they are. A PDF may carry a byte-order mark or a few bytes
// of junk before its header, so the signature is looked for in the first KB.
export function sniffMediaType(bytes: Uint8Array | Buffer | null | undefined): ReaderMedia | '' {
  if (!bytes || bytes.length < 4) return '';
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  const head = Buffer.from(b.subarray(0, Math.min(b.length, 1024))).toString('latin1');
  if (head.includes('%PDF')) return 'application/pdf';
  return '';
}

// The declared type, as the reader would need it: lowercased, its parameters
// dropped, the aliases folded. '' for anything that is not one of the five.
export function declaredMediaType(declared: string | null | undefined): ReaderMedia | '' {
  const bare = String(declared ?? '').split(';')[0].trim().toLowerCase();
  if (!bare) return '';
  const folded = ALIASES[bare] ?? bare;
  return isReaderMedia(folded) ? folded : '';
}

export function mediaTypeFromName(fileName: string | null | undefined): ReaderMedia | '' {
  const name = String(fileName ?? '').trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return BY_EXT[name.slice(dot + 1)] ?? '';
}

// The one answer: bytes, then label, then name.
export function readerMediaType(
  declared: string | null | undefined,
  fileName: string | null | undefined,
  bytes?: Uint8Array | Buffer | null
): ReaderMedia | '' {
  return sniffMediaType(bytes) || declaredMediaType(declared) || mediaTypeFromName(fileName);
}

// What to say about a file the reader cannot take. Names the label it arrived
// under so the note points at the file rather than at the reader.
export function unreadableTypeNote(declared: string | null | undefined, fileName: string | null | undefined): string {
  const label = String(declared ?? '').split(';')[0].trim() || mediaTypeFromName(fileName) || 'unknown type';
  return `file type ${label} can't be read — send it as a PDF, PNG or JPEG`;
}
