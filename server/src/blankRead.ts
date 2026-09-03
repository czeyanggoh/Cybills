// "The reader got nothing off this file."
//
// A dark photo, a scan the reader could not see, a PDF that is really an image
// of one — the read runs, costs a model call, and comes back with no supplier,
// no total, no date, no reference and no rows. That document is not work
// waiting to be coded: there is nothing on it to code, and nothing a reviewer
// can do at the keyboard except ask for it again. Filed into the Costs inbox it
// is noise in the one list that is supposed to be the work, and it is the
// commonest noise there is on the WhatsApp road, where a photo taken in a car
// park is an ordinary event.
//
// The test itself is NOT written here. It is the same one the "Nothing read"
// badge, the extraction filter and the merge scan use (`statesNothing` over
// `docFacts`, src/lib/mergeDetect.js), loaded by path the way categories.ts and
// entityCheck.ts load theirs — a second copy in TypeScript would drift, and the
// drift would be a document the badge calls blank and the filing rule does not,
// which is the sort of disagreement nobody can see and everybody has to
// explain.
type MergeRules = {
  docFacts: (d: unknown) => Record<string, unknown>;
  statesNothing: (f: Record<string, unknown>) => boolean;
};

let rules: MergeRules | null = null;
let tried = false;

async function loadMergeRules(): Promise<MergeRules | null> {
  if (tried) return rules;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/mergeDetect.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<MergeRules>;
    rules =
      typeof mod?.docFacts === 'function' && typeof mod?.statesNothing === 'function'
        ? (mod as MergeRules)
        : null;
  } catch (e) {
    console.error('[blankRead] merge rules unavailable', e);
    rules = null;
  }
  return rules;
}

/**
 * Did a read that ACTUALLY RAN come back with nothing at all?
 *
 * Only ever asked of a document whose read completed. A read that failed, was
 * refused, or never happened (extraction switched off, the process died
 * mid-read) leaves a document that looks identical and means something
 * completely different — nobody has looked at it yet — and setting those aside
 * would empty the inbox of every document on a deploy with no API key.
 *
 * Answers false when the rules cannot be loaded: the document then lands in the
 * inbox as it always did, which is the harmless half of being wrong.
 */
export async function readGotNothing(bill: unknown): Promise<boolean> {
  const mod = await loadMergeRules();
  if (!mod) return false;
  try {
    return mod.statesNothing(mod.docFacts(bill));
  } catch {
    return false;
  }
}
