import type { Bill } from './store.js';

// A payment proof is paid, carries no tax, and is set aside to Archived,
// server-side — it is never published (xero.ts refuses one), and its use is the
// invoices it pays (proofMatch.ts).
//
// The rule is NOT written here: it is the same pure module the document page
// and the upload drawer apply (src/lib/paymentProof.js), loaded by path the way
// mileage.ts and motorVehicle.ts load theirs — a second copy would drift, and
// the drift would be a page showing Paid over a stored document that is not.
//
// Applied on a write that SETS the type — the reader's finalize, an emailed or
// WhatsApp'd document's background read, and a PATCH carrying `documentType`
// (the page's Type field, Bulk edit) — and only those: the type is what says
// the document was paid and states no tax, so an ordinary edit afterwards
// (somebody unticking Paid because the transfer bounced) is theirs to make.
//
// Left alone, as every rule that runs by itself is: a document PUBLISHED to
// Xero, one on an expense claim or merged away, and a tax code a person picked.

type ProofRules = {
  isPaymentProof: (type: unknown) => boolean;
  paymentProofPatch: (doc: unknown, noTaxName?: string) => Record<string, unknown>;
};

let rules: ProofRules | null = null;
let tried = false;

async function loadProofRules(): Promise<ProofRules | null> {
  if (tried) return rules;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/paymentProof.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<ProofRules>;
    rules =
      typeof mod?.isPaymentProof === 'function' && typeof mod?.paymentProofPatch === 'function'
        ? (mod as ProofRules)
        : null;
  } catch (e) {
    console.error('[paymentProof] rules unavailable', e);
    rules = null;
  }
  return rules;
}

// The statuses a proof is archived out of: the inbox, and a document still
// being read (the upload's finalize and the background read both land here).
const PROOF_ARCHIVES_FROM = ['new', 'viewed', 'review', 'ready', 'processing'];

/** Whether a stored document is typed as a payment proof. */
export async function isPaymentProofDoc(b: { documentType?: unknown } | null | undefined): Promise<boolean> {
  const r = await loadProofRules();
  return Boolean(r && b && r.isPaymentProof(b.documentType));
}

/**
 * Hold a document typed as a payment proof to what the type says. Mutates
 * `patch` in place; returns whether it wrote anything. Does nothing unless this
 * very write carries the type.
 */
export async function keepPaymentProofInStep(current: Partial<Bill> | null, patch: Record<string, unknown>): Promise<boolean> {
  if (!('documentType' in patch)) return false;
  const r = await loadProofRules();
  if (!r) return false;
  const doc = { ...(current || {}), ...patch } as Partial<Bill> & Record<string, unknown>;
  if (!r.isPaymentProof(doc.documentType)) return false;
  if (doc.xeroInvoiceId) return false;
  if (['deleted', 'merged', 'expenseclaim'].includes(String(doc.status || ''))) return false;
  const out = r.paymentProofPatch(doc);
  if (!Object.keys(out).length) return false;
  Object.assign(patch, out);
  // Set aside, not filed: a transfer confirmation is not a cost to code or
  // publish, and in the working list it reads as one. What it is FOR is the
  // invoices it pays (proofMatch.ts). A write that names its own status is a
  // person's decision — somebody pulling a proof back out — and is left alone.
  if (!('status' in patch) && PROOF_ARCHIVES_FROM.includes(String(doc.status || ''))) patch.status = 'archived';
  // A supplier rule that last wrote the code no longer owns it — or the rule
  // sweep would write its code back on the next listing.
  if ('taxRate' in out) {
    const owned = Array.isArray(current?.ruleFields) ? current!.ruleFields : [];
    if (owned.includes('taxRate')) patch.ruleFields = owned.filter((f) => f !== 'taxRate');
  }
  return true;
}
