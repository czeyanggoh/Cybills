// Which activity-log lines are approval history, and which are editing noise.
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const src = readFileSync(new URL('../src/lib/approvalHistory.js', import.meta.url), 'utf8');
const { isApprovalEvent, approvalHistory } = await import(
  `data:text/javascript,${encodeURIComponent(src)}`
);

let pass = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('PASS ', name);
  pass += 1;
};

// The exact phrases server/src/claims.ts writes.
const APPROVAL_LINES = [
  'This claim was submitted for approval to Sefi Krishberg',
  'This claim was approved by Cze Yang Goh',
  'This claim was rejected by Cze Yang Goh',
];
const DISPOSITION_LINES = [
  'This claim was emailed to Sefi Krishberg (sefi@example.com)',
  'Sent to CYHR for payment',
  'This claim was published to Red Alpha Cybersecurity Pte. Ltd.',
];
const EDITING_LINES = [
  'This expense claim was created',
  'This expense claim was created automatically for the period ending July 2026',
  'Item 260822144031 was added to the expense claim',
  '5 item(s) added automatically',
  '2 item(s) removed from the expense claim',
  '3 item(s) bulk-edited',
  'End date set to 2026-07-31',
];

for (const t of APPROVAL_LINES) ok(`approval kept: ${t.slice(0, 40)}`, isApprovalEvent({ text: t }));
for (const t of DISPOSITION_LINES) ok(`disposition kept: ${t.slice(0, 40)}`, isApprovalEvent({ text: t }));
for (const t of EDITING_LINES) ok(`editing dropped: ${t.slice(0, 40)}`, !isApprovalEvent({ text: t }));

// The reported case: a draft claim whose whole log is items being added.
const draft = [
  { text: 'Item 260822144031 was added to the expense claim', by: 'Cze Yang Goh' },
  { text: 'Item 260822144032 was added to the expense claim', by: 'Cze Yang Goh' },
  { text: 'This expense claim was created', by: 'Cze Yang Goh' },
];
ok('a never-submitted claim has no approval history', approvalHistory(draft).length === 0);

// A submitted-and-approved claim keeps its two lines, in order, and loses the rest.
const full = [
  { text: 'This claim was approved by Cze Yang Goh' },
  { text: '3 item(s) bulk-edited' },
  { text: 'This claim was submitted for approval to Cze Yang Goh' },
  { text: 'Item 260822144031 was added to the expense claim' },
  { text: 'This expense claim was created' },
];
const kept = approvalHistory(full);
ok('approved claim keeps exactly its approval lines', kept.length === 2);
ok('order is preserved', /approved/.test(kept[0].text) && /submitted/.test(kept[1].text));

// Robustness: the helper takes plain strings and survives junk.
ok('plain strings work', isApprovalEvent('This claim was approved by X'));
ok('undefined is not an approval event', !isApprovalEvent(undefined));
ok('a non-array yields nothing', approvalHistory(null).length === 0);
// An unrecognised line is treated as editing — the safe direction for a signed
// document (a missing line is noticed; an invented one is not).
ok('an unknown line is left off', !isApprovalEvent({ text: 'Something new happened' }));

console.log(`\nall passing (${pass})`);
