import { getOrganisation, listOrganisations, primaryOrgId } from './organisations.js';
import { WORKSPACE_ID } from './workspace.js';
import { accessibleOrgIds, canManagePractice, isPracticeTeam, type User } from './users.js';

// Was this document filed under the right client entity? Server-side.
//
// The comparison itself lives in ONE place: src/lib/tenantMatch.js, the pure,
// dependency-free module the browser already uses, tested by `npm test` at the
// repo root. It is loaded here at runtime by path rather than re-typed in
// TypeScript — same arrangement as taxRules.ts and categories.ts — because a
// second copy of the rule that decides whose book a receipt moves into is
// exactly the drift that must not happen.
//
// What this file adds is WHO is asking, which decides two separate things: what
// the document is COMPARED against, and how much of the answer may be said.
//
// A client's own employee is compared only against the entities they may open.
// An entity they cannot work in is not a candidate at all, so it can never be
// matched, named, or transferred to — that is what keeps one client's staff
// from learning another client's name off a badge.
//
// A PRACTICE COLLEAGUE is compared against every entity the firm holds, because
// silence is the wrong answer for them. A colleague works across several
// clients and is the very person who files a document in the wrong one; told
// nothing, they cannot tell "correctly filed" from "misfiled somewhere I can't
// reach", and the second is exactly the case they need to act on. What they are
// told is bounded by what they could already see: the entity is NAMED only to
// somebody who can already list the firm's clients (a practice manager, who
// also holds the remedy — client access). To everyone else the answer is that
// it belongs to another client entity they don't have access to, which tells
// them nothing the bill-to line printed on their own document does not.

// `access` is the difference between a badge that offers a button and one that
// explains why there isn't one. With access false the move would be refused
// server-side, and orgId/name are blank unless the caller may be told which
// entity it is.
export type TenantMatch = { orgId: string; name: string; exact: boolean; access: boolean };

type TenantMatchModule = {
  normaliseEntityName: (value: unknown) => string;
  misfiledOrganisation: (args: {
    billedTo: unknown;
    currentOrgId: string;
    organisations: Array<{ id: string; name: string; tenantName: string }>;
    accessibleIds?: string[] | null;
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

const asRow = (o: { id: string; name: string; tenantName: string }) => ({
  id: o.id,
  name: o.name,
  tenantName: o.tenantName,
});

// What this caller's documents are compared against. A practice colleague is
// measured against every entity the firm holds (so "it belongs somewhere you
// can't reach" is sayable at all); everybody else only against what they may
// open. A sessionless mock/dev caller gets every linked entity, exactly as it
// does everywhere else.
export function candidateOrgs(ws: string, me: User | null): Array<{ id: string; name: string; tenantName: string }> {
  if (!me || isPracticeTeam(me)) return listOrganisations(ws).map(asRow);
  return accessibleOrgIds(ws, me)
    .map((id) => getOrganisation(ws, id))
    .filter((o): o is NonNullable<typeof o> => Boolean(o))
    .map(asRow);
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
// decide — one candidate entity, or no match rules — so the caller never has to
// ask whether the feature is on.
export async function misfiledLookup(
  ws: string,
  me: User | null
): Promise<(billedTo: unknown, currentOrgId: string) => TenantMatch | null> {
  const none = () => null;
  const organisations = candidateOrgs(ws, me);
  // One entity to compare against is one entity a document can be in: nothing
  // to be wrong about, and no other client's name to put on screen.
  if (organisations.length < 2) return none;
  const mod = await loadTenantMatch();
  if (!mod) return none;
  const accessibleIds = me ? accessibleOrgIds(ws, me) : organisations.map((o) => o.id);
  // Who may be TOLD which entity it is. A practice manager can already list
  // every client the firm holds (GET /api/organisations?all=1, and the Clients
  // page), and holds the remedy — so naming it to them adds nothing they could
  // not look up, and makes the message actionable. Anyone else is told only
  // that it belongs elsewhere, which their own document's bill-to line already
  // says. Sessionless mock/dev behaves as it does everywhere: fully open.
  const mayName = !me || canManagePractice(me);
  const memo = new Map<string, TenantMatch | null>();
  return (billedTo: unknown, currentOrgId: string) => {
    const billed = String(billedTo ?? '').trim();
    if (!billed || !currentOrgId) return null;
    const key = `${currentOrgId}|${billed}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    let answer: TenantMatch | null = null;
    try {
      answer = mod.misfiledOrganisation({ billedTo: billed, currentOrgId, organisations, accessibleIds });
      // Redacted, not withheld: the fact that it is filed in the wrong place is
      // the useful half, and it survives without the name. The id goes too —
      // one that reached the browser would be a client id the caller was never
      // given, and a move naming it would be refused anyway.
      if (answer && !answer.access && !mayName) answer = { ...answer, orgId: '', name: '' };
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
