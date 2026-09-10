import { getBillByIdAny } from './store.js';
import { getBillFile } from './storage.js';
import { shareToken } from './shareLinks.js';

// Building a claim's PDF on the SERVER.
//
// Same arrangement as claimRef.ts, mileage.ts and categories.ts: the rules live
// in the pure module the browser already uses (src/lib/claimPdf.js) and are
// loaded here by path. A second implementation would drift, and the drift would
// show up as the document an approver reads looking unlike the one the app
// produces — which is the one thing about a claim PDF that must not vary.
//
// What the server supplies that the browser supplies for itself: a `loadFile`
// that reads the object store DIRECTLY rather than fetching the app's routes
// (there is no session here, and the whole point of the signed link is that the
// person opening it has none either), the signed links the Item IDs point at,
// and the origin to put in front of them.

type ClaimPdfModule = {
  assembleClaimBytes: (
    claim: unknown,
    opts: {
      detailLevel?: string;
      loadFile: (ref: FileRef) => Promise<{ contentType: string; bytes: ArrayBuffer } | null>;
      links?: Record<string, string>;
      origin?: string;
    },
  ) => Promise<Uint8Array>;
};

type FileRef =
  | { kind: 'receipt'; itemId: string }
  | { kind: 'attachment'; claimId: string; attachmentId: string };

/** Only what the PDF needs of a claim — the record itself is claims.ts's. */
export interface PdfClaim {
  id: string;
  transactions?: Array<{ itemId?: string }>;
  attachments?: Array<{ id: string; storageKey: string; contentType: string }>;
}

let cache: ClaimPdfModule | null = null;
let tried = false;

async function load(): Promise<ClaimPdfModule | null> {
  if (tried) return cache;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root. jspdf and
    // pdf-lib resolve from the ROOT node_modules, which the deploy installs
    // before it builds the frontend (scripts/deploy.sh).
    const url = new URL('../../src/lib/claimPdf.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<ClaimPdfModule>;
    cache = typeof mod?.assembleClaimBytes === 'function' ? (mod as ClaimPdfModule) : null;
    if (!cache) console.error('[claimPdfDoc] claimPdf.js loaded but has no assembleClaimBytes');
  } catch (e) {
    console.error('[claimPdfDoc] the claim PDF module is unavailable', e);
    cache = null;
  }
  return cache;
}

async function drain(body: NodeJS.ReadableStream): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c));
  const buf = Buffer.concat(chunks);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

// Read a receipt or a supporting document straight out of the object store. A
// file that cannot be read is `null`, which the assembler skips — a claim whose
// receipts have gone still produces its report rather than nothing at all.
function loaderFor(claim: PdfClaim) {
  return async (ref: FileRef) => {
    try {
      const found =
        ref.kind === 'attachment'
          ? claim.attachments?.find((a) => a.id === ref.attachmentId)
          : (() => {
              const bill = getBillByIdAny(String(ref.itemId));
              return bill?.storageKey ? { storageKey: bill.storageKey, contentType: bill.contentType } : undefined;
            })();
      if (!found?.storageKey) return null;
      const obj = await getBillFile(found.storageKey, found.contentType);
      if (!obj) return null;
      return { contentType: String(found.contentType || obj.contentType || ''), bytes: await drain(obj.body) };
    } catch (e) {
      console.error('[claimPdfDoc] could not read a file for the claim PDF', e);
      return null;
    }
  };
}

// The Item IDs in the report open the RECEIPT, and whoever holds this PDF has
// no session — so each one carries its own signed token, exactly as the browser
// mints them (`?s=`, the shape the file route verifies).
//
// Gated on the entity's Image sharing setting, the same as the browser's: that
// toggle is read again on every request, so minting a link past it would
// produce one the file route then refuses. Where it is off the Item ID falls
// back to the document page, which is what it does in the browser too.
function receiptLinks(claim: PdfClaim, sharingOn: boolean): Record<string, string> {
  if (!sharingOn) return {};
  const links: Record<string, string> = {};
  for (const t of claim.transactions || []) {
    const id = String(t?.itemId ?? '');
    if (!id) continue;
    const bill = getBillByIdAny(id);
    if (!bill?.storageKey) continue;
    links[id] = `/api/costs/bills/${encodeURIComponent(id)}/file?s=${encodeURIComponent(shareToken(id))}`;
  }
  return links;
}

/**
 * The claim's PDF — report, approval history, supporting documents, receipts.
 * Null when the module can't be loaded or rendering throws, and the caller
 * answers 502 rather than serving an empty file.
 */
export async function claimPdfBytes(
  claim: PdfClaim,
  origin: string,
  { imageSharing = true }: { imageSharing?: boolean } = {},
): Promise<Uint8Array | null> {
  const mod = await load();
  if (!mod) return null;
  try {
    return await mod.assembleClaimBytes(claim, {
      detailLevel: 'with_receipts',
      loadFile: loaderFor(claim),
      links: receiptLinks(claim, imageSharing),
      origin,
    });
  } catch (e) {
    console.error('[claimPdfDoc] could not build the claim PDF', e);
    return null;
  }
}
