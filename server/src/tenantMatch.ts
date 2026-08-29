import { getOrganisation, primaryOrgId } from './organisations.js';
import { WORKSPACE_ID } from './workspace.js';
import { accessibleOrgIds, type User } from './users.js';

// Was this document filed under the right client entity? Server-side.
//
// The comparison itself lives in ONE place: src/lib/tenantMatch.js, the pure,
// dependency-free module the browser already uses, tested by `npm test` at the
// repo root. It is loaded here at runtime by path rather than re-typed in
// TypeScript — same arrangement as taxRules.ts and categories.ts — because a
// second copy of the rule that decides whose book a receipt moves into is
// exactly the drift that must not happen.
//
// What this file adds is WHO is asking. Being in the wrong book is a fact about
// the document, but the answer is only ever given against the entities the
// CALLER may open: an entity somebody cannot work in is not a candidate, so it
// can never be matched, named on screen, or transferred to. That is what keeps
// one client's staff from learning another client's name off a badge.

export type TenantMatch = { orgId: string; name: string; exact: boolean };

type TenantMatchModule = {
  normaliseEntityName: (value: unknown) => string;
  misfiledOrganisation: (args: {
    billedTo: unknown;
    currentOrgId: string;
    organisations: Array<{ id: string; name: string; tenantName: string }>;
  }) => TenantMatch | null;
};

let cache: TenantMatchModule | null = null;
let tried = false;

// Guarded and cached. If the module can't be loaded nothing is ever reported as
// misfiled — the behaviour before any of this existed, so the failure mode is
// "no answer", never a wrong one.
export async function loadTenantMatch(): Promise<TenantMatchModule | null> {
  if (tried) return cache;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/tenantMatch.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<TenantMatchModule>;
    cache =
      typeof mod?.misfiledOrganisation === 'function' && typeof mod?.normaliseEntityName === 'function'
        ? (mod as TenantMatchModule)
        : null;
  } catch (e) {
    console.error('[tenantMatch] match rules unavailable', e);
    cache = null;
  }
  return cache;
}

// The entities this caller may open, as the match rules want them. A sessionless
// mock/dev caller sees every linked entity, exactly as it does everywhere else.
export function candidateOrgs(ws: string, me: User | null): Array<{ id: string; name: string; tenantName: string }> {
  return accessibleOrgIds(ws, me)
    .map((id) => getOrganisation(ws, id))
    .filter((o): o is NonNullable<typeof o> => Boolean(o))
    .map((o) => ({ id: o.id, name: o.name, tenantName: o.tenantName }));
}

// The entity a stored bill lives in, from the data SCOPE it carries. The primary
// entity folds to WORKSPACE_ID (see dataScopeForOrg), so the two are not the
// same string and a document must be compared against the entity it is actually
// in — not the one the caller happens to have selected, which for a claim's item
// can be a different book entirely.
export const orgIdOfScope = (scope: string | undefined): string =>
  !scope || scope === WORKSPACE_ID ? primaryOrgId() : scope;

// A reusable "where does this belong?" for one response: the entity list and
// the module are resolved once, and each answer is memoised, so a book of five
// hundred documents from a handful of clients costs a handful of comparisons
// rather than five hundred.
//
// Returns a function that answers null for everything when there is nothing to
// decide — one accessible entity, or no match rules — so the caller never has
// to ask whether the feature is on.
export async function misfiledLookup(
  ws: string,
  me: User | null
): Promise<(billedTo: unknown, currentOrgId: string) => TenantMatch | null> {
  const none = () => null;
  const organisations = candidateOrgs(ws, me);
  // One entity to work in is one entity a document can be in: nothing to be
  // wrong about, and no other client's name to put on screen.
  if (organisations.length < 2) return none;
  const mod = await loadTenantMatch();
  if (!mod) return none;
  const memo = new Map<string, TenantMatch | null>();
  return (billedTo: unknown, currentOrgId: string) => {
    const billed = String(billedTo ?? '').trim();
    if (!billed || !currentOrgId) return null;
    const key = `${currentOrgId}|${billed}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    let answer: TenantMatch | null = null;
    try {
      answer = mod.misfiledOrganisation({ billedTo: billed, currentOrgId, organisations });
    } catch (e) {
      console.error('[tenantMatch] could not decide', e);
    }
    memo.set(key, answer);
    return answer;
  };
}

// Whether a document may be moved at all, and why not when it may not.
//
// Three states put a document beyond a transfer, and each of them is a promise
// already made somewhere else:
//   - PUBLISHED: its figures are in that entity's ledger under an invoice id
//     this book still points at. Moving the paperwork would leave the two
//     disagreeing, which is the exact thing publishing from here prevents.
//   - ON A CLAIM: the claim lives in the entity it was raised in, and reaches
//     Xero as one bill. Taking one of its items to another book would leave the
//     claim quoting a document that is no longer in it.
//   - MERGED INTO ANOTHER: it is a source page, not a document — the document
//     that combined it decides where it lives, and Unmerge has to find it.
export function transferBlockedReason(bill: {
  xeroInvoiceId?: string;
  status?: string;
}): string {
  if (bill.xeroInvoiceId) return 'published';
  if (bill.status === 'expenseclaim') return 'on_a_claim';
  if (bill.status === 'merged') return 'merged_into_another';
  return '';
}
