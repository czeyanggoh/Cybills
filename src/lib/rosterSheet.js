// The Users roster as a spreadsheet: what an export carries, and what an edited
// one changes when it comes back.
//
// The point is assigning roles, direct managers, projects and privileges to a
// roster of two hundred people in Excel, where filling down a column is one
// drag, rather than in two hundred dialogs. So the sheet carries the editable
// fields as dropdowns (a Lists sheet holds the choices, a data validation
// points at it), and the columns that identify a person — name, email, company,
// status — ride along greyed out, for reading and for matching only.
//
// Nothing is ADDED or REMOVED by an import, and nobody's status changes: those
// each send mail or end somebody's access, and are a person's act on the page.
// An import says what would change, row by row, and saves nothing until the
// preview is confirmed.
//
// Pure: no React, no fetch. `npm test` at the root (`roster-sheet`).

export const YES = 'Yes';
export const NO = 'No';

// One column per field. `key` is how a header is recognised on the way back
// (so a column moved, renamed in case, or deleted is still handled: a missing
// column changes nothing). `readOnly` columns are never read for changes.
export const ROSTER_COLUMNS = [
  { key: 'name', header: 'Name', width: 26, readOnly: true },
  { key: 'email', header: 'Email', width: 32, readOnly: true },
  { key: 'company', header: 'Company', width: 24, readOnly: true },
  { key: 'status', header: 'Status', width: 12, readOnly: true },
  { key: 'login', header: 'Login access', width: 13 },
  { key: 'role', header: 'Role', width: 18 },
  { key: 'manager', header: 'Direct manager', width: 30 },
  { key: 'project', header: 'Project (PIC)', width: 22 },
  { key: 'accessAll', header: 'Access all documents', width: 20 },
  { key: 'createClaims', header: 'Create expense claims', width: 21 },
  { key: 'canPublish', header: 'Can publish to Xero', width: 19 },
  { key: 'id', header: 'User ID (do not change)', width: 26, readOnly: true },
];

const PRIVILEGES = ['accessAll', 'createClaims', 'canPublish'];

const LABEL = Object.fromEntries(ROSTER_COLUMNS.map((c) => [c.key, c.header]));
export const fieldLabel = (key) => LABEL[key] || key;

const norm = (v) => String(v ?? '').trim().toLowerCase();
const headerKey = (v) => norm(v).replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

export function statusOf(u) {
  if (u?.deactivated) return 'Deactivated';
  if (u?.pending) return 'Pending';
  return 'Active';
}

// Who can be somebody's direct manager — the page's own rule: anybody active,
// never the general account (a place documents land, not a person who approves).
export function managerCandidates(users) {
  return (users || []).filter((m) => !m.deactivated && !m.pending && !m.general);
}

// What a manager is CALLED in the sheet. Their name, unless two candidates
// share it — then the address goes with it, because a dropdown of two identical
// names hands somebody's claims to whichever was meant by nobody.
export function managerLabels(users) {
  const candidates = managerCandidates(users);
  const count = {};
  for (const m of candidates) count[norm(m.name)] = (count[norm(m.name)] || 0) + 1;
  const labels = new Map();
  for (const m of candidates) {
    labels.set(m.id, count[norm(m.name)] > 1 && m.email ? `${m.name} (${m.email})` : m.name || m.email || m.id);
  }
  return labels;
}

const yesNo = (v) => (v ? YES : NO);

// Rows ordered the way the page groups them: active, pending, deactivated,
// each A–Z.
function ordered(users) {
  const rank = (u) => (u.deactivated ? 2 : u.pending ? 1 : 0);
  return [...(users || [])].sort((a, b) => rank(a) - rank(b) || String(a.name || '').localeCompare(String(b.name || '')));
}

// The workbook to export: [{ name, columns, rows, validations, ... }] for
// `writeXlsx`. `roles` is what this entity offers; `projects` its project list;
// `company` what a row with no company of its own is shown under (the page does
// the same).
export function rosterWorkbook({ users, roles, projects = [], company = '' }) {
  const labels = managerLabels(users);
  const byId = new Map((users || []).map((u) => [u.id, u]));
  const managerOf = (u) => {
    if (!u.managerId) return '';
    return labels.get(u.managerId) || byId.get(u.managerId)?.name || '';
  };
  const rows = ordered(users).map((u) => {
    const p = u.privileges || {};
    const values = {
      name: u.name || '',
      email: u.email || '',
      company: u.companyName || company || '',
      status: statusOf(u),
      login: u.login === 'Yes' ? YES : NO,
      role: u.role || 'Standard',
      manager: managerOf(u),
      project: u.project || '',
      accessAll: yesNo(p.accessAll),
      createClaims: yesNo(p.createClaims),
      canPublish: yesNo(p.canPublish),
      id: u.id,
    };
    return ROSTER_COLUMNS.map((c) => values[c.key]);
  });

  const managerList = [...labels.values()].sort((a, b) => a.localeCompare(b));
  const lists = [
    { header: 'Roles', values: roles || [] },
    { header: 'Direct managers', values: managerList },
    { header: 'Projects', values: projects || [] },
    { header: 'Yes / No', values: [YES, NO] },
  ];
  const range = (i) => {
    const n = lists[i].values.length;
    const L = String.fromCharCode(65 + i);
    return n ? `Lists!$${L}$2:$${L}$${n + 1}` : '';
  };
  const col = (key) => ROSTER_COLUMNS.findIndex((c) => c.key === key);
  const validations = [
    { col: col('role'), source: range(0), error: 'Pick a role from the list.' },
    { col: col('manager'), source: range(1), error: 'Pick somebody from the list, or leave it blank for none.' },
    { col: col('project'), source: range(2), error: 'Pick a project from the list, or leave it blank for none.' },
    ...['login', ...PRIVILEGES].map((k) => ({ col: col(k), source: range(3), error: 'Yes or No.' })),
  ];
  const longest = Math.max(0, ...lists.map((l) => l.values.length));
  const listRows = Array.from({ length: longest }, (_, r) => lists.map((l) => l.values[r] ?? ''));

  return [
    { name: 'Users', columns: ROSTER_COLUMNS, rows, validations, frozen: true, autoFilter: true },
    { name: 'Lists', columns: lists.map((l) => ({ header: l.header, width: 30 })), rows: listRows },
  ];
}

// Yes / No in any of the spellings a spreadsheet produces. undefined for a
// blank (leave it as it is), null for something that is neither.
function readYesNo(v) {
  const s = norm(v);
  if (!s) return undefined;
  if (['yes', 'y', 'true', '1', 'on'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'off'].includes(s)) return false;
  return null;
}

// The sheet to read: the one called Users, else the first.
export function pickRosterSheet(sheets) {
  return (sheets || []).find((s) => norm(s.name) === 'users') || (sheets || [])[0] || null;
}

// What an edited sheet would change. `rows` are the sheet's rows (strings),
// header first. Returns:
//   changes:   [{ user, patch, diffs: [{ field, from, to }] }] — one per person
//   errors:    [{ row, name, message }] — rows that will NOT be applied
//   unchanged: how many recognised rows change nothing
// A row with any error is left out whole, so nobody is ever half-updated.
export function planRosterImport({ rows, users, rolesFor, projects = [] }) {
  const errors = [];
  const changes = [];
  let unchanged = 0;
  const all = rows || [];
  const headerAt = all.findIndex((r) => (r || []).some((c) => String(c ?? '').trim()));
  if (headerAt < 0) return { changes, errors: [{ row: 0, name: '', message: 'The sheet is empty.' }], unchanged };

  const keyOf = Object.fromEntries(ROSTER_COLUMNS.map((c) => [headerKey(c.header), c.key]));
  // Older or hand-made sheets: a few obvious alternatives.
  Object.assign(keyOf, { userid: 'id', id: 'id', manager: 'manager', project: 'project', login: 'login', canpublish: 'canPublish', publish: 'canPublish' });
  const at = {};
  (all[headerAt] || []).forEach((h, i) => {
    const k = keyOf[headerKey(h)];
    if (k && !(k in at)) at[k] = i;
  });
  if (!('id' in at) && !('email' in at)) {
    return {
      changes,
      errors: [{ row: headerAt + 1, name: '', message: 'No "User ID" or "Email" column — the sheet has to say who each row is. Export a fresh copy and edit that.' }],
      unchanged,
    };
  }

  const list = users || [];
  const byId = new Map(list.map((u) => [String(u.id), u]));
  const byEmail = new Map(list.filter((u) => u.email).map((u) => [norm(u.email), u]));
  const candidates = managerCandidates(list);
  const labels = managerLabels(list);
  const projectByName = new Map((projects || []).map((p) => [norm(p), p]));
  const seen = new Map();

  for (let r = headerAt + 1; r < all.length; r++) {
    const row = all[r] || [];
    const get = (k) => (k in at ? String(row[at[k]] ?? '').trim() : undefined);
    if (!row.some((c) => String(c ?? '').trim())) continue;
    const rowNo = r + 1;
    const id = get('id');
    const email = get('email');
    const user = (id && byId.get(id)) || (email && byEmail.get(norm(email))) || null;
    const name = user?.name || get('name') || email || '';
    const fail = (message) => errors.push({ row: rowNo, name, message });
    if (!user) {
      fail(
        id || email
          ? 'Not on this entity’s roster. An import only updates people who are already here — add them with Add a user first.'
          : 'No User ID or email, so there is nobody to update.'
      );
      continue;
    }
    if (seen.has(user.id)) {
      fail(`${user.name} is already on row ${seen.get(user.id)}; this row was skipped.`);
      continue;
    }
    seen.set(user.id, rowNo);

    const patch = {};
    const diffs = [];
    const problems = [];
    const note = (field, from, to) => diffs.push({ field, from, to });

    // Login access.
    const login = get('login');
    if (login !== undefined) {
      const want = readYesNo(login);
      const has = user.login === 'Yes';
      if (want === null) problems.push(`Login access "${login}" — use Yes or No.`);
      else if (want !== undefined && want !== has) {
        if (want && !user.email) problems.push('Login access can’t be turned on for somebody with no email address.');
        else if (user.general) problems.push('The general account can’t sign in.');
        else {
          patch.login = want ? 'Yes' : 'No';
          note('login', yesNo(has), yesNo(want));
        }
      }
    }

    // Role — only the roles this entity offers (plus the one they hold).
    const role = get('role');
    if (role) {
      const offered = rolesFor(user.role);
      const match = offered.find((x) => norm(x) === norm(role));
      if (!match) problems.push(`Role "${role}" isn’t offered here (${offered.join(', ')}).`);
      else if (match !== (user.role || 'Standard')) {
        patch.role = match;
        note('role', user.role || 'Standard', match);
      }
    }

    // Direct manager — blank is none. Read by the label the sheet offered, then
    // by a name only one candidate has, then by address.
    const manager = get('manager');
    if (manager !== undefined) {
      const currentLabel = user.managerId ? labels.get(user.managerId) || byId.get(user.managerId)?.name || '' : '';
      let wantId = '';
      if (manager && norm(manager) !== norm(currentLabel)) {
        const byLabel = candidates.filter((m) => norm(labels.get(m.id)) === norm(manager));
        const byName = candidates.filter((m) => norm(m.name) === norm(manager));
        const byMail = candidates.filter((m) => m.email && norm(m.email) === norm(manager));
        const hit = byLabel.length === 1 ? byLabel : byName.length === 1 ? byName : byMail.length === 1 ? byMail : [];
        if (hit.length === 1) wantId = hit[0].id;
        else if (byName.length > 1) problems.push(`More than one person is called "${manager}" — pick them from the dropdown, which adds their email.`);
        else problems.push(`Direct manager "${manager}" isn’t an active person on this roster.`);
      } else if (manager) {
        wantId = user.managerId || '';
      }
      if (wantId && wantId === user.id) problems.push('Nobody can be their own direct manager.');
      else if (!problems.length && wantId !== (user.managerId || '')) {
        if (user.general) problems.push('The general account approves nothing and has no manager.');
        else {
          patch.managerId = wantId;
          note('manager', currentLabel || '—', wantId ? labels.get(wantId) : '—');
        }
      }
    }

    // Project — blank is none; otherwise a name on the entity's list (or the
    // one already there, which may since have left the list).
    const project = get('project');
    if (project !== undefined) {
      const current = user.project || '';
      if (norm(project) !== norm(current)) {
        const known = project ? projectByName.get(norm(project)) : '';
        if (project && !known) problems.push(`Project "${project}" isn’t on this entity’s project list.`);
        else {
          patch.project = known || '';
          note('project', current || '—', known || '—');
        }
      }
    }

    // Privileges — sent whole, since the route replaces the object.
    const priv = { accessAll: false, createClaims: false, canPublish: false, ...(user.privileges || {}) };
    let privChanged = false;
    for (const k of PRIVILEGES) {
      const v = get(k);
      if (v === undefined) continue;
      const want = readYesNo(v);
      if (want === null) problems.push(`${fieldLabel(k)} "${v}" — use Yes or No.`);
      else if (want !== undefined && want !== Boolean(priv[k])) {
        note(k, yesNo(priv[k]), yesNo(want));
        priv[k] = want;
        privChanged = true;
      }
    }
    if (privChanged) patch.privileges = priv;

    if (problems.length) {
      fail(problems.join(' '));
      continue;
    }
    if (diffs.length) changes.push({ user, patch, diffs });
    else unchanged += 1;
  }
  return { changes, errors, unchanged };
}

// "red-alpha-st-engineering-users-2026-10-17.xlsx".
export function rosterFileName(orgName, today = new Date()) {
  const slug = String(orgName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return `${slug || 'cybills'}-users-${d}.xlsx`;
}
