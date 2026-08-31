// A claim's name is repaired on EVERY read, not once per server boot.
//
// The repair itself was right and tested (identity.test.mts): a name that was
// folded away resolves to the person it became. What was wrong is WHEN it ran.
// It lived inside the one-shot orgId backfill, so it got a single attempt per
// process — spent on the first claims read after boot, which is before anybody
// has folded a duplicate away. Every read after that was skipped, so a claim
// went on naming somebody merged away hours earlier and only a deploy ever
// looked again. It was reported as the old name "coming back"; it had never
// been repaired at all.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-claimname-'));
process.env.BILLS_DATA_DIR = DATA_DIR;

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org_one0001', orgId: 'cybm', name: 'CYBM', tenantId: 't-1', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);
const claim = (id: string, claimFor: string, approver = '') => ({
  id, workspaceId: 'cybm', orgId: 'cybm', claimFor, approver, name: 'Expense claim', type: 'Regular',
  currency: 'SGD', total: '68.90', tax: '0.00', transactions: [], history: [], createdAt: new Date(0).toISOString(),
});
// c4 carries the SAME name written with a stray double space — one input box
// preserves it, every heading and table cell collapses it, so it looks
// identical everywhere a person would notice.
// c5's name belongs to nobody at all: the row was deleted outright rather than
// folded, so there is no trail left to match it against — only its receipts,
// which are owned by an address.
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({ items: [
    claim('c1', 'rowan rowan'),
    claim('c2', 'Wren Tester', 'rowan rowan'),
    claim('c3', 'Nobody At All'),
    claim('c4', 'rowan  rowan'),
    { ...claim('c5', 'Vanished Entirely'), transactions: [{ itemId: 'b1' }, { itemId: 'b2' }] },
    { ...claim('c6', 'Vanished Entirely'), transactions: [{ itemId: 'b1' }, { itemId: 'b3' }] },
  ] })
);
// Two receipts owned by one address, and a third owned by somebody else.
writeFileSync(
  join(DATA_DIR, 'bills.json'),
  JSON.stringify({ bills: [
    { id: 'b1', orgId: 'cybm', owner: 'astridy2004@gmail.com', supplier: 'Grab', total: '10.00' },
    { id: 'b2', orgId: 'cybm', owner: 'AstridY2004@Gmail.com ', supplier: 'Grab', total: '10.00' },
    { id: 'b3', orgId: 'cybm', owner: 'someone@else.example', supplier: 'Grab', total: '10.00' },
  ] })
);

const { ensure, save, canonicalPersonName } = await import('../src/users.ts');
const { claimForBill } = await import('../src/claims.ts');
const { loadCollection } = await import('../src/jsonStore.ts');

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
// Any read goes through load(); this is the cheapest one to reach from here.
const read = (id: string) => {
  claimForBill('cybm', 'nothing');
  return (loadCollection('claims') as Array<Record<string, string>>).find((c) => c.id === id)!;
};

// The first read happens BEFORE anybody folds anything — a page load, a sweep,
// a webhook, moments after the process started. This is the read that used to
// consume the only attempt.
check('the claim starts out naming the duplicate', read('c1').claimFor, 'rowan rowan');

// Now the duplicate is folded away, which is what the Users page does when one
// address turns out to be two rows.
{
  const items = ensure('cybm');
  const keeper = items.find((u) => u.email === 'astridy2004@gmail.com')!;
  keeper.name = 'Rowan Tester';
  items.unshift({ ...keeper, id: 'dup', name: 'rowan rowan', practice: false, removed: true } as never);
  save(items);
}
check('the folded name resolves to the person it became', canonicalPersonName('cybm', 'rowan rowan'), 'Rowan Tester');

// THE BUG: this is a later read, in the same process.
check('a later read repairs the claim', read('c1').claimFor, 'Rowan Tester');
check('and the approver named on another claim', read('c2').approver, 'Rowan Tester');
check("but leaves that claim's own claimant alone", read('c2').claimFor, 'Wren Tester');

// A name that resolves to nobody is left exactly as it is rather than guessed
// at — the rule the repair has always held, and the one that keeps it safe to
// run on every read.
check('a name belonging to nobody is untouched', read('c3').claimFor, 'Nobody At All');

// Two names that differ only in their spacing are one name. The comparison used
// to trim the ends and not the middle, so a stray double space — invisible in
// every heading and table cell, since HTML collapses it — made the same person
// unmatchable, and the claim was left alone for "belonging to nobody".
check('a stray double space is the same name', read('c4').claimFor, 'Rowan Tester');

// A row deleted outright leaves no trail, so the name resolves to nobody. The
// claim's own receipts still know whose they are: a document is stored against
// an ADDRESS, which never goes stale.
// The answer is the person at that address by their CURRENT name — which is
// the whole point: the address is what does not go stale, so it keeps giving
// the right answer after the person is renamed.
check('a claim with no trail is repaired from its own receipts', read('c5').claimFor, 'Rowan Tester');

// But only when they agree. Receipts belonging to two different people say
// nothing about who the claim is for, so it is left exactly as it is.
check('receipts that disagree repair nothing', read('c6').claimFor, 'Vanished Entirely');

// And an item-less claim has no evidence at all — c3 stays as it is above.

// Idempotent: once the two agree there is nothing left to do, so a read costs
// nothing and cannot drift a name a second time.
check('reading again changes nothing', read('c1').claimFor, 'Rowan Tester');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
