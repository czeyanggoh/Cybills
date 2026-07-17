import { XERO_CATEGORY_LABELS } from './xeroAccounts.js';

// Expense categories offered in the Category dropdowns (list + detail). These
// are the Xero chart of accounts — an expense is categorised straight into the
// Xero account it should post to, so OCR classification and "Publish to Xero"
// speak the same language. "Uncategorised" is the unset default.
export const CATEGORIES = ['Uncategorised', ...XERO_CATEGORY_LABELS];
