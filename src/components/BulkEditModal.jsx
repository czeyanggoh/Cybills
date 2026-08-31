import { useEffect, useMemo, useState } from 'react';
import { useBridgeEntity } from '@/lib/organisations';
import { X } from 'lucide-react';
import ComboSelect from '@/components/ComboSelect';
import { useUsers, getDirectory } from '@/lib/userStore';
import {
  useXeroSuppliers,
  useXeroCustomers,
  useXeroPaymentMethods,
  useXeroProjectOptions,
} from '@/lib/organisations';
import { useCategoryDisplayMode, formatCategory } from '@/lib/categoryDisplay';
import { useProjectLabels, withProjectLabels } from '@/lib/projectLabels';
import { cn } from '@/lib/utils';

// "Bulk edit" — set one value across every selected document (Dext's bulk edit).
//
// The tick beside each field is the whole point: an untouched field is NOT
// blanked out. Only ticked fields are sent, so "code these 40 receipts to
// Entertainment" doesn't also wipe forty different suppliers. Clearing a field
// on purpose is still possible — tick it and leave the value empty.
const FIELDS = [
  { key: 'supplier', label: 'Supplier', kind: 'combo', source: 'suppliers', free: true },
  { key: 'date', label: 'Date', kind: 'date' },
  { key: 'dueDate', label: 'Due date', kind: 'date' },
  { key: 'category', label: 'Category', kind: 'combo', source: 'categories' },
  // Hidden in a bridge entity: it has no tax codes of its own, and its claims
  // post with No Tax at the full amount, so one set here could never be used.
  { key: 'taxRate', label: 'Tax rate', kind: 'combo', source: 'taxRates', xeroOnly: true },
  { key: 'documentType', label: 'Type', kind: 'select', options: ['Invoice', 'Receipt', 'Credit note', 'Statement', 'Other'] },
  { key: 'description', label: 'Description', kind: 'text' },
  { key: 'paymentMethod', label: 'Payment method', kind: 'combo', source: 'paymentMethods' },
  { key: 'paid', label: 'Paid', kind: 'bool' },
  // Labelled at render, not here: what this entity calls the list is its own.
  { key: 'project', label: 'Project', kind: 'combo', source: 'projects' },
  { key: 'customer', label: 'Customer', kind: 'combo', source: 'customers' },
  { key: 'currency', label: 'Currency', kind: 'text' },
  { key: 'note', label: 'Note', kind: 'text' },
  { key: 'owner', label: 'User', kind: 'select', source: 'users' },
];

export default function BulkEditModal({
  open,
  onClose,
  onApply,
  count = 0,
  publishedCount = 0,
  categoryOptions = [],
  taxRateOptions = [],
}) {
  const bridge = useBridgeEntity();
  const projectLabels = useProjectLabels();
  const [on, setOn] = useState({}); // which fields this edit actually touches
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const mode = useCategoryDisplayMode();

  const suppliers = useXeroSuppliers();
  const customers = useXeroCustomers();
  const paymentMethods = useXeroPaymentMethods().map((m) => m.label);
  const projects = useXeroProjectOptions();
  const roster = useUsers();
  // Rebuilt whenever the roster changes, which is when the directory does too.
  const people = useMemo(() => {
    const dir = getDirectory();
    const seen = new Set(dir.map((p) => String(p.email).toLowerCase()));
    return [...dir, ...roster.filter((u) => u.email && !seen.has(String(u.email).toLowerCase()))];
  }, [roster]);

  // Fresh every time it opens — a bulk edit is never meant to be "still armed"
  // from the last selection.
  useEffect(() => {
    if (!open) return;
    setOn({});
    setValues({});
    setBusy(false);
  }, [open]);

  const sources = useMemo(
    () => ({
      suppliers,
      customers,
      paymentMethods,
      projects,
      categories: categoryOptions,
      taxRates: taxRateOptions,
      // The people a document can be GIVEN to: this entity's own, plus its
      // general account. Not the practice colleagues working on it — what they
      // add belongs to the client, so the general account holds it — and not
      // anyone deactivated, who can no longer sign in to see it.
      users: people.filter((u) => !u.external && !u.deactivated).map((u) => u.email).filter(Boolean),
    }),
    [suppliers, customers, paymentMethods, projects, categoryOptions, taxRateOptions, people]
  );
  const userLabel = useMemo(() => {
    const byEmail = new Map(people.map((u) => [u.email, u.name || u.email]));
    return (email) => byEmail.get(email) || email;
  }, [people]);

  if (!open) return null;

  const fields = withProjectLabels(FIELDS, projectLabels).filter((f) => !(f.xeroOnly && bridge));
  const picked = fields.filter((f) => on[f.key]);
  const editable = count - publishedCount;

  const apply = async () => {
    const patch = {};
    for (const f of picked) {
      const v = values[f.key];
      patch[f.key] = f.kind === 'bool' ? v === 'Paid' : String(v ?? '');
    }
    setBusy(true);
    try {
      await onApply(patch);
    } finally {
      setBusy(false);
    }
  };

  const control = (f) => {
    const enabled = Boolean(on[f.key]);
    const set = (v) => setValues((s) => ({ ...s, [f.key]: v }));
    const value = values[f.key] ?? '';
    if (f.kind === 'bool') {
      return (
        <select
          disabled={!enabled}
          value={value || 'Not paid'}
          onChange={(e) => set(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm outline-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option>Not paid</option>
          <option>Paid</option>
        </select>
      );
    }
    if (f.kind === 'date') {
      return (
        <input
          type="date"
          disabled={!enabled}
          value={value}
          onChange={(e) => set(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm outline-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
        />
      );
    }
    if (f.kind === 'select') {
      const options = f.source ? sources[f.source] : f.options;
      return (
        <select
          disabled={!enabled}
          value={value}
          onChange={(e) => set(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm outline-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">— None —</option>
          {options.map((o) => (
            <option key={o} value={o}>{f.source === 'users' ? userLabel(o) : o}</option>
          ))}
        </select>
      );
    }
    if (f.kind === 'combo') {
      // A supplier that isn't in Xero yet still has to be typeable, so the free
      // fields keep a text box beside the picker rather than only offering the list.
      const options = sources[f.source] ?? [];
      return (
        <div className={cn('flex flex-col gap-2 sm:flex-row', !enabled && 'pointer-events-none opacity-40')}>
          <div className="min-w-0 flex-1">
            <ComboSelect
              aria-label={f.label}
              value={value}
              options={['', ...options.filter((o) => o !== value)]}
              onChange={set}
              disabled={!enabled}
              emptyLabel="— None —"
              format={(c) => (f.source === 'categories' ? formatCategory(c, mode) : c)}
            />
          </div>
          {f.free && (
            <input
              type="text"
              disabled={!enabled}
              value={value}
              onChange={(e) => set(e.target.value)}
              placeholder="or type a name"
              className="h-9 w-full shrink-0 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-36"
            />
          )}
        </div>
      );
    }
    return (
      <input
        type="text"
        disabled={!enabled}
        value={value}
        onChange={(e) => set(e.target.value)}
        className="h-9 w-full rounded-md border bg-background px-2 text-sm outline-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring"
      />
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-4 sm:px-6">
          <h2 className="text-base font-semibold tracking-tight">
            Bulk edit {count} item{count === 1 ? '' : 's'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <p className="mb-4 text-sm text-muted-foreground">
            Tick a field to change it on every selected document. Untouched fields are left exactly
            as they are — tick a field and leave it empty to clear it.
          </p>
          {publishedCount > 0 && (
            <p className="mb-4 rounded-md border bg-muted px-3 py-2 text-sm">
              {publishedCount} of these {publishedCount === 1 ? 'is' : 'are'} already published to
              Xero and will be left alone — editing here would no longer match the ledger.
              {editable > 0
                ? ` ${editable} document${editable === 1 ? '' : 's'} will be changed.`
                : ' Nothing left to change.'}
            </p>
          )}
          <div className="space-y-2">
            {fields.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                <label className="flex items-center gap-2 text-sm sm:w-40 sm:shrink-0">
                  <input
                    type="checkbox"
                    checked={Boolean(on[f.key])}
                    onChange={(e) => setOn((s) => ({ ...s, [f.key]: e.target.checked }))}
                    className="h-4 w-4 rounded border"
                  />
                  <span className={cn(on[f.key] ? 'text-foreground' : 'text-muted-foreground')}>{f.label}</span>
                </label>
                <div className="min-w-0 flex-1">{control(f)}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span className="text-sm text-muted-foreground">
            {picked.length === 0
              ? 'No fields selected'
              : `${picked.length} field${picked.length === 1 ? '' : 's'}: ${picked.map((f) => f.label).join(', ')}`}
          </span>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-md border px-4 text-sm transition-colors hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!picked.length || editable <= 0 || busy}
              onClick={apply}
              className={cn(
                'h-9 rounded-md px-4 text-sm transition-colors',
                !picked.length || editable <= 0 || busy
                  ? 'cursor-not-allowed bg-muted text-muted-foreground'
                  : 'bg-foreground text-background hover:opacity-90'
              )}
            >
              {busy ? 'Applying…' : `Apply to ${editable} item${editable === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
