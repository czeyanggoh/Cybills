import { useEffect, useState } from 'react';
import { useBridgeEntity } from '@/lib/organisations';
import { X, Info } from 'lucide-react';
import ComboSelect from '@/components/ComboSelect';
import { cn } from '@/lib/utils';

// "Bulk edit N suppliers" — set one standing rule across every selected
// supplier, mirroring Dext's dialog.
//
// Every field defaults to "No change" and only the fields moved off it are
// written, so "code these forty suppliers to Entertainment" cannot also blank
// forty different tax rates. Clearing a rule on purpose is still possible:
// pick "— Clear —", which removes that instruction from each supplier.
//
// A supplier rule is an instruction for documents that arrive NEXT — the same
// thing Dext says on this dialog, and true here for the same reason: rules are
// applied when a document is read, so changing one leaves the inbox alone.
const CLEAR = '— Clear —';
const NO_CHANGE = 'No change';

// Left/right columns, laid out as Dext lays them out.
const LEFT = [
  { key: 'category', label: 'Category', source: 'categories' },
  { key: 'customer', label: 'Customer', source: 'customers' },
  { key: 'project', label: 'Project', source: 'projects' },
];
const RIGHT = [
  { key: 'extractLineItems', label: 'Extract line items', bool: true },
  { key: 'extractStatements', label: 'Extract supplier statements', bool: true },
  // A bridge entity has no tax position of its own and its claims post with No
  // Tax at the full amount, so a standing tax code here could never reach the
  // ledger. Offering one is a control that looks like it works and can't.
  { key: 'taxRate', label: 'Tax rate', source: 'taxRates', xeroOnly: true },
  { key: 'currency', label: 'Currency', source: 'currencies' },
  { key: 'paymentMethod', label: 'Payment method', source: 'paymentMethods' },
];

export default function SupplierBulkEditModal({
  open,
  onClose,
  onApply,
  count = 0,
  categoryOptions = [],
  customerOptions = [],
  projectOptions = [],
  taxRateOptions = [],
  paymentMethodOptions = [],
  currencyOptions = [],
}) {
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const bridge = useBridgeEntity();
  const shown = (f) => !f.xeroOnly || !bridge;

  useEffect(() => {
    if (open) {
      setValues({});
      setBusy(false);
    }
  }, [open]);

  if (!open) return null;

  const sources = {
    categories: categoryOptions,
    customers: customerOptions,
    projects: projectOptions,
    taxRates: taxRateOptions,
    paymentMethods: paymentMethodOptions,
    currencies: currencyOptions,
  };

  const set = (key, v) => setValues((s) => ({ ...s, [key]: v }));

  const apply = async () => {
    // Only the fields actually moved off "No change" become instructions.
    const patch = {};
    for (const f of [...LEFT, ...RIGHT]) {
      const v = values[f.key];
      if (v === undefined || v === NO_CHANGE) continue;
      if (f.bool) patch[f.key] = v === 'Yes';
      else patch[f.key] = v === CLEAR ? '' : v;
    }
    if (!Object.keys(patch).length) {
      onClose();
      return;
    }
    setBusy(true);
    await onApply(patch);
    setBusy(false);
  };

  const field = (f) => (
    <div key={f.key} className="grid grid-cols-[9rem_1fr] items-center gap-3">
      <span className="text-sm text-muted-foreground">{f.label}</span>
      <ComboSelect
        size="sm"
        aria-label={f.label}
        value={values[f.key] ?? NO_CHANGE}
        options={f.bool ? [NO_CHANGE, 'Yes', 'No'] : [NO_CHANGE, CLEAR, ...(sources[f.source] || [])]}
        onChange={(v) => set(f.key, v)}
      />
    </div>
  );

  const touched = Object.values(values).filter((v) => v !== undefined && v !== NO_CHANGE).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">
            Bulk edit {count} supplier{count === 1 ? '' : 's'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="mb-5 flex items-start gap-2.5 rounded-md border bg-muted/30 px-3.5 py-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <p>
              These are standing rules for documents that arrive next. Updating settings in bulk will not change items
              already in the inbox.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-4">{LEFT.filter(shown).map(field)}</div>
            <div className="space-y-4">{RIGHT.filter(shown).map(field)}</div>
          </div>
          {bridge && (
            <p className="mt-4 text-xs text-muted-foreground">
              Claims raised here post with <span className="font-medium text-foreground">No Tax</span>, so there is no
              tax code to set.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3.5">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || !touched}
            className={cn(
              'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity',
              busy || !touched ? 'cursor-not-allowed opacity-50' : 'hover:opacity-90'
            )}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
