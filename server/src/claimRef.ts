// The Reference a published claim carries into Xero.
//
// Same arrangement as taxRules.ts and categories.ts: the format lives in one
// pure module the browser already uses (src/lib/claimReference.js) and is
// loaded here by path. The number in it is the claim's own "Claim ID" — printed
// on its page, on the PDF and in the CSV — so a second implementation would
// mean the bill in Xero and the claim it came from disagreeing about their name.

type ClaimRefModule = {
  claimReference: (claim: unknown) => string;
  claimDateFor: (claim: unknown) => string;
  claimRef: (claim: unknown) => string;
};

let cache: ClaimRefModule | null = null;
let tried = false;

async function load(): Promise<ClaimRefModule | null> {
  if (tried) return cache;
  tried = true;
  try {
    const url = new URL('../../src/lib/claimReference.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<ClaimRefModule>;
    cache =
      typeof mod?.claimReference === 'function'
      && typeof mod?.claimDateFor === 'function'
      && typeof mod?.claimRef === 'function'
        ? (mod as ClaimRefModule)
        : null;
  } catch (e) {
    console.error('[claimRef] reference module unavailable', e);
    cache = null;
  }
  return cache;
}

// "ST Eng Exp Claim 20-Aug-2026 21324972410". Falls back to the claim's name
// alone if the module can't be loaded — a reference that is merely less
// specific, never a wrong one.
export async function referenceFor(claim: { name?: string }): Promise<string> {
  const mod = await load();
  const fallback = String(claim?.name || '').trim() || 'Expense claim';
  if (!mod) return fallback;
  try {
    return mod.claimReference(claim) || fallback;
  } catch (e) {
    console.error('[claimRef] could not build the reference', e);
    return fallback;
  }
}

// The bare claim number — "260820120000", the "Claim ID" printed on the claim's
// own page and on the PDF, and the "Claim No" a recharge report prints. That is
// the same number `referenceFor` puts at the end of the bill's name; this is it
// on its own, for a column that has no room for the rest. '' when the module
// can't be loaded, and the caller shows nothing rather than an invented id.
export async function numberFor(claim: unknown): Promise<string> {
  const mod = await load();
  if (!mod) return '';
  try {
    return mod.claimRef(claim) || '';
  } catch (e) {
    console.error('[claimRef] could not build the claim number', e);
    return '';
  }
}

// The date the bill should carry: the claim's own, else the period it covers,
// else the latest date among its items. '' when the claim has nothing dated,
// and the caller falls back to today.
export async function dateFor(claim: unknown): Promise<string> {
  const mod = await load();
  if (!mod) return '';
  try {
    return mod.claimDateFor(claim) || '';
  } catch (e) {
    console.error('[claimRef] could not read the claim date', e);
    return '';
  }
}
