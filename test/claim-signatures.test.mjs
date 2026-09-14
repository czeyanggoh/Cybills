// Signature boxes on the claim report are the entity's opt-in (Business
// settings -> Exports): absent by default, present — naming the claimant and
// the approver — when switched on.
import assert from 'node:assert/strict';
import { buildClaimDoc } from '../src/lib/claimPdf.js';

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
