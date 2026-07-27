// Consistent display date across the app: "DD Mon YYYY" (e.g. "24 Jul 2026").
// Source dates arrive in mixed shapes — ISO "2026-07-24" from extraction,
// "11 Jul 2026" from sample data, or anything Date-parseable — so normalise
// them all to one format for display. Never mutate the stored value (sorting
// still keys off the raw date); format only at render time.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');
const cap3 = (s) => s.charAt(0).toUpperCase() + s.slice(1, 3).toLowerCase();

export function formatDate(d) {
  if (d == null || d === '' || d === '—') return d || '';
  const s = String(d).trim();

  // ISO date: YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${pad2(m[3])} ${MON[Number(m[2]) - 1] || m[2]} ${m[1]}`;

  // "DD Mon YYYY" or "DD-Mon-YYYY" (already close — normalise spacing/case/pad)
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/);
  if (m) return `${pad2(m[1])} ${cap3(m[2])} ${m[3]}`;

  // Fallback: anything the Date parser understands
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return `${pad2(dt.getDate())} ${MON[dt.getMonth()]} ${dt.getFullYear()}`;

  return s;
}
