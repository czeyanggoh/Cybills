import { useEffect, useState } from 'react';
import { X, Info, ChevronDown } from 'lucide-react';
import SearchSelect from '@/components/SearchSelect';
import {
  CURRENCIES,
  SUPPLIER_DUE_MODES,
  SUPPLIER_PAID_OPTIONS,
  clearSupplierRule,
  emptySupplierRule,
  matchSupplierRule,
  saveSupplierRule,
  supplierRuleCount,
} from '@/lib/supplierRules';
import { cn } from '@/lib/utils';

function FieldLabel({ children, hint = '' }) {
  return (
    <label className="mb-1.5 block text-sm text-muted-foreground">
      {children}
      {hint && <span className="ml-1 text-xs text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

// A plain styled <select> with a chevron.
function Select({ value, onChange, children }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full appearance-none rounded-md border bg-background px-3 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

// A No/Yes pill toggle.
function Toggle({ on, onToggle }) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center gap-2">
      <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-foreground' : 'justify-start border')}>
        <span className={cn('h-4 w-4 rounded-full', on ? 'bg-background' : 'bg-muted-foreground/50')} />
      </span>
      <span className="text-sm text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

// "Supplier rules" dialog — the standing instructions applied to every document
// that arrives from this supplier. The cost-side twin of CustomerRulesModal,
// opened from the Supplier field on a cost and from the Suppliers list.
// `onApply` receives the saved rule so the caller can also reflect it on the
// document that's open.
export default function SupplierRulesModal({
  open,
  supplier,
  categoryOptions = [],
  customerOptions = [],
  projectOptions = [],
  taxRateOptions = [],
  paymentMethodOptions = [],
  gstRegistered = true,
  onClose,
  onApply,
}) {
  const [rule, setRule] = useState(emptySupplierRule);

  // Load the supplier's saved rule each time the dialog opens — the same dialog
  // instance is reused as the reviewer moves between documents.
  useEffect(() => {
    if (open) setRule({ ...emptySupplierRule(), ...(matchSupplierRule(supplier) || {}) });
  }, [open, supplier]);

  if (!open) return null;

  const set = (k, v) => setRule((r) => ({ ...r, [k]: v }));
  const named = String(supplier || '').trim();
  const count = supplierRuleCount(rule);

  const apply = () => {
    saveSupplierRule(named, rule);
    onApply?.(rule);
    onClose();
  };
  const clear = () => {
    clearSupplierRule(named);
    setRule(emptySupplierRule());
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Supplier rules: {named || 'Supplier'}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <p className="mb-6 flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Set a rule and it&rsquo;s applied to this document and to everything new that arrives
              from <span className="font-medium text-foreground">{named || 'this supplier'}</span>. A
              rule is an instruction, so it outranks whatever the reader worked out for itself.
              Leave a field blank to leave that decision to the reader.
            </span>
          </p>

          {!named && (
            <p className="mb-6 rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
              This document has no supplier yet — fill the Supplier field in first, then set its rules.
            </p>
          )}

          <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
            <div>
              <FieldLabel>Category</FieldLabel>
              <SearchSelect value={rule.category} options={categoryOptions} onChange={(v) => set('category', v)} />
            </div>
            <div>
              <FieldLabel>Currency</FieldLabel>
              <Select value={rule.currency} onChange={(v) => set('currency', v)}>
                <option value="">Leave to the document</option>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </Select>
            </div>

            <div>
              <FieldLabel>Customer</FieldLabel>
              <SearchSelect value={rule.customer} options={customerOptions} onChange={(v) => set('customer', v)} />
            </div>
            <div>
              <FieldLabel>Tax rate</FieldLabel>
              {gstRegistered ? (
                <SearchSelect value={rule.taxRate} options={taxRateOptions} onChange={(v) => set('taxRate', v)} />
              ) : (
                <p className="pt-2 text-sm text-muted-foreground">
                  Fixed to No Tax — this company isn&rsquo;t GST-registered.
                </p>
              )}
            </div>

            <div>
              <FieldLabel>Project</FieldLabel>
              <SearchSelect value={rule.project} options={projectOptions} onChange={(v) => set('project', v)} />
            </div>
            <div>
              <FieldLabel>Payment method</FieldLabel>
              <SearchSelect value={rule.paymentMethod} options={paymentMethodOptions} onChange={(v) => set('paymentMethod', v)} />
            </div>

            <div>
              <FieldLabel>Due date</FieldLabel>
              <div className="flex gap-2">
                {rule.dueMode === SUPPLIER_DUE_MODES[0] && (
                  <input
                    value={rule.dueDays}
                    onChange={(e) => set('dueDays', e.target.value)}
                    inputMode="numeric"
                    placeholder="30"
                    className="h-10 w-20 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                )}
                <div className="flex-1">
                  <Select value={rule.dueMode} onChange={(v) => set('dueMode', v)}>
                    <option value="">Follow the org&rsquo;s payment terms</option>
                    {SUPPLIER_DUE_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </Select>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Only used when the document doesn&rsquo;t print a due date of its own.
              </p>
            </div>
            <div>
              <FieldLabel>Paid</FieldLabel>
              <Select value={rule.paid} onChange={(v) => set('paid', v)}>
                <option value="">Follow Extraction settings</option>
                {SUPPLIER_PAID_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </div>

            <div>
              <FieldLabel>Extract line items</FieldLabel>
              <div className="pt-1"><Toggle on={rule.extractLineItems} onToggle={() => set('extractLineItems', !rule.extractLineItems)} /></div>
              <p className="mt-1 text-xs text-muted-foreground">
                Pull the document&rsquo;s printed lines in with the read, instead of one coded total.
              </p>
            </div>
            <div>
              <FieldLabel>Description</FieldLabel>
              <textarea
                rows={2}
                value={rule.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Leave blank to keep what the reader found"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={clear}
            disabled={count === 0}
            className={cn(
              'inline-flex h-9 items-center rounded-md px-3 text-sm transition-colors',
              count === 0 ? 'cursor-not-allowed text-muted-foreground/50' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            Remove rule
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
            <button
              type="button"
              onClick={apply}
              disabled={!named}
              className={cn(
                'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity',
                named ? 'hover:opacity-90' : 'cursor-not-allowed opacity-50'
              )}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
