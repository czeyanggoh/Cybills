import { readSetting } from './settings.js';
import type { Bill } from './store.js';

// A mileage document's total, server-side.
//
// distance × rate per km, with the rate defaulting to the entity's own
// (Business settings → Extraction → Mileage). The arithmetic is NOT written
// here: it is the same pure module the document page uses
// (src/lib/mileage.js), loaded by path the way categories.ts and blankRead.ts
// load theirs — a second copy in TypeScript would drift, and the drift would be
// a page showing one total and the stored document another.
//
// Applied on every write that can change what the total depends on — a PATCH
// from the page, the reader's finalize, an emailed or WhatsApp'd document's
// background read — so the rule holds however the figures arrived.

type MileageRules = {
  isMileage: (type: unknown) => boolean;
  mileagePatch: (doc: unknown, changes: Record<string, unknown>, defaultRate: unknown) => Record<string, unknown>;
};

let rules: MileageRules | null = null;
let tried = false;

async function loadMileageRules(): Promise<MileageRules | null> {
  if (tried) return rules;
  tried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/mileage.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<MileageRules>;
    rules =
      typeof mod?.isMileage === 'function' && typeof mod?.mileagePatch === 'function'
        ? (mod as MileageRules)
        : null;
  } catch (e) {
    console.error('[mileage] rules unavailable', e);
    rules = null;
  }
  return rules;
}

// The entity's own rate per km, or 0 when it has never set one.
export function defaultMileageRate(ws: string, orgId: string): number {
  const settings = readSetting<{ mileageRate?: unknown }>(ws, 'cybills.extraction-settings.v1', orgId);
  const n = Number(String(settings?.mileageRate ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The fields a write touches that the total depends on.
const DEPENDS_ON = ['documentType', 'distanceKm', 'mileageRate'];

/**
 * Keep a mileage document's money in step with its distance and rate.
 *
 * Mutates `patch` in place, adding the total (and a zero tax) whenever the
 * document as it will stand after the write is a Mileage one with both figures
 * known, and the rate itself when the document had none and the entity has a
 * default. Does nothing when the write touches none of the three fields the
 * total depends on, so an ordinary edit costs nothing here. Does nothing when
 * the rules cannot be loaded, which leaves the document as the caller wrote it.
 */
export async function keepMileageInStep(
  ws: string,
  orgId: string,
  current: Bill | null | undefined,
  patch: Record<string, unknown>
): Promise<void> {
  if (!DEPENDS_ON.some((k) => k in patch)) return;
  const mod = await loadMileageRules();
  if (!mod) return;
  try {
    Object.assign(patch, mod.mileagePatch(current ?? {}, patch, defaultMileageRate(ws, orgId)));
  } catch (e) {
    console.error('[mileage] could not apply the rate', e);
  }
}
