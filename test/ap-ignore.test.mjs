// "Ignore future mail like this": the rule's starting point, read off the mail
// the CYWS AP Mailbox forwarded (src/lib/apIgnore.js).
import assert from 'node:assert/strict';
import { isApMailboxForward, originalSenderOf, ignoreSubjectFor } from '../src/lib/apIgnore.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures += 1; console.error(`FAIL  ${name}\n      ${e.message}`); }
};

const AIRWALLEX = [
  'Forwarded automatically from czeyang.goh@cy-bm.sg for CYBills processing.',
  '',
  'Original sender: Airwallex <support@info.airwallex.com>',
  '',
  'Original message (Your Airwallex billing statement is ready):',
].join('\n');

check('an AP Mailbox forward is recognised by its covering line', () => {
  assert.equal(isApMailboxForward(AIRWALLEX), true);
  assert.equal(isApMailboxForward('Hi, invoice attached.'), false);
});

check('the ORIGINAL sender, not the mailbox that forwarded it', () => {
  assert.equal(originalSenderOf(AIRWALLEX, 'czeyang.goh@cy-bm.sg'), 'support@info.airwallex.com');
  assert.equal(originalSenderOf('Original sender: SUPPORT@info.Airwallex.com\n', ''), 'support@info.airwallex.com');
});

check('no covering line: the From', () => {
  assert.equal(originalSenderOf('Hello', 'Acme <Billing@Acme.com>'), 'billing@acme.com');
  assert.equal(originalSenderOf('', ''), '');
});

check('the subject loses Fwd:, numbers, dates and the item tag', () => {
  assert.equal(ignoreSubjectFor('Fwd: Your Airwallex billing statement is ready'), 'your airwallex billing statement is ready');
  assert.equal(ignoreSubjectFor('Re: Fwd: Invoice INV-2026-0042 due 16/11/2026 SGD 1,378.91 [Item #261117000012]'), 'invoice due');
});

check('one word left is too wide to match on', () => {
  assert.equal(ignoreSubjectFor('Fwd: Invoice 12345'), '');
});

if (failures) { console.error(`\n${failures} failing`); process.exit(1); }
console.log('\nap-ignore: all passed');
