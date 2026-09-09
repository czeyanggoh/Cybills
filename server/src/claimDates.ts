import { practiceDayKey } from './usage.js';

// The date a claim's month closes on.
//
// Same arrangement as claimRef.ts and mileage.ts: the rule lives in the pure
// module the browser already uses (src/lib/claimDate.js) and is loaded here by
// path, so the date the dialog fills in and the date the server stores cannot
// disagree. A second copy in TypeScript would drift, and the drift would be a
// claim that says one period on the page and another in the book.
//
// WHICH month is each side's own answer, and deliberately so. The browser asks
// its own calendar; the server asks the PRACTICE's, because a day rolls over in
// Singapore rather than wherever UTC happens to be. Between midnight and 8am on
// the 1st those two are different months, and a claim raised then must not be
// closed against the month that has just ended.

type ClaimDateModule = {
  endOfMonthFor: (v: unknown) => string;
  toIsoClaimDate: (v: unknown) => string;
};

let cache: ClaimDateModule | null = null;
let tried = false;

async function load(): Promise<ClaimDateModule | null> {
  if (tried) return cache;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/claimDate.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<ClaimDateModule>;
    cache =
      typeof mod?.endOfMonthFor === 'function' && typeof mod?.toIsoClaimDate === 'function'
        ? (mod as ClaimDateModule)
        : null;
  } catch (e) {
    console.error('[claimDates] date rules unavailable', e);
    cache = null;
  }
  return cache;
}

// The last day of the month we are in, in the practice's own clock. '' when the
// rule can't be loaded, and the caller then keeps the date it was sent rather
// than storing one worked out a second way — a claim with the wrong period on
// it is worse than one whose period nobody forced.
export async function endOfThisMonth(): Promise<string> {
  const mod = await load();
  if (!mod) return '';
  try {
    return mod.endOfMonthFor(practiceDayKey(new Date())) || '';
  } catch (e) {
    console.error('[claimDates] could not work out the month end', e);
    return '';
  }
}

// The canonical ISO form of a claim date, handed back as a SYNC function once
// the module is in hand: the comparison it is wanted for happens inside a
// synchronous mutation, and a stored end date may have been typed in any of the
// shapes parseDateParts reads. Null when the module can't be loaded, and the
// caller falls back to comparing the strings as they stand.
export async function isoClaimDate(): Promise<((v: unknown) => string) | null> {
  const mod = await load();
  return mod ? mod.toIsoClaimDate : null;
}
