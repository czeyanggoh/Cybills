// A bridge entity's category list, round-tripped through Excel.
//
// "Red Alpha - SMRT" was set up like "Red Alpha - ST Engineering" and so came
// with ST Engineering's claim-form categories, while SMRT wants five. Doing that
// by ticking and deleting rows works, but the person who knows the list is
// usually holding it in a spreadsheet already. So the file IS the list: export
// it, edit it (add rows, delete rows, set Posts to and Visible), import it, see
// what it would change, confirm.
//
// Pure: the page reads and writes the workbook (src/lib/xlsx.js) and applies the
// plan (listsStore.applyListPlan + categoryAccounts.setCategoryAccounts).

import { categoryCode } from './categoryList.js';

export const YES = 'Yes';
export const NO = 'No';

export const CATEGORY_COLUMNS = [
  { key: 'name', header: 'Name', width: 40 },
  { key: 'postsTo', header: 'Posts to', width: 40 },
  { key: 'visible', header: 'Visible', width: 10 },
];

const norm = (v) => String(v ?? '').trim().toLowerCase();

// --- In use: archive, never delete -------------------------------------------
// A category a document or a claim line already carries is part of that
// record, so it is never deleted: it is ARCHIVED (Visible off) — gone from the
// pickers and the reader, still on the list with its Posts to, so what was
// coded to it can still be read and published. Only a category nothing has
// used is deleted outright.

// The category names used anywhere in `docs` and `claims` (their lines), as a
// set of normalised names.
export function usedCategoryNames(docs = [], claims = []) {
  const out = new Set();
  for (const d of docs || []) if (d?.category) out.add(norm(d.category));
  for (const c of claims || []) {
    for (const t of c?.transactions || []) if (t?.category) out.add(norm(t.category));
  }
  return out;
}

// Split rows being taken off the list: { remove: unused rows, archive: used ones }.
export function splitRemovals(rows = [], used = new Set()) {
  const remove = [];
  const archive = [];
  for (const r of rows) (used.has(norm(r.name)) ? archive : remove).push(r);
  return { remove, archive };
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// `rows`: the list as the page shows it ([{ id, name, visible }]); `map`:
// { name: code }; `accounts`: the parent's postable accounts ([{ code, name }]).
export function categoryWorkbook({ rows = [], map = {}, accounts = [] }) {
  const byCode = new Map(accounts.map((a) => [String(a.code), `${a.code} - ${a.name}`]));
  const label = (code) => (code ? byCode.get(String(code)) || String(code) : '');
  const data = rows.map((r) => [r.name, label(map[r.name]), r.visible ? YES : NO]);
  const accountLabels = accounts.map((a) => `${a.code} - ${a.name}`);
  const lists = [
    { header: 'Accounts', values: accountLabels },
    { header: 'Yes / No', values: [YES, NO] },
  ];
  const range = (i) => {
    const n = lists[i].values.length;
    const L = String.fromCharCode(65 + i);
    return n ? `Lists!$${L}$2:$${L}$${n + 1}` : '';
  };
  // Room below the list for new rows, so a pasted category gets the dropdowns too.
  const padded = [...data, ...Array.from({ length: 50 }, () => ['', '', ''])];
  const longest = Math.max(0, ...lists.map((l) => l.values.length));
  return [
    {
      name: 'Categories',
      columns: CATEGORY_COLUMNS,
      rows: padded,
      validations: [
        { col: 1, source: range(0), error: 'Pick an account from the list, or leave it blank for not mapped.' },
        { col: 2, source: range(1), error: 'Yes or No.' },
      ],
      frozen: true,
    },
    { name: 'Lists', columns: lists.map((l) => ({ header: l.header, width: 40 })), rows: Array.from({ length: longest }, (_, r) => lists.map((l) => l.values[r] ?? '')) },
  ];
}

export function pickCategorySheet(sheets) {
  return (sheets || []).find((s) => norm(s.name) === 'categories') || (sheets || [])[0] || null;
}

function readYesNo(v) {
  const s = norm(v);
  if (!s) return true; // blank = shown
  if (['yes', 'y', 'true', '1', 'on'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'off'].includes(s)) return false;
  return null;
}

// What the file would do to the list.
//   sheetRows: the sheet's rows (strings), header first
//   rows, map: the list and its mappings now
//   accounts:  the parent's postable accounts, or [] when they could not be
//              loaded (then a Posts to is taken on its code alone)
// Returns { add: [{ name, visible }], remove: [row], visibility: { id: bool },
//   accounts: { name: code }, diffs: [{ name, field, from, to }], errors:
//   [{ row, name, message }], unchanged }.
// The file is the WHOLE list: a category not in it is deleted — or, where a
// document or claim already uses it (`used`), archived instead. A file with no
// category in it at all is refused rather than read as "delete everything".
export function planCategoryImport({ sheetRows = [], rows = [], map = {}, accounts = [], used = new Set() }) {
  const out = { add: [], remove: [], visibility: {}, accounts: {}, diffs: [], errors: [], unchanged: 0 };
  const [header = [], ...body] = sheetRows;
  const col = (label) => header.findIndex((h) => norm(h) === label);
  const iName = col('name');
  const iPosts = col('posts to');
  const iVisible = col('visible');
  if (iName === -1) {
    out.errors.push({ row: 1, name: '', message: 'No "Name" column — export the list first and edit that file.' });
    return out;
  }
  const codes = new Set(accounts.map((a) => String(a.code)));
  const byName = new Map(rows.map((r) => [norm(r.name), r]));
  const seen = new Set();
  let listed = 0;

  body.forEach((cells, i) => {
    const rowNo = i + 2;
    const name = clean(cells[iName]);
    const postsRaw = iPosts === -1 ? undefined : clean(cells[iPosts]);
    const visRaw = iVisible === -1 ? '' : cells[iVisible];
    if (!name) {
      if (postsRaw || clean(visRaw)) out.errors.push({ row: rowNo, name: '', message: 'Has no name, so it was skipped.' });
      return;
    }
    listed += 1;
    const key = norm(name);
    if (seen.has(key)) {
      out.errors.push({ row: rowNo, name, message: 'Listed twice — only the first is used.' });
      return;
    }
    seen.add(key);
    const visible = readYesNo(visRaw);
    if (visible === null) {
      out.errors.push({ row: rowNo, name, message: `Visible "${clean(visRaw)}" is not Yes or No.` });
      return;
    }
    // "493 - Travel - National" or a bare "493". undefined = column absent: leave it.
    let code;
    if (postsRaw !== undefined) {
      code = postsRaw ? categoryCode(postsRaw) || (/^[A-Za-z0-9./-]{1,15}$/.test(postsRaw) && /\d/.test(postsRaw) ? postsRaw : '') : '';
      if (postsRaw && !code) {
        out.errors.push({ row: rowNo, name, message: `Posts to "${postsRaw}" is not an account.` });
        return;
      }
      if (code && codes.size && !codes.has(code)) {
        out.errors.push({ row: rowNo, name, message: `Account ${code} is not in the parent's chart.` });
        return;
      }
    }
    const current = byName.get(key);
    let changed = false;
    if (!current) {
      out.add.push({ name, visible });
      out.diffs.push({ name, field: 'Category', from: '', to: 'Added' });
      changed = true;
    } else if (current.visible !== visible) {
      out.visibility[current.id] = visible;
      out.diffs.push({ name: current.name, field: 'Visible', from: current.visible ? YES : NO, to: visible ? YES : NO });
      changed = true;
    }
    const finalName = current ? current.name : name;
    const was = String(map[finalName] || '');
    if (code !== undefined && code !== was) {
      out.accounts[finalName] = code;
      out.diffs.push({ name: finalName, field: 'Posts to', from: was || 'Not mapped', to: code || 'Not mapped' });
      changed = true;
    }
    if (!changed) out.unchanged += 1;
  });

  if (!listed) {
    out.errors.push({ row: 2, name: '', message: 'The file lists no categories — nothing was changed.' });
    return { ...out, add: [], remove: [], visibility: {}, accounts: {}, diffs: [] };
  }
  const { remove, archive } = splitRemovals(rows.filter((r) => !seen.has(norm(r.name))), used);
  for (const r of remove) {
    out.remove.push(r);
    out.diffs.push({ name: r.name, field: 'Category', from: 'In the list', to: 'Deleted' });
  }
  for (const r of archive) {
    if (!r.visible) continue; // archived already
    out.visibility[r.id] = false;
    out.diffs.push({ name: r.name, field: 'Category', from: 'In the list', to: 'Archived — used on documents, so not deleted' });
  }
  return out;
}

export function categoryFileName(orgName, today = new Date()) {
  const slug = String(orgName || 'entity').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'entity';
  const d = today.toISOString().slice(0, 10);
  return `${slug}-categories-${d}.xlsx`;
}
