// Reading a Dext export, so a client's documents can be moved here.
//
// A practice moving off Dext has months of already-CODED documents: the
// supplier read, the category chosen, the tax settled. Re-uploading the files
// and reading them again would throw all of that away and bill a model call per
// document to arrive back where it started. So the CSV is the source of the
// FIELDS and the downloaded files are the source of the BYTES, and the two are
// matched up here.
//
// Pure on purpose — no fetch, no DOM — because the matching rules are the part
// worth testing, and the part that decides whether somebody's receipt ends up
// attached to somebody else's row.

// Dext's own export schema, which is also the one CYBills writes (see
// claimCsv/docsExport). The header row is matched by NAME rather than position:
// Dext offers a custom column set too, and a file with the columns in a
// different order must not silently load totals into the tax field.
export const DEXT_HEADERS = [
  'Receipt ID', 'Type', 'Date', 'Due Date', 'Invoice Number', 'Supplier',
  'Category', 'Customer', 'Project', 'Payment Method', 'Bank Account', 'Tax',
  'Total', 'Currency', 'Tax (SGD)', 'Total (SGD)', 'Status', 'Owner', 'Note',
  'Description', 'Image',
];

// A CSV reader that understands quotes, doubled quotes inside them, and both
// line endings. Small enough to own: a dependency here would have to be trusted
// with the one file somebody is migrating years of paperwork out of.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text ?? '').replace(/^﻿/, '');
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { endField(); continue; }
    if (c === '\r') { if (src[i + 1] === '\n') i += 1; endRow(); continue; }
    if (c === '\n') { endRow(); continue; }
    field += c;
  }
  // A trailing newline leaves an empty last row, which is not a record.
  if (field !== '' || row.length) endRow();
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

// "31-Aug-2026" (Dext's export format) → "2026-08-31", which is what a date
// input and every comparison here expects. Also accepts what is already ISO, and
// d/m/Y, because a spreadsheet round-trip often rewrites the column.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function isoDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const p2 = (n) => String(n).padStart(2, '0');
  let m = /^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ](\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mon ? `${m[3]}-${p2(mon)}-${p2(m[1])}` : '';
  }
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  // Day first: Dext is configured for Singapore and so is every client here.
  if (m) return `${m[3]}-${p2(m[2])}-${p2(m[1])}`;
  return '';
}

// A money column as CYBills stores it: a plain number, or '' when the cell is
// empty. Thousands separators and a currency symbol are stripped; a cell that
// isn't a number at all becomes '' rather than 0, because 0 is a claim about
// the money and '' is an admission that the file didn't say.
export function amount(raw) {
  const s = String(raw ?? '').trim().replace(/[^0-9.,-]/g, '');
  if (!s) return '';
  // A comma-decimal file ("1.234,56") is read by taking the LAST separator as
  // the decimal point.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalised = s;
  if (lastComma > lastDot) normalised = s.replace(/\./g, '').replace(',', '.');
  else normalised = s.replace(/,/g, '');
  const n = Number(normalised);
  return Number.isFinite(n) ? String(n) : '';
}

// The header row, mapped to its column index. Unknown columns are ignored and
// missing ones simply never resolve, so a narrower export still imports what it
// does carry.
function indexHeaders(header) {
  const at = {};
  header.forEach((h, i) => { at[String(h).trim().toLowerCase()] = i; });
  return (name) => {
    const i = at[String(name).trim().toLowerCase()];
    return i === undefined ? -1 : i;
  };
}

// Every row of a Dext export, as the fields CYBills stores. `receiptId` is kept
// alongside because it is what names the downloaded file.
export function parseDextExport(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], missing: DEXT_HEADERS.slice() };
  const [header, ...body] = rows;
  const col = indexHeaders(header);
  const missing = DEXT_HEADERS.filter((h) => col(h) === -1);
  const cell = (r, name) => {
    const i = col(name);
    return i === -1 ? '' : String(r[i] ?? '').trim();
  };
  const out = body.map((r, i) => ({
    line: i + 2, // the row's line in the file, for a message a person can act on
    receiptId: cell(r, 'Receipt ID'),
    supplier: cell(r, 'Supplier'),
    invoiceNumber: cell(r, 'Invoice Number'),
    date: isoDate(cell(r, 'Date')),
    dueDate: isoDate(cell(r, 'Due Date')),
    category: cell(r, 'Category'),
    customer: cell(r, 'Customer'),
    project: cell(r, 'Project'),
    paymentMethod: cell(r, 'Payment Method'),
    currency: cell(r, 'Currency'),
    total: amount(cell(r, 'Total')),
    tax: amount(cell(r, 'Tax')),
    note: cell(r, 'Note'),
    description: cell(r, 'Description'),
    // A NAME in Dext's export. The server resolves it to the one address that
    // person is on the roster under, and falls back to whoever is importing —
    // it is never stored as a name (see ownerForOrg).
    owner: cell(r, 'Owner'),
  }));
  return { rows: out, missing };
}

// A filename reduced to the digits in it, so "21616969450.pdf",
// "Receipt_21616969450 (1).PDF" and "21616969450-grab.jpg" all reach the same
// row. Dext names a bulk download by the document's own id; a person who has
// renamed things keeps whatever else they added around it.
const digitsIn = (name) => String(name ?? '').match(/\d{6,}/g) || [];

// Match each CSV row to the file it belongs to, BY ID and nothing else.
//
// Deliberately not by supplier, date or amount: several receipts from one
// supplier on one day for one amount is an ordinary Tuesday, and attaching the
// wrong image to a row is worse than attaching none — the figures would look
// right and the evidence behind them would be somebody else's. A row with no
// file still imports; it just arrives without its document, and is counted and
// named so nobody has to guess which ones.
export function matchFiles(rows, files) {
  const byId = new Map();
  for (const f of files || []) {
    for (const d of digitsIn(f.name)) {
      // Two files claiming one id is ambiguous, so neither is used.
      if (byId.has(d)) byId.set(d, null);
      else byId.set(d, f);
    }
  }
  const used = new Set();
  const pairs = (rows || []).map((row) => {
    const f = row.receiptId ? byId.get(row.receiptId) : undefined;
    if (f) used.add(f);
    return { row, file: f || null };
  });
  const spare = (files || []).filter((f) => !used.has(f));
  return {
    pairs,
    matched: pairs.filter((p) => p.file).length,
    withoutFile: pairs.filter((p) => !p.file).map((p) => p.row),
    spare,
  };
}

// One row as the body of POST /api/costs/bills. The fields Dext already
// decided are carried across as they are — that coding work is the whole reason
// to migrate rather than re-upload — and nothing is invented for a blank cell.
export function billPayload(row) {
  const put = (o, k, v) => { if (v) o[k] = v; };
  const body = { kind: 'cost', documentType: 'Receipt' };
  put(body, 'supplier', row.supplier);
  put(body, 'invoiceNumber', row.invoiceNumber);
  put(body, 'date', row.date);
  put(body, 'category', row.category);
  put(body, 'currency', row.currency);
  put(body, 'total', row.total);
  put(body, 'tax', row.tax);
  put(body, 'description', row.description);
  put(body, 'owner', row.owner);
  return body;
}

// The fields the create endpoint doesn't take, applied straight after. Empty
// when there are none, so an import of plain receipts makes one request each.
export function patchPayload(row) {
  const patch = {};
  if (row.paymentMethod) patch.paymentMethod = row.paymentMethod;
  if (row.customer) patch.customer = row.customer;
  if (row.project) patch.project = row.project;
  if (row.dueDate) patch.dueDate = row.dueDate;
  if (row.note) patch.note = row.note;
  return patch;
}
