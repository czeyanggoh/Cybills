import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeXlsx, readXlsx } from '../src/lib/xlsx.js';
import { rosterWorkbook, planRosterImport, pickRosterSheet, managerLabels, rosterFileName, ROSTER_COLUMNS } from '../src/lib/rosterSheet.js';

const ROLES = ['Business Admin', 'User Admin', 'Standard'];
const rolesFor = (current) => (current === 'Reporting Officer' ? [...ROLES, 'Reporting Officer'] : ROLES);

// The roster the fixture under test/fixtures was exported from.
export const USERS = [
  { id: 'u1', name: 'Zhen Lin Wong', email: 'wong.zhenlin@stengg.com', login: 'Yes', role: 'Standard', privileges: {} },
  { id: 'u2', name: 'Zong Yi Ong', email: 'zongyi.ong@redalphacyber.com', login: 'Yes', role: 'Standard', managerId: 'u1' },
  { id: 'u3', name: 'Yvette Kiah', email: 'yvette.kiah@redalphacyber.com', login: 'No', role: 'Standard', privileges: { accessAll: true } },
  { id: 'u4', name: 'Tan Wei', email: 'tan.wei@a.com', login: 'Yes', role: 'Business Admin' },
  { id: 'u5', name: 'Tan Wei', email: 'tan.wei@b.com', login: 'Yes', role: 'Standard' },
  { id: 'g', name: 'General', email: '', login: 'No', role: 'Standard', general: true },
  { id: 'u6', name: 'Left Already', email: 'gone@x.com', login: 'Yes', role: 'Standard', deactivated: true },
];
const PROJECTS = ['Tangs', 'Vivo City', '0012'];

// --- Export ---------------------------------------------------------------------
const book = rosterWorkbook({ users: USERS, roles: ROLES, projects: PROJECTS, company: 'Red Alpha - ST Engineering' });
const [users, lists] = book;
assert.equal(users.name, 'Users');
assert.equal(users.rows.length, USERS.length);
// Active first, A–Z; the deactivated row last.
assert.equal(users.rows.at(-1)[0], 'Left Already');
const col = (key) => ROSTER_COLUMNS.findIndex((c) => c.key === key);
const row = (id) => users.rows.find((r) => r[col('id')] === id);
assert.equal(row('u2')[col('manager')], 'Zhen Lin Wong');
assert.equal(row('u3')[col('accessAll')], 'Yes');
assert.equal(row('u3')[col('login')], 'No');
assert.equal(row('u1')[col('company')], 'Red Alpha - ST Engineering');
assert.equal(row('u6')[col('status')], 'Deactivated');
// Two candidates called Tan Wei are told apart by address; the general account
// and the deactivated are no candidates at all.
const labels = managerLabels(USERS);
assert.equal(labels.get('u4'), 'Tan Wei (tan.wei@a.com)');
assert.equal(labels.get('g'), undefined);
assert.equal(labels.get('u6'), undefined);
assert.equal(lists.name, 'Lists');
assert.deepEqual(lists.rows.map((r) => r[3]).filter(Boolean), ['Yes', 'No']);
assert.ok(users.validations.some((v) => v.source === 'Lists!$A$2:$A$4'));

// --- Round trip through our own writer --------------------------------------------
const bytes = writeXlsx(book);
const back = await readXlsx(bytes);
assert.deepEqual(back.map((s) => s.name), ['Users', 'Lists']);
assert.equal(pickRosterSheet(back).name, 'Users');
const sheet = pickRosterSheet(back).rows;
assert.deepEqual(sheet[0], ROSTER_COLUMNS.map((c) => c.header));
// Text survives as text: a project called 0012 is not the number 12.
const edited = sheet.map((r) => [...r]);
const at = (id) => edited.findIndex((r) => r[col('id')] === id);
edited[at('u1')][col('project')] = '0012';
const plan0 = planRosterImport({ rows: edited, users: USERS, rolesFor, projects: PROJECTS });
assert.equal(plan0.changes.length, 1);
assert.deepEqual(plan0.changes[0].patch, { project: '0012' });
// Untouched, nothing changes.
const none = planRosterImport({ rows: sheet, users: USERS, rolesFor, projects: PROJECTS });
assert.deepEqual(none, { changes: [], errors: [], unchanged: USERS.length });

// --- Planning edits -------------------------------------------------------------
{
  const rows = sheet.map((r) => [...r]);
  const set = (id, key, v) => (rows[rows.findIndex((r) => r[col('id')] === id)][col(key)] = v);
  set('u1', 'role', 'user admin'); // case doesn't matter
  set('u2', 'manager', ''); // blank clears
  set('u3', 'manager', 'Tan Wei (tan.wei@a.com)');
  set('u3', 'createClaims', 'TRUE');
  set('u5', 'manager', 'Tan Wei'); // two of them
  set('u4', 'role', 'Owner'); // not a role here
  set('g', 'manager', 'Zhen Lin Wong');
  set('u1', 'login', 'maybe');
  const plan = planRosterImport({ rows, users: USERS, rolesFor, projects: PROJECTS });
  const byId = Object.fromEntries(plan.changes.map((c) => [c.user.id, c]));
  assert.deepEqual(byId.u2.patch, { managerId: '' });
  assert.deepEqual(byId.u3.patch, { managerId: 'u4', privileges: { accessAll: true, createClaims: true, canPublish: false } });
  assert.deepEqual(byId.u3.diffs.map((d) => d.field), ['manager', 'createClaims']);
  // A row with ANY problem is left out whole — u1's valid role change with it.
  assert.equal(byId.u1, undefined);
  const err = (name) => plan.errors.find((e) => e.name === name)?.message || '';
  assert.match(err('Zhen Lin Wong'), /Login access "maybe"/);
  assert.match(plan.errors.find((e) => e.message.includes('More than one person'))?.message || '', /Tan Wei/);
  assert.match(plan.errors.find((e) => e.message.includes('"Owner"'))?.message || '', /isn’t offered/);
  assert.match(err('General'), /general account/);
}

// Matching falls back to the address, a deleted column changes nothing, a
// stranger is refused, and a person twice is read once.
{
  const rows = [
    ['Email', 'Role'],
    ['YVETTE.KIAH@redalphacyber.com', 'Business Admin'],
    ['nobody@x.com', 'Standard'],
    ['yvette.kiah@redalphacyber.com', 'Standard'],
  ];
  const plan = planRosterImport({ rows, users: USERS, rolesFor, projects: PROJECTS });
  assert.deepEqual(plan.changes.map((c) => [c.user.id, c.patch]), [['u3', { role: 'Business Admin' }]]);
  assert.equal(plan.errors.length, 2);
  assert.match(plan.errors[0].message, /Not on this entity/);
  assert.match(plan.errors[1].message, /already on row 2/);
}
// Login can't be switched on with no address; nobody manages themselves.
{
  const rows = [
    ['User ID', 'Login access', 'Direct manager'],
    ['g', 'Yes', ''],
    ['u1', '', 'Zhen Lin Wong'],
  ];
  const plan = planRosterImport({ rows, users: USERS, rolesFor });
  assert.equal(plan.changes.length, 0);
  assert.match(plan.errors[0].message, /no email/);
  assert.match(plan.errors[1].message, /own direct manager/);
}
// A sheet that cannot say who anybody is.
assert.match(planRosterImport({ rows: [['Name', 'Role'], ['X', 'Standard']], users: USERS, rolesFor }).errors[0].message, /No "User ID" or "Email"/);

// --- A file saved by another program ----------------------------------------------
// test/fixtures/roster-edited.xlsx is the export above, copied cell by cell into
// a new workbook by openpyxl — deflated entries, its own part names, the Lists
// sheet FIRST, a real boolean cell — with Yvette made a User Admin, Zong Yi's
// manager set to Yvette, Zhen Lin's "Create expense claims" typed as TRUE and a
// read-only column scribbled on.
{
  const saved = await readXlsx(readFileSync(new URL('./fixtures/roster-edited.xlsx', import.meta.url)));
  assert.deepEqual(saved.map((s) => s.name), ['Lists', 'Users']);
  const plan = planRosterImport({ rows: pickRosterSheet(saved).rows, users: USERS, rolesFor, projects: PROJECTS });
  assert.deepEqual(
    plan.changes.map((c) => [c.user.id, c.patch]),
    [
      ['u3', { role: 'User Admin' }],
      ['u1', { privileges: { accessAll: false, createClaims: true, canPublish: false } }],
      ['u2', { managerId: 'u3' }],
    ]
  );
  assert.deepEqual(plan.errors, []);
}

// Excel itself writes text to a shared-strings table and deflates every part,
// with rich-text runs and phonetic guides inside a string. Built by hand here.
{
  const enc = new TextEncoder();
  const files = {
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Users" sheetId="1" r:id="rId7"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Target="/xl/worksheets/s.xml" Type="x" Id="rId7"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst count="4"><si><t>User ID</t></si><si><r><rPr><b/></rPr><t>Ro</t></r><r><t xml:space="preserve">le</t></r></si><si><t>Business&#32;Admin</t><rPh><t>x</t></rPh></si><si><t>u3</t></si></sst>',
    'xl/worksheets/s.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="4"><c r="A4" t="s"><v>3</v></c><c r="C4" t="s"><v>2</v></c></row></sheetData></worksheet>',
  };
  const { deflateRawSync, crc32 } = await import('node:zlib');
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = deflateRawSync(raw);
    const n = enc.encode(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc32(raw), 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const [s] = await readXlsx(Buffer.concat([...local, cd, end]));
  assert.deepEqual(s.rows, [['User ID', '', 'Role'], [], [], ['u3', '', 'Business Admin']]);
  const plan = planRosterImport({ rows: s.rows, users: USERS, rolesFor });
  assert.deepEqual(plan.changes.map((c) => [c.user.id, c.patch]), [['u3', { role: 'Business Admin' }]]);
}

await assert.rejects(readXlsx(new TextEncoder().encode('Name,Role\nX,Standard')), /not_xlsx/);

assert.equal(rosterFileName('Red Alpha - ST Engineering', new Date(2026, 9, 17)), 'red-alpha-st-engineering-users-2026-10-17.xlsx');

console.log('roster-sheet: ok');
