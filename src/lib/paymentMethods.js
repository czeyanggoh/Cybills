// Payment methods available on a document, persisted in localStorage. Seeded
// with a couple of common ones; the user can add more from the document form.

import { useEffect, useState } from 'react';

const KEY = 'cybills.payment.methods.v1';
export const PAYMENT_METHODS_EVENT = 'cybills:payment-methods-changed';

// Bank accounts offered when adding a payment method.
export const BANK_ACCOUNTS = [
  'DBS Current Account',
  'OCBC Business Account',
  'UOB Corporate Account',
  'Petty Cash',
];

// No seeded methods: the payment-method list comes from Xero (bank + payment-
// enabled accounts). Anything here would just be a fake preset. Users can still
// add their own via "Add payment method", which are stored below.
const SEED = [];

function paymentLabel(name, reference) {
  const n = String(name || '').trim();
  const r = String(reference || '').trim();
  return r ? `${n} (${r})` : n;
}

function readAdded() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeAdded(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(PAYMENT_METHODS_EVENT));
}

// Seed methods first, then any the user added.
export function getPaymentMethods() {
  return [...SEED, ...readAdded()];
}

let seq = 0;
export function addPaymentMethod({ name, reference, bankAccount }) {
  const label = paymentLabel(name, reference);
  if (!label) return null;
  seq += 1;
  const pm = {
    id: `pm_${Date.now().toString(36)}_${seq}`,
    name: String(name).trim(),
    reference: String(reference || '').trim(),
    bankAccount: String(bankAccount || '').trim(),
    label,
  };
  writeAdded([...readAdded(), pm]);
  return pm;
}

export function usePaymentMethods() {
  const [list, setList] = useState(getPaymentMethods);
  useEffect(() => {
    const sync = () => setList(getPaymentMethods());
    window.addEventListener(PAYMENT_METHODS_EVENT, sync);
    return () => window.removeEventListener(PAYMENT_METHODS_EVENT, sync);
  }, []);
  return list;
}
