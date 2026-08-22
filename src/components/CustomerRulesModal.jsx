import { useState } from 'react';
import { X, Info, ChevronDown, Trash2 } from 'lucide-react';
import {
  emptyRule,
  getCustomerRule,
  saveCustomerRule,
  CURRENCIES,
  DUE_DATE_OPTIONS,
  GROUP_BY_OPTIONS,
} from '@/lib/customerRules';
import { useProjectOptions } from '@/lib/listsStore';
import { cn } from '@/lib/utils';
import ComboSelect from '@/components/ComboSelect';
import SearchSelect from '@/components/SearchSelect';

function FieldLabel({ children }) {
  return <label className="mb-1.5 block text-sm text-muted-foreground">{children}</label>;
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

const FIXED_COLS = ['Description', 'Category', 'Tax amount', 'Project(optional)', 'Quantity', 'Total amount'];
const PCT_COLS = ['Description', 'Category', 'Project(optional)', 'Quantity', 'Percentage amount'];

// Smart split editor — fixed-amount and percentage line rules for new documents
// from this customer.
function SmartSplitModal({ open, customer, value, categoryOptions, onClose, onDone }) {
  const [fixed, setFixed] = useState(value?.fixed ?? []);
  const [percentage, setPercentage] = useState(value?.percentage ?? []);
  if (!open) return null;

  const addFixed = () =>
    setFixed((r) => [...r, { description: '', category: '', tax: '', project: '', quantity: '1', total: '' }]);
  const addPct = () =>
    setPercentage((r) => [...r, { description: '', category: '', project: '', quantity: '1', percentage: '' }]);
  const patch = (setter) => (i, key, val) =>
    setter((rows) => rows.map((row, idx) => (idx === i ? { ...row, [key]: val } : row)));
  const remove = (setter) => (i) => setter((rows) => rows.filter((_, idx) => idx !== i));

  const cell = 'h-9 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const CatCell = ({ v, onChange }) => (
    <ComboSelect aria-label="Category" value={v} options={categoryOptions} onChange={onChange} emptyLabel="Select" />
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Smart split: {customer}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-auto p-6">
          <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            Use Smart split to create line items on new documents from this customer according to a
            fixed amount or percentage of the total.
          </p>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fixed amount</h3>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="border-b bg-muted/40 text-left text-muted-foreground">
                  <tr>{FIXED_COLS.map((c) => <th key={c} className="px-3 py-2.5 font-medium">{c}</th>)}<th className="w-10" /></tr>
                </thead>
                <tbody>
                  {fixed.map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-3 py-2"><input className={cell} value={row.description} onChange={(e) => patch(setFixed)(i, 'description', e.target.value)} /></td>
                      <td className="px-3 py-2"><CatCell v={row.category} onChange={(v) => patch(setFixed)(i, 'category', v)} /></td>
                      <td className="px-3 py-2"><input className={cell} inputMode="decimal" value={row.tax} onChange={(e) => patch(setFixed)(i, 'tax', e.target.value)} /></td>
                      <td className="px-3 py-2"><input className={cell} value={row.project} onChange={(e) => patch(setFixed)(i, 'project', e.target.value)} /></td>
                      <td className="px-3 py-2"><input className={cell} inputMode="numeric" value={row.quantity} onChange={(e) => patch(setFixed)(i, 'quantity', e.target.value)} /></td>
                      <td className="px-3 py-2"><input className={cell} inputMode="decimal" value={row.total} onChange={(e) => patch(setFixed)(i, 'total', e.target.value)} /></td>
                      <td className="px-2 py-2 text-center">
                        <button type="button" onClick={() => remove(setFixed)(i)} className="text-muted-foreground hover:text-destructive" aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
                      </td>
                    </tr>
                  ))}
                  {fixed.length === 0 && <tr><td colSpan={FIXED_COLS.length + 1} className="px-3 py-6 text-center text-xs text-muted-foreground">No fixed-amount rules yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <button type="button" onClick={addFixed} className="mt-3 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
              + Add a fixed amount rule
            </button>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Percentage amount</h3>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b bg-muted/40 text-left text-muted-foreground">
                  <tr>{PCT_COLS.map((c) => <th key={c} className="px-3 py-2.5 font-medium">{c}</th>)}<th className="w-10" /></tr>
                </thead>
                <tbody>
                  {percentage.map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="px-3 py-2"><input className={cell} value={row.description} onChange={(e) => patch(setPercentage)(i, 'description', e.target.value)} /></td>
                      <td className="px-3 py-2"><CatCell v={row.category} onChange={(v) => patch(setPercentage)(i, 'category', v)} /></td>
                      <td className="px-3 py-2"><input className={cell} value={row.project} onChange={(e) => patch(setPercentage)(i, 'project', e.target.value)} /></td>
                      <td className="px-3 py-2"><input className={cell} inputMode="numeric" value={row.quantity} onChange={(e) => patch(setPercentage)(i, 'quantity', e.target.value)} /></td>
                      <td className="px-3 py-2"><input className={cell} inputMode="decimal" value={row.percentage} onChange={(e) => patch(setPercentage)(i, 'percentage', e.target.value)} /></td>
                      <td className="px-2 py-2 text-center">
                        <button type="button" onClick={() => remove(setPercentage)(i)} className="text-muted-foreground hover:text-destructive" aria-label="Remove"><Trash2 className="h-4 w-4" /></button>
                      </td>
                    </tr>
                  ))}
                  {percentage.length === 0 && <tr><td colSpan={PCT_COLS.length + 1} className="px-3 py-6 text-center text-xs text-muted-foreground">No percentage rules yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <button type="button" onClick={addPct} className="mt-3 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
              + Add a percentage amount rule
            </button>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button type="button" onClick={() => onDone({ fixed, percentage })} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">Done</button>
        </div>
      </div>
    </div>
  );
}

// "Customer rules" dialog — defaults applied to every new document from this
// customer. Mirrors Dext's customer-rules editor. `onApply` receives the saved
// rule so the caller can also reflect it on the open document.
export default function CustomerRulesModal({ open, customer, categoryOptions = [], onClose, onApply }) {
  const [rule, setRule] = useState(() => ({ ...emptyRule(), ...(getCustomerRule(customer) || {}) }));
  const [splitOpen, setSplitOpen] = useState(false);
  const PROJECTS = useProjectOptions();
  if (!open) return null;

  const set = (k, v) => setRule((r) => ({ ...r, [k]: v }));
  const dueOpt = DUE_DATE_OPTIONS.find((o) => o.value === rule.dueMode);
  const splitCount = (rule.smartSplit?.fixed?.length || 0) + (rule.smartSplit?.percentage?.length || 0);

  const apply = () => {
    saveCustomerRule(customer, rule);
    onApply?.(rule);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Customer rules: {customer || 'Customer'}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <p className="mb-6 flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Set a rule and it&rsquo;ll be applied whenever you upload something new from this
              customer. Looking just to edit existing <span className="font-medium text-foreground">{customer}</span> items?
              Use bulk edit in the inbox.
            </span>
          </p>

          <div className="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-2">
            {/* Left column */}
            <div>
              <FieldLabel>Currency</FieldLabel>
              <Select value={rule.currency} onChange={(v) => set('currency', v)}>
                <option value="">Select</option>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </Select>
            </div>
            {/* Right column */}
            <div>
              <FieldLabel>Category</FieldLabel>
              <ComboSelect
                aria-label="Category"
                value={rule.category}
                options={categoryOptions}
                onChange={(v) => set('category', v)}
                emptyLabel="Select"
              />
            </div>

            <div>
              <FieldLabel>Due date</FieldLabel>
              <div className="flex gap-2">
                {dueOpt?.needsDays && (
                  <input
                    value={rule.dueDays}
                    onChange={(e) => set('dueDays', e.target.value)}
                    inputMode="numeric"
                    placeholder="0"
                    className="h-10 w-20 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                )}
                <div className="flex-1">
                  <Select value={rule.dueMode} onChange={(v) => set('dueMode', v)}>
                    {DUE_DATE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                </div>
              </div>
            </div>
            <div>
              <FieldLabel>Extract line items</FieldLabel>
              <div className="pt-1"><Toggle on={rule.extractLineItems} onToggle={() => set('extractLineItems', !rule.extractLineItems)} /></div>
            </div>

            <div>
              <FieldLabel>Project</FieldLabel>
              <SearchSelect value={rule.project} options={PROJECTS} onChange={(v) => set('project', v)} />
            </div>
            <div>
              <FieldLabel>Group line items by</FieldLabel>
              <Select value={rule.groupBy} onChange={(v) => set('groupBy', v)}>
                {GROUP_BY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            </div>

            <div className="hidden md:block" />
            <div>
              <FieldLabel>Automatically add balancing line</FieldLabel>
              <div className="pt-1"><Toggle on={rule.autoBalancing} onToggle={() => set('autoBalancing', !rule.autoBalancing)} /></div>
            </div>

            <div className="md:col-start-2 md:-mt-1">
              <FieldLabel>Description</FieldLabel>
              <textarea
                rows={2}
                value={rule.description}
                onChange={(e) => set('description', e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setSplitOpen(true)}
            className="mt-6 flex w-full items-center justify-center rounded-lg border border-dashed py-3 text-sm font-medium transition-colors hover:bg-muted"
          >
            + Create smart split rules{splitCount > 0 && <span className="ml-2 rounded-full bg-muted px-2 text-xs text-muted-foreground">{splitCount}</span>}
          </button>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button type="button" onClick={apply} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">Apply</button>
        </div>
      </div>

      <SmartSplitModal
        open={splitOpen}
        customer={customer}
        value={rule.smartSplit}
        categoryOptions={categoryOptions}
        onClose={() => setSplitOpen(false)}
        onDone={(smartSplit) => { set('smartSplit', smartSplit); setSplitOpen(false); }}
      />
    </div>
  );
}
