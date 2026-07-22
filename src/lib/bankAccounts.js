// Manually-added bank accounts, persisted in localStorage. Dext lets you add a
// bank account by hand (or via an integration); we support the manual path.

import { useEffect, useState } from 'react';

const KEY = 'cybills.bank.accounts.v1';
export const BANK_ACCOUNTS_EVENT = 'cybills:bank-accounts-changed';

export const CURRENCIES = ['SGD', 'USD', 'EUR', 'GBP', 'MYR', 'AUD'];

function readAll() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeAll(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(BANK_ACCOUNTS_EVENT));
}

export function getBankAccounts() {
  return readAll();
}

let seq = 0;
export function addBankAccount({ name, number, currency }) {
  const n = String(name || '').trim();
  if (!n) return null;
  seq += 1;
  const acct = {
    id: `bank_${Date.now().toString(36)}_${seq}`,
    name: n,
    number: String(number || '').trim(),
    currency: String(currency || 'SGD').trim(),
  };
  writeAll([...readAll(), acct]);
  return acct;
}

export function removeBankAccount(id) {
  writeAll(readAll().filter((a) => a.id !== id));
}

export function useBankAccounts() {
  const [list, setList] = useState(getBankAccounts);
  useEffect(() => {
    const sync = () => setList(getBankAccounts());
    window.addEventListener(BANK_ACCOUNTS_EVENT, sync);
    return () => window.removeEventListener(BANK_ACCOUNTS_EVENT, sync);
  }, []);
  return list;
}
