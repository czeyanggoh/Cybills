import { bookRevision, linkSupporting, listBills, repairSupporting, type Bill } from './store.js';

// Supporting documents, server-side: the receipts or expense reports sent in
// WITH an invoice that recharges them.
//
// The rule is NOT written here: it is the same pure module the Costs list reads
// (src/lib/supportingDocs.js), loaded by path the way proofMatch.ts loads its
// own — a second copy would drift, and the drift would be a row badged as
// somebody's backup that the server then refuses to link.
//
// And the sweep: a FIRM group (one email, the invoice billed to this entity,
// every other document that mail filed tied to it by the money) is linked by
// itself, off the listing and guarded by the book revision like the payment
// proof sweep. Everything weaker is only ever offered. A link somebody undid is
// remembered on the document (`notSupportingFor`), which takes it out of the
// rule's reach, so the same mail is not linked again behind them.

export type SupportTie = { id: string; reasons: string[]; line: string };
export type SupportGroup = { mainId: string; supports: SupportTie[]; confidence: 'firm' | 'possible'; via: string };
type StatusOf = (doc: Bill) => string;
type Rules = {
  findSupportingGroups: (docs: unknown[], opts: { statusOf: (d: any) => string }) => SupportGroup[];
  canBeMain: (doc: unknown) => boolean;
};

let rules: Rules | null = null;
let tried = false;

export async function supportingRules(): Promise<Rules | null> {
  if (tried) return rules;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/supportingDocs.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<Rules>;
    rules = ['findSupportingGroups', 'canBeMain'].every((k) => typeof (mod as Record<string, unknown>)?.[k] === 'function')
      ? (mod as Rules)
      : null;
  } catch (e) {
    console.error('[supportingDocs] rules unavailable', e);
    rules = null;
  }
  return rules;
}

const sweptAt = new Map<string, number>();
export async function autoLinkSupporting(scope: string, statusOf: StatusOf): Promise<number> {
  if (sweptAt.get(scope) === bookRevision()) return 0;
  const r = await supportingRules();
  if (!r) return 0;
  // Links that no longer hold first, so a released document is judged afresh.
  repairSupporting(scope);
  let linked = 0;
  for (const g of r.findSupportingGroups(listBills(scope), { statusOf })) {
    if (g.confidence !== 'firm') continue;
    linked += linkSupporting(scope, g.mainId, g.supports, '', true)?.supports.length ?? 0;
  }
  // Read AFTER linking: linking is itself a write, and the run that links
  // nothing new is the one that settles.
  sweptAt.set(scope, bookRevision());
  return linked;
}
