import { applyPaymentProof, bookRevision, listBills, type Bill } from './store.js';

// Which invoices a payment proof pays, server-side.
//
// The rule is NOT written here: it is the same pure module the document page
// reads (src/lib/proofMatch.js), loaded by path the way paymentProof.ts loads
// its own — a second copy would drift, and the drift would be a page offering a
// match the server then refuses, or the server applying one the page never
// showed.
//
// And the sweep: a proof applies its one FIRM match by itself (the only match
// the rules call firm, and not one another proof's firm match also claims),
// off the listing and guarded by the book revision like the duplicate scan, so
// it works whichever arrives first — the proof or the invoice it pays. A proof
// somebody un-applied is left alone for good (`proofAutoDeclined`).

export type ProofMatch = { ids: string[]; docs: Bill[]; total: number; confidence: 'firm' | 'possible'; reasons: string[] };
type ProofMatchRules = {
  isPaymentProof: (type: unknown) => boolean;
  proofMatches: (proof: unknown, docs: unknown[]) => ProofMatch[];
  suggestionFor: (matches: ProofMatch[]) => ProofMatch | null;
  sumsExactly: (proof: unknown, docs: unknown[]) => boolean;
  payableByProof: (doc: unknown, proof: unknown, opts?: { anyDate?: boolean }) => boolean;
};

let rules: ProofMatchRules | null = null;
let tried = false;

export async function proofMatchRules(): Promise<ProofMatchRules | null> {
  if (tried) return rules;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/proofMatch.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<ProofMatchRules>;
    rules = ['isPaymentProof', 'proofMatches', 'suggestionFor', 'sumsExactly', 'payableByProof'].every(
      (k) => typeof (mod as Record<string, unknown>)?.[k] === 'function'
    )
      ? (mod as ProofMatchRules)
      : null;
  } catch (e) {
    console.error('[proofMatch] rules unavailable', e);
    rules = null;
  }
  return rules;
}

// A proof still looking for what it pays.
export function unappliedProof(r: ProofMatchRules, b: Bill): boolean {
  return (
    (b.kind || 'cost') === 'cost' &&
    r.isPaymentProof(b.documentType) &&
    !['deleted', 'merged'].includes(String(b.status || '')) &&
    !(b.paysBills?.length)
  );
}

const sweptAt = new Map<string, number>();
export async function autoApplyPaymentProofs(scope: string): Promise<number> {
  if (sweptAt.get(scope) === bookRevision()) return 0;
  const r = await proofMatchRules();
  if (!r) return 0;
  sweptAt.set(scope, bookRevision());
  const docs = listBills(scope);
  const picks: Array<{ proof: Bill; ids: string[] }> = [];
  for (const proof of docs) {
    if (!unappliedProof(r, proof) || proof.proofAutoDeclined) continue;
    const firm = r.suggestionFor(r.proofMatches(proof, docs));
    if (firm) picks.push({ proof, ids: firm.ids });
  }
  // An invoice two proofs both firmly claim is a choice, and a person's.
  const claims = new Map<string, number>();
  for (const p of picks) for (const id of p.ids) claims.set(id, (claims.get(id) ?? 0) + 1);
  let applied = 0;
  for (const p of picks) {
    if (!p.ids.every((id) => claims.get(id) === 1)) continue;
    if (applyPaymentProof(scope, p.proof.id, p.ids, '', true)) applied += 1;
  }
  // Read AFTER applying: applying is itself a write, and the run that applies
  // nothing new is the one that settles.
  sweptAt.set(scope, bookRevision());
  return applied;
}
