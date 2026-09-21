// How a foreign receipt came to be the figure on an expense claim — the claim
// is in one currency (SGD, usually) and a receipt from a trip abroad is not.
// The server converts it (claims.ts `claimMoney`): at the receipt's own
// restatement where it printed one, else at the day's rate for its date. This
// says so on the claim line and in its PDF, the way a mileage item shows its
// kilometres, so the approver can see where the figure came from.
import { mileageSummary } from './mileage.js';

const money = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : '';
};

// "USD 25.00 @ 1.3144 (day rate)", "USD 25.00 — no rate found", or ''.
export function fxSummary(t, claimCurrency = '') {
  const from = String(t?.origCurrency ?? '').trim().toUpperCase();
  if (!from || from === String(claimCurrency ?? '').trim().toUpperCase()) return '';
  const amount = money(t?.origTotal);
  if (t?.fxMissing) return `${from} ${amount} — no rate found, counted as printed`;
  const rate = Number(t?.fxRate);
  if (!(rate > 0)) return '';
  const how = t?.fxSource === 'document' ? 'as restated on the receipt' : 'day rate';
  return `${from} ${amount} @ ${Number(rate.toFixed(6))} (${how})`;
}

// Everything worth saying beside a claim line's description: its mileage
// working and its currency working.
export function lineWorking(t, claimCurrency = '') {
  return [mileageSummary(t?.distanceKm, t?.mileageRate, claimCurrency), fxSummary(t, claimCurrency)].filter(Boolean).join(' · ');
}
