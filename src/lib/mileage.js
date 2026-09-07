// A mileage claim is a cost with no receipt behind it.
//
// Somebody drives their own car on company business and is paid back per
// kilometre — so what they hand in is not a purchase at all but a RECORD OF A
// JOURNEY: a map route screenshot ("16 min (13 km)"), an odometer photo, a line
// off a mileage log. There is no supplier being paid and no amount printed
// anywhere; the money is worked out afterwards as distance × the rate the
// company reimburses at. Until now the Type dropdown offered "Mileage" and then
// treated the document exactly like a receipt, leaving somebody to do that sum
// by hand and type the answer into Total.
//
// So a Mileage document carries two figures of its own — `distanceKm`, read off
// the paper, and `mileageRate`, the $ per km — and its total is DERIVED from
// them, the way a line item's total is derived from its net and tax
// (lineItems.js). The rate has a default per entity (Business settings →
// Extraction → Mileage) and can be changed on the document, since one claim
// may be at another rate. Tax is always 0: there is no tax invoice behind a
// mileage allowance, so there is no GST to claim on it.
//
// Pure, so the page, the server's PATCH and the reader's finalize all apply
// the same arithmetic (server/src/mileage.ts loads this file by path, the way
// categories.ts loads categoryList.js). Tested by test/mileage.test.mjs.

export const MILEAGE_TYPE = 'Mileage';

// Whether a document's type is the mileage one, however it is spelt or cased.
export const isMileage = (type) => String(type ?? '').trim().toLowerCase() === 'mileage';

// A positive number out of whatever the field holds — a form string ("13",
// "0.60", "13 km"), a stored number — or 0 when it holds nothing usable. Zero
// and blank are the same answer here: neither is a distance anybody drove.
export function positive(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// distance × rate, to the cent. Null — not 0 — when either half is missing,
// so a caller can tell "nothing to compute" from "computed to nothing".
export function mileageAmount(distanceKm, ratePerKm) {
  const km = positive(distanceKm);
  const rate = positive(ratePerKm);
  if (!km || !rate) return null;
  return Math.round(km * rate * 100) / 100;
}

// "13 km" / "12.5 km" — as many decimals as the figure needs, at most two.
export function formatKm(distanceKm) {
  const km = positive(distanceKm);
  if (!km) return '';
  const rounded = Math.round(km * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0$/, '')} km`;
}

// "13 km × 0.60/km" — the working behind a mileage total, for a claim line, a
// PDF and the page's own hint. Only the halves that are present: a distance
// with no rate yet reads "13 km", so the reviewer sees what is still missing.
export function mileageSummary(distanceKm, ratePerKm, currency = '') {
  const km = formatKm(distanceKm);
  const rate = positive(ratePerKm);
  if (!km) return '';
  if (!rate) return km;
  const cur = String(currency || '').trim().toUpperCase().slice(0, 3);
  return `${km} × ${cur ? `${cur} ` : ''}${rate.toFixed(2)}/km`;
}

// The patch that keeps a mileage document's money in step with its distance
// and rate.
//
// `doc` is the document as it stands (`documentType` or `type`, `distanceKm`,
// `mileageRate`), `changes` what is about to be written over it, `defaultRate`
// the entity's own rate. Returns ONLY what has to be written on top of
// `changes`: nothing for a document that is not (about to be) a Mileage one, a
// filled-in rate when the document had none and the entity has a default, and
// the total + tax whenever both halves are known. A distance or rate that is
// being CLEARED takes the total with it — a mileage document whose total says
// 7.80 beside an empty distance is a figure nobody can account for.
//
// Numbers throughout: the page turns them into its own strings.
export function mileagePatch(doc, changes = {}, defaultRate = '') {
  const next = { ...(doc || {}), ...(changes || {}) };
  const type = 'documentType' in next ? next.documentType : next.type;
  if (!isMileage(type)) return {};
  const out = {};
  let rate = positive(next.mileageRate);
  if (!rate && positive(defaultRate)) {
    rate = positive(defaultRate);
    out.mileageRate = rate;
  }
  const amount = mileageAmount(next.distanceKm, rate);
  if (amount != null) {
    out.total = amount;
    out.tax = 0;
  } else if ('distanceKm' in changes || 'mileageRate' in changes) {
    out.total = 0;
    out.tax = 0;
  }
  return out;
}
