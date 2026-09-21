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

// Dext's category labels carry the account's tax rate on the end — "310 -
// Manpower Cost (0%)". That is an annotation, not part of the name: the chart
// says "310 - Manpower Cost", so a category imported with the suffix matches
// nothing and publishes nowhere. Only a trailing percentage is taken off, so a
// name that genuinely ends in brackets keeps them.
export function cleanCategory(raw) {
  return String(raw ?? '').replace(/\s*\(\d+(?:\.\d+)?%\)\s*$/, '').trim();
}

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
  // Dext's screens call the id "Item ID" and its standard export "Receipt ID";
  // a custom column set may use either, and they are one column.
  const missing = DEXT_HEADERS.filter((h) => col(h) === -1 && !(h === 'Receipt ID' && col('Item ID') !== -1));
  const cell = (r, name) => {
    const i = col(name);
    return i === -1 ? '' : String(r[i] ?? '').trim();
  };
  const out = body.map((r, i) => ({
    line: i + 2, // the row's line in the file, for a message a person can act on
    receiptId: cell(r, 'Receipt ID') || cell(r, 'Item ID'),
    supplier: cell(r, 'Supplier'),
    invoiceNumber: cell(r, 'Invoice Number'),
    date: isoDate(cell(r, 'Date')),
    dueDate: isoDate(cell(r, 'Due Date')),
    category: cleanCategory(cell(r, 'Category')),
    // Dext prints the code it used ("NONE"), which is what CYBills stores.
    taxRate: cell(r, 'Tax Code'),
    documentType: cell(r, 'Type'),
    // "claimed" is how an item on an expense claim says so (see planClaims).
    status: cell(r, 'Status'),
    customer: cell(r, 'Customer'),
    project: cell(r, 'Project'),
    paymentMethod: cell(r, 'Payment Method'),
    currency: cell(r, 'Currency'),
    total: amount(cell(r, 'Total')),
    tax: amount(cell(r, 'Tax')),
    // A foreign-currency document says twice what it is worth: once in its own
    // currency and once restated. Both are kept — a total without the currency
    // it is in is not half an answer but a wrong one.
    baseTotal: amount(cell(r, 'Total (SGD)')),
    baseTax: amount(cell(r, 'Tax (SGD)')),
    note: cell(r, 'Note'),
    description: cell(r, 'Description'),
    image: cell(r, 'Image'),
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

// The Dext Item IDs this entity already holds, from the documents listing.
// A document imported since the ID was stored carries it as `dextId`; one
// imported before carries it only in its file name ("21616969450", or the
// downloaded file's own name), so a document with no `dextId` offers the whole
// digit runs of its name. Mirrors `billByDextId` in server/src/store.ts, which
// has the last word. A deleted document is not held: removing one must not make
// it impossible to bring back.
export function importedDextIds(bills) {
  const ids = new Set();
  for (const b of bills || []) {
    if (!b || b.status === 'deleted') continue;
    if (b.dextId) ids.add(String(b.dextId));
    else for (const d of digitsIn(b.fileName)) ids.add(d);
  }
  return ids;
}

// Which rows to import, by Item ID and nothing else. A row whose ID is already
// in the book is skipped, and so is the second row of one ID inside the same
// file (an export taken over overlapping ranges repeats rows). A row with no ID
// cannot be told apart from anything, so it is imported, as it always was.
export function planImport(rows, existingIds) {
  const held = existingIds || new Set();
  const seen = new Set();
  const toImport = [];
  const alreadyImported = [];
  const repeated = [];
  for (const row of rows || []) {
    const id = row.receiptId;
    if (id && held.has(id)) alreadyImported.push(row);
    else if (id && seen.has(id)) repeated.push(row);
    else {
      if (id) seen.add(id);
      toImport.push(row);
    }
  }
  return { toImport, alreadyImported, repeated };
}

// One row as the body of POST /api/costs/bills. The fields Dext already
// decided are carried across as they are — that coding work is the whole reason
// to migrate rather than re-upload — and nothing is invented for a blank cell.
export function billPayload(row) {
  const put = (o, k, v) => { if (v) o[k] = v; };
  // Dext's own word for what the document is ("Receipt", "Invoice",
  // "Statement/remittance advice"), kept rather than flattened: it is a fact
  // somebody established about the paperwork.
  const body = { kind: 'cost', documentType: row.documentType || 'Receipt' };
  // Stored on the document, so the next import of an overlapping export skips
  // this row (see planImport) and the server refuses it if the screen did not.
  put(body, 'dextId', row.receiptId);
  put(body, 'supplier', row.supplier);
  put(body, 'invoiceNumber', row.invoiceNumber);
  put(body, 'date', row.date);
  put(body, 'category', row.category);
  put(body, 'currency', row.currency);
  put(body, 'total', row.total);
  put(body, 'tax', row.tax);
  put(body, 'description', row.description);
  put(body, 'taxRate', row.taxRate);
  put(body, 'owner', row.owner);
  // Only when the document is in another currency: the restatement is the pair
  // (what it is worth here, in what), and on an SGD document it says nothing.
  if (row.baseTotal && row.currency && row.currency.toUpperCase() !== 'SGD') {
    body.baseCurrency = 'SGD';
    body.baseTotal = row.baseTotal;
    if (row.baseTax) body.baseTax = row.baseTax;
  }
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

// --- Expense claims -------------------------------------------------------------
// Dext exports a claim as a row of its own — Type "Expense claim", the claimant
// in Supplier and Owner, the claim's total — and its items as ordinary rows
// with Status "claimed". Nothing in either file says WHICH claim an item was
// on, so the link is rebuilt from the only two facts both carry: the person
// (Owner) and the money. A claim takes that person's claimed items only where
// they add up to its total TO THE CENT, and only where exactly one set of them
// does — two sets that fit is a choice, and putting a receipt on the wrong
// claim pays it under the wrong period. Anything unsettled is left off a claim
// and named, and its items still import as ordinary documents.

// Dext also types an ordinary receipt raised through its expense app
// "Expense claim", so the Type alone does not make a row the claim. The claim
// itself is the one that names a PERSON as its supplier (the claimant, the same
// name as its Owner) and carries no category or invoice number of its own.
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
export const isClaimRow = (row) =>
  /^expense claim$/i.test(String(row?.documentType ?? '').trim())
  && !row.category && !row.invoiceNumber
  && (!row.supplier || !row.owner || sameName(row.supplier, row.owner));
const isClaimedItem = (row) => !isClaimRow(row) && /^claimed$/i.test(String(row?.status ?? '').trim());

// What a row is worth in SGD cents: the restatement where there is one (an AUD
// receipt on an SGD claim counts at its SGD figure, which is what Dext summed),
// else its own total.
const cents = (row) => {
  const v = row.baseTotal ? row.baseTotal : row.total;
  const n = Number(v);
  return v && Number.isFinite(n) ? Math.round(n * 100) : null;
};
const personKey = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Every way to hand each claim a disjoint set of `items` summing to its total,
// stopping at two — all that is needed is "none", "exactly one" or "several".
// Items of one amount are interchangeable in the sum but not as evidence: two
// 10.00 receipts are two different documents, so that counts as several.
const MAX_ITEMS = 24;
function assignments(claims, items) {
  const found = [];
  const pick = (ci, free, acc) => {
    if (found.length > 1) return;
    if (ci === claims.length) { found.push(acc); return; }
    const want = cents(claims[ci]);
    const walk = (start, sum, chosen) => {
      if (found.length > 1) return;
      if (sum === want && chosen.length) {
        const taken = new Set(chosen);
        pick(ci + 1, free.filter((i) => !taken.has(i)), [...acc, chosen]);
        return;
      }
      for (let k = start; k < free.length; k += 1) {
        const c = cents(free[k]);
        if (c === null || c <= 0 || sum + c > want) continue;
        walk(k + 1, sum + c, [...chosen, free[k]]);
      }
    };
    walk(0, 0, []);
  };
  pick(0, items, []);
  return found;
}

export function planClaims(rows) {
  const claimRows = (rows || []).filter(isClaimRow);
  const byPerson = new Map();
  for (const row of rows || []) {
    if (!isClaimedItem(row)) continue;
    const k = personKey(row.owner);
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k).push(row);
  }
  const people = new Map();
  for (const c of claimRows) {
    const k = personKey(c.owner || c.supplier);
    if (!people.has(k)) people.set(k, []);
    people.get(k).push(c);
  }
  const claims = [];
  const unmatched = [];
  for (const [k, theirs] of people) {
    const usable = theirs.filter((c) => k && (cents(c) ?? 0) > 0);
    theirs.filter((c) => !usable.includes(c)).forEach((c) => unmatched.push({ row: c, reason: 'no_total' }));
    if (!usable.length) continue;
    const items = byPerson.get(k) || [];
    const fail = (reason) => usable.forEach((c) => unmatched.push({ row: c, reason }));
    if (!items.length) { fail('no_items'); continue; }
    if (items.length > MAX_ITEMS) { fail('too_many'); continue; }
    const ways = assignments(usable, items);
    if (ways.length === 1) {
      usable.forEach((c, i) => claims.push({ row: c, claimFor: c.owner || c.supplier, items: ways[0][i] }));
    } else fail(ways.length ? 'ambiguous' : 'no_match');
  }
  return { claims, unmatched, claimRows };
}

// What the claim is called here. It carries the Dext Item ID so a second import
// of the same export recognises it (importedClaimIds) — a claim has no field of
// its own for that, and a person reading the name loses nothing.
export const claimName = (row) => `Expense claim (Dext ${row.receiptId})`;

export function importedClaimIds(claims) {
  const ids = new Set();
  for (const c of claims || []) {
    if (c?.deleted) continue;
    const m = /\(Dext (\d+)\)/.exec(String(c?.name ?? ''));
    if (m) ids.add(m[1]);
  }
  return ids;
}
