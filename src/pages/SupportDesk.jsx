import { useState } from 'react';
import AppShell from '@/components/AppShell';
import RequestBoard from '@/components/RequestBoard';
import { cn } from '@/lib/utils';

// The two views the merged Support Desk board can show. Each keeps its own
// localStorage-backed store (storageKey) so existing tickets and feature
// requests stay intact — the toggle only swaps which data/labels render.
// Pre-loaded test action items — one verifiable step per line. Tick each off
// and attach a screenshot as proof once tested. Grouped by workspace (A–K).
const TEST_ITEMS = [
  'A · Costs: upload a receipt (Add documents) — it reads (OCR) and lands in the Inbox as “New”.',
  'A · Costs: open the receipt detail — image on the left, extracted fields on the right.',
  'B · Cost detail: Category dropdown lists the Xero chart + the CSV Lists categories.',
  'B · Cost detail: Customer & Project dropdowns are populated; the Paid toggle switches Yes/No.',
  'B · Cost detail: Add payment method — the Bank account list is synced from Xero.',
  'B · Cost detail: Split the receipt across two categories.',
  'B · Costs: move an item through the pipeline (Inbox → To review → Ready).',
  'C · Sales: upload a receipt — the drawer defaults to Sales and the item appears under Processing.',
  'C · Sales: click Move to inbox — it lands in the Inbox with a green “New” dot.',
  'C · Sales detail: Set customer rules (+ Smart split), Add category, Add payment method.',
  'C · Sales detail: History tab shows uploaded → processing → viewed (+ any category change).',
  'D · Business settings → Lists: add or hide a Category → it appears/disappears in the Cost/Sales dropdowns.',
  'D · Lists: Tax rates (21) and Projects show; add a project → it appears in every Project dropdown.',
  'E · Sales → Customers: set a Category and Project per customer (persists on reload).',
  'E · Costs → Suppliers: set a Category and Customer per supplier (persists on reload).',
  'F · Expense claims: add selected costs to a claim (new or existing).',
  'F · Expense claim: Submit for approval — the ✕ closes the dialog even with the approver dropdown open.',
  'F · Expense claim: PDF preview (with approval-history page) + Export (CSV/PDF).',
  'G · Vault: upload a file → it previews on the detail page; Subject & Summary auto-fill.',
  'G · Vault: Copy to Costs and Copy to Sales from a file — it appears in each inbox.',
  'G · Vault: Manage access (general + per-user); Tags (Add tags); Downloads records a ZIP archive.',
  'H · Bank → Accounts: Add bank account (2-step wizard) + Request your bank sub-dialog.',
  'H · Bank → Statements: Set up an Integration → lands on Business settings → Connections.',
  'I · Users: Add a user — Login access off hides Email, on makes it required; 3-step add completes.',
  'I · Users: Manage → Deactivate/Reactivate and Edit user details.',
  'J · Profile: Change email + Change password; Bookkeeping toggles and Approval dropdowns persist.',
  'K · Exports: Export all (CSV / PDF / ZIP) → the file appears in the Exports tab and Download works.',
];

const VIEWS = {
  support: {
    label: 'Support Desk',
    title: 'Support Desk',
    intro:
      'Log issues, feedback, or change requests below (attach a screenshot if needed). Each item can be ticked off when done.',
    emptyLabel: 'issues',
    composerPlaceholder:
      'Describe an issue or change request… Paste or drop a screenshot here. (⌘/Ctrl+Enter to send)',
    storageKey: 'cybills.support-tickets',
  },
  features: {
    label: 'Feature Requests',
    title: 'Feature Requests',
    intro:
      "List the features you'd like developed below (attach a mockup or screenshot if it helps). Support reviews each request and can reply with status or questions. Tick an item off once it's shipped.",
    emptyLabel: 'feature requests',
    composerPlaceholder:
      "Describe a feature you'd like developed… Paste or drop a mockup here. (⌘/Ctrl+Enter to send)",
    storageKey: 'cybills.feature-requests',
  },
  testing: {
    label: 'Testing',
    title: 'Testing checklist',
    intro:
      'Every function to verify, one action per line. Test it on the live site, tick it off, and attach a screenshot as proof. Add extra checks at the bottom if needed.',
    emptyLabel: 'test items',
    composerPlaceholder:
      'Add another thing to test… Paste or drop a screenshot here. (⌘/Ctrl+Enter to send)',
    storageKey: 'cybills.testing-checklist',
    seed: TEST_ITEMS,
  },
};

const ORDER = ['support', 'features', 'testing'];

export default function SupportDesk() {
  const [view, setView] = useState('support');
  const config = VIEWS[view];

  // Segmented toggle handed to the board so it renders under the header.
  const toggle = (
    <div className="inline-flex rounded-lg border bg-muted p-0.5">
      {ORDER.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => setView(key)}
          aria-pressed={view === key}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            view === key
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {VIEWS[key].label}
        </button>
      ))}
    </div>
  );

  return (
    <AppShell>
      {/* Remount the board when the view changes so it reloads the correct
          store (each view has its own storageKey). */}
      <RequestBoard
        key={view}
        title={config.title}
        intro={config.intro}
        emptyLabel={config.emptyLabel}
        composerPlaceholder={config.composerPlaceholder}
        storageKey={config.storageKey}
        seed={config.seed || []}
        viewToggle={toggle}
      />
    </AppShell>
  );
}
