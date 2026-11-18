// A read supplier name filed under the supplier the entity already has
// (src/lib/supplierCanonical.js).
import assert from 'node:assert/strict';
import { canonicalSupplierName } from '../src/lib/supplierCanonical.js';

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); } catch (e) { failures += 1; console.error(`FAIL  ${name}\n      ${e.message}`); }
};
const named = (read, ctx) => canonicalSupplierName(read, ctx).name;

check('Ltd and Limited are one supplier', () => {
  assert.deepEqual(canonicalSupplierName('Xero (NZ) Ltd', { candidates: [{ name: 'Xero (NZ) Limited', xero: true }] }), { name: 'Xero (NZ) Limited', from: 'spelling' });
});
check('a live name stays itself', () => {
  assert.deepEqual(canonicalSupplierName('Grab', { candidates: [{ name: 'Grab' }, { name: 'GRAB PTE LTD' }] }), { name: 'Grab', from: '' });
});
check('case alone takes the existing spelling', () => {
  assert.equal(named('SINGTEL', { candidates: [{ name: 'Singtel' }] }), 'Singtel');
});
check('a merged-away spelling goes where it was merged', () => {
  assert.deepEqual(canonicalSupplierName('Xero Global', { merged: { 'xero global': 'Xero (NZ) Limited' } }), { name: 'Xero (NZ) Limited', from: 'merge' });
});
check('a new spelling of a merged-away name follows the merge', () => {
  assert.equal(named('XERO GLOBAL PTE. LTD.', { merged: { 'xero global': 'Xero (NZ) Limited' } }), 'Xero (NZ) Limited');
});
check('a chain of merges is followed', () => {
  assert.equal(named('A', { merged: { a: 'B', b: 'C' } }), 'C');
});
check('a merged-away name is never chosen as a live match', () => {
  const ctx = { candidates: [{ name: 'Xero (NZ) Ltd', docs: 9 }, { name: 'Xero (NZ) Limited' }], removed: ['Xero (NZ) Ltd'] };
  assert.equal(named('XERO (NZ) LIMITED.', ctx), 'Xero (NZ) Limited');
});
check('several live matches: the one with a rule wins', () => {
  const ctx = { candidates: [{ name: 'Xero (NZ) Ltd', docs: 5, xero: true }, { name: 'Xero (NZ) Limited', rule: true, xero: true }] };
  assert.equal(named('Xero NZ Limited', ctx), 'Xero (NZ) Limited');
});
check('several live matches: then the one with more documents', () => {
  const ctx = { candidates: [{ name: 'Xero (NZ) Ltd', docs: 5 }, { name: 'Xero (NZ) Limited', docs: 2 }] };
  assert.equal(named('Xero NZ Limited', ctx), 'Xero (NZ) Ltd');
});
check('evidence for one name is summed across sources', () => {
  const ctx = { candidates: [{ name: 'Acme Ltd', docs: 2 }, { name: 'Acme Ltd', xero: true }, { name: 'ACME Pte Ltd', docs: 2 }] };
  assert.equal(named('Acme Limited', ctx), 'Acme Ltd');
});
check('a tie is left as read', () => {
  const ctx = { candidates: [{ name: 'Acme Ltd', docs: 1 }, { name: 'ACME Pte Ltd', docs: 1 }] };
  assert.deepEqual(canonicalSupplierName('Acme Limited', ctx), { name: 'Acme Limited', from: '' });
});
check('a numbered supplier is a different supplier', () => {
  assert.equal(named('OCBC Loan 3', { candidates: [{ name: 'OCBC Loan 2' }] }), 'OCBC Loan 3');
});
check('a different name is not touched', () => {
  assert.equal(named('Xero Inc', { candidates: [{ name: 'Xero (NZ) Limited' }] }), 'Xero Inc');
});
check('blank and the placeholder are left alone', () => {
  assert.equal(named('', { candidates: [{ name: 'X' }] }), '');
  assert.equal(named('Unknown supplier', { merged: { 'unknown supplier': 'X' } }), 'Unknown supplier');
});

if (failures) { console.error(`\nsupplier-canonical: ${failures} failed`); process.exit(1); }
console.log('\nsupplier-canonical: all passed');
