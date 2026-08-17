import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// The company's Business profile (Business settings → Business profile). Stored
// as a shared, server-backed settings blob. The registration fields (name, CRN,
// tax number, country, base currency, registered address) can be pulled from the
// connected Xero organisation via "Update from Xero"; the CYBills-only fields
// (practice code, account language, industry) are edited by hand.

const KEY = 'cybills.business-profile.v1';
export const BUSINESS_PROFILE_EVENT = 'cybills:business-profile-changed';

export const DEFAULT_BUSINESS_PROFILE = {
  businessName: '',
  crn: '',
  taxNumber: '',
  practiceCode: '',
  country: 'Singapore',
  baseCurrency: 'SGD — Singapore, Dollars',
  language: 'English',
  industry: 'IT and Computer Services',
  address: { line1: '', line2: '', city: '', postalCode: '', country: 'Singapore' },
  syncedAt: '',
};

const emit = () => window.dispatchEvent(new Event(BUSINESS_PROFILE_EVENT));
const store = blobStore(KEY, DEFAULT_BUSINESS_PROFILE, emit);

export function getBusinessProfile() {
  const v = store.get() || {};
  return {
    ...DEFAULT_BUSINESS_PROFILE,
    ...v,
    address: { ...DEFAULT_BUSINESS_PROFILE.address, ...(v.address || {}) },
  };
}

export function saveBusinessProfile(profile) {
  store.set(profile);
  emit();
}

export function useBusinessProfile() {
  const [p, setP] = useState(getBusinessProfile);
  useEffect(() => {
    const sync = () => setP(getBusinessProfile());
    window.addEventListener(BUSINESS_PROFILE_EVENT, sync);
    return () => window.removeEventListener(BUSINESS_PROFILE_EVENT, sync);
  }, []);
  return p;
}

// Xero returns ISO country codes / currency codes; map them to the labels the
// form's dropdowns use. Unknown codes fall through to the current value.
const COUNTRY_BY_CODE = { SG: 'Singapore', MY: 'Malaysia', GB: 'United Kingdom', AU: 'Australia' };
const CURRENCY_LABEL = {
  SGD: 'SGD — Singapore, Dollars',
  USD: 'USD — US, Dollars',
  MYR: 'MYR — Malaysian, Ringgit',
  GBP: 'GBP — British, Pounds',
};

// Overlay a Xero Organisation profile (from fetchXeroProfile) onto the current
// form, keeping hand-edited CYBills-only fields. Only fills a field when Xero
// actually has a value, so a sparse Xero org never blanks existing data.
export function mergeXeroProfile(current, xero) {
  if (!xero) return current;
  const country = COUNTRY_BY_CODE[xero.countryCode] || current.country;
  const a = xero.address || {};
  return {
    ...current,
    businessName: xero.name || current.businessName,
    crn: xero.registrationNumber || current.crn,
    taxNumber: xero.taxNumber || current.taxNumber,
    country,
    baseCurrency: CURRENCY_LABEL[xero.baseCurrency] || current.baseCurrency,
    address: {
      line1: a.line1 || current.address.line1,
      line2: a.line2 || current.address.line2,
      city: a.city || current.address.city,
      postalCode: a.postalCode || current.address.postalCode,
      country: a.country || country || current.address.country,
    },
    syncedAt: new Date().toISOString(),
  };
}
