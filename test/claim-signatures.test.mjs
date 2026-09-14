// Signature boxes on the claim report are the entity's opt-in (Business
// settings -> Exports): absent by default, present — naming the claimant and
// the approver — when switched on.
import assert from 'node:assert/strict';
import { buildClaimDoc, pdfText } from '../src/lib/claimPdf.js';

const claim = {
  name: 'Aug claim', claimFor: 'Martin Lim', approver: 'Kai Tan', currency: 'SGD', net: 10, tax: 0.9, total: 10.9,
  transactions: [{ date: '2026-08-02', itemId: '1', displayId: '1', supplier: 'Grab', category: 'Transport', net: 10, tax: 0.9, total: 10.9 }],
  history: [],
};

const off = buildClaimDoc(claim, {}, 'https://x').output();
assert.ok(!off.includes('CLAIMED BY') && !off.includes('APPROVED BY'), 'no signature boxes by default');
console.log('PASS  no signature boxes by default');

const on = buildClaimDoc(claim, {}, 'https://x', { signatures: true }).output();
assert.ok(on.includes('CLAIMED BY') && on.includes('APPROVED BY'), 'both boxes drawn when on');
assert.ok(on.includes('Name: Martin Lim') && on.includes('Name: Kai Tan'), 'boxes name claimant and approver');
console.log('PASS  boxes drawn and named when switched on');

// A description carrying characters Helvetica can't encode must not be written
// as UTF-16 (which draws `!"` for an arrow and spaces out the whole line).
assert.equal(pdfText('Singapore → Jakarta (19 Aug 2026 – 21 Aug 2026)'), 'Singapore -> Jakarta (19 Aug 2026 - 21 Aug 2026)');
assert.equal(pdfText('13 km × SGD 0.60/km'), '13 km × SGD 0.60/km', 'Latin-1 left alone');
const arrow = buildClaimDoc({ ...claim, transactions: [{ ...claim.transactions[0], description: '* Scoot return Singapore → Jakarta' }] }, {}, 'https://x').output();
assert.ok(arrow.includes('Singapore -> Jakarta'), 'description drawn as plain text');
console.log('PASS  non-Latin-1 characters in a description are folded, not spaced out');
