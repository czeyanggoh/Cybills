// Manually-added bank accounts, persisted in localStorage. Dext lets you add a
// bank account by hand (or via an integration); we support the manual path.

import { useEffect, useState } from 'react';

const KEY = 'cybills.bank.accounts.v1';
const REQ_KEY = 'cybills.bank.requested.v1';
export const BANK_ACCOUNTS_EVENT = 'cybills:bank-accounts-changed';

// Currencies offered when adding an account (code + friendly label, Dext-style).
export const CURRENCY_OPTIONS = [
  { code: 'SGD', label: 'SGD — Singapore, Dollars' },
  { code: 'USD', label: 'USD — US Dollars' },
  { code: 'EUR', label: 'EUR — Euro' },
  { code: 'GBP', label: 'GBP — British Pound' },
  { code: 'MYR', label: 'MYR — Malaysian Ringgit' },
  { code: 'AUD', label: 'AUD — Australian Dollars' },
];

// Banks selectable in the "Add bank account" form.
export const BANKS = [
  'DBS Bank',
  'OCBC Bank',
  'United Overseas Bank (UOB)',
  'Standard Chartered',
  'HSBC',
  'Citibank',
  'Maybank',
  'Bank of China',
];

function readJson(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
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
  return readJson(KEY);
}

// Banks a user has requested via "Request your bank" — merged into the list.
export function getRequestedBanks() {
  return readJson(REQ_KEY);
}
export function addRequestedBank(name) {
  const n = String(name || '').trim();
  if (!n) return;
  const list = readJson(REQ_KEY);
  if (!list.includes(n)) {
    localStorage.setItem(REQ_KEY, JSON.stringify([...list, n]));
    window.dispatchEvent(new Event(BANK_ACCOUNTS_EVENT));
  }
}
export function getAllBanks() {
  return [...BANKS, ...getRequestedBanks()];
}

let seq = 0;
export function addBankAccount({ bank, name, reference, currency }) {
  const n = String(name || '').trim();
  if (!n) return null;
  seq += 1;
  const acct = {
    id: `bank_${Date.now().toString(36)}_${seq}`,
    bank: String(bank || '').trim(),
    name: n,
    reference: String(reference || '').trim(),
    currency: String(currency || 'SGD').trim(),
  };
  writeAll([...readJson(KEY), acct]);
  return acct;
}

export function removeBankAccount(id) {
  writeAll(readJson(KEY).filter((a) => a.id !== id));
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
