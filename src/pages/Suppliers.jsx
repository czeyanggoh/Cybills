import { useState } from 'react';
import { Search, Filter, Settings2 } from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import SearchSelect from '@/components/SearchSelect';
import SupplierRulesModal from '@/components/SupplierRulesModal';
import SupplierDuplicatesModal from '@/components/SupplierDuplicatesModal';
import SupplierImportModal from '@/components/SupplierImportModal';
import { useCategoryOptions, useXeroSuppliers, useXeroCustomers, useXeroProjectOptions, useXeroPaymentMethods, useVisibleTaxRates } from '@/lib/organisations';
import { useGstRegistered } from '@/lib/businessProfile';
import { noTaxRateName } from '@/lib/extractionSettings';
import { useCostsDocs } from '@/lib/costsData';
import { getSupplierRule, setSupplierRule, supplierRuleCount, useSupplierRules } from '@/lib/supplierRules';
import { cn } from '@/lib/utils';

// Optional columns, mirroring Dext's "table settings" panel. Everything but Tax
// rate is on by default.
const OPTIONAL_COLS = [
  { key: 'extractLineItems', label: 'Extract line items', primary: true },
  { key: 'extractStatements', label: 'Extract supplier statements', primary: true },
  { key: 'category', label: 'Category', primary: true },
  { key: 'customer', label: 'Customer', primary: true },
  { key: 'project', label: 'Project', primary: true },
  { key: 'taxRate', label: 'Tax rate', primary: false },
];
const DEFAULT_COLS = { extractLineItems: true, extractStatements: true, category: true, customer: true, project: true, taxRate: false };

// Small b&w toggle used per-row.
function RowToggle({ on = false, onToggle = () => {} }) {
  return (
    <button type="button" onClick={onToggle} className="inline-flex items-center gap-2 text-xs">
      <span className={cn('flex h-4 w-7 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-foreground' : 'justify-start bg-muted')}>
        <span className="h-3 w-3 rounded-full bg-background" />
      </span>
      <span className="text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

function ToolbarButton({ children, disabled = false, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors',
        disabled ? 'cursor-not-allowed text-muted-foreground/50' : 'hover:bg-muted'
      )}
    >
      {children}
    </button>
  );
}

export default function Suppliers() {
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [itemsFilter, setItemsFilter] = useState(''); // '' | 'has' | 'none'
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState('');
  const [cols, setCols] = useState(DEFAULT_COLS);
  const [colsOpen, setColsOpen] = useState(false);
  const [colsDraft, setColsDraft] = useState(DEFAULT_COLS);
  const [dupOpen, setDupOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const categoryOptions = useCategoryOptions();
  // Suppliers + customers come from the active org's (CYBM) live Xero contacts.
  const supplierNames = useXeroSuppliers();
  const customerOptions = useXeroCustomers();
  const projectOptions = useXeroProjectOptions(0);
  const paymentMethods = useXeroPaymentMethods();
  const taxRateSource = useVisibleTaxRates();
  const gstRegistered = useGstRegistered();
  const taxRateOptions = gstRegistered
    ? taxRateSource.map((t) => t.name)
    : [noTaxRateName(taxRateSource)].filter(Boolean);
  const { allDocs } = useCostsDocs();
  const [rulesFor, setRulesFor] = useState('');
  useSupplierRules(); // re-render when a supplier's rules change

  // How many cost documents each supplier has, by name.
  const counts = {};
  for (const d of allDocs || []) {
    const k = String(d.supplier || '').trim().toLowerCase();
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  const q = query.trim().toLowerCase();
  const rows = supplierNames
    .filter((name) => !q || name.toLowerCase().includes(q))
    .map((name) => ({ id: name, name, items: counts[name.trim().toLowerCase()] || 0 }))
    .filter((r) => (itemsFilter === 'has' ? r.items > 0 : itemsFilter === 'none' ? r.items === 0 : true));
  const hasSelection = selected.size > 0;

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openFilter = () => { setFilterDraft(itemsFilter); setFilterOpen((o) => !o); setColsOpen(false); };
  const applyFilter = () => { setItemsFilter(filterDraft); setFilterOpen(false); };
  const openCols = () => { setColsDraft(cols); setColsOpen((o) => !o); setFilterOpen(false); };
  const applyCols = () => { setCols(colsDraft); setColsOpen(false); };

  // Header + cell for one optional column, rendered only when it's on.
  const show = (key) => cols[key];

  return (
    <AppShell subnav={<CostsSubnav />}>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Suppliers</h1>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarButton disabled={!hasSelection}>Bulk edit</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Merge suppliers</ToolbarButton>
        <ToolbarButton onClick={() => setImportOpen(true)}>Import from CSV</ToolbarButton>
        <ToolbarButton onClick={() => setDupOpen(true)}>Supplier duplicates</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Delete</ToolbarButton>
        <div className="relative ml-auto hidden sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name" className="h-8 w-52 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        </div>

        {/* Filter — by whether a supplier has inbox items */}
        <div className="relative">
          <button
            type="button"
            onClick={openFilter}
            className={cn('flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-muted', itemsFilter ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
            aria-label="Filter"
          >
            <Filter className="h-4 w-4" strokeWidth={1.75} />
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} aria-hidden="true" />
              <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border bg-background p-4 shadow-lg">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter</p>
                <div className="mb-4 flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Filter by</span>
                  <div className="ml-auto flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setFilterDraft((v) => (v === 'has' ? '' : 'has'))}
                      className={cn('rounded-md border px-2.5 py-1 text-xs transition-colors', filterDraft === 'has' ? 'border-foreground bg-foreground text-background' : 'hover:bg-muted')}
                    >
                      Has inbox items
                    </button>
                    <button
                      type="button"
                      onClick={() => setFilterDraft((v) => (v === 'none' ? '' : 'none'))}
                      className={cn('rounded-md border px-2.5 py-1 text-xs transition-colors', filterDraft === 'none' ? 'border-foreground bg-foreground text-background' : 'hover:bg-muted')}
                    >
                      No inbox items
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={() => setFilterDraft('')} className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors hover:bg-muted">Reset</button>
                  <button type="button" onClick={applyFilter} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90">Apply</button>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Table settings — which optional columns to show */}
        <div className="relative">
          <button
            type="button"
            onClick={openCols}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Table settings"
          >
            <Settings2 className="h-4 w-4" strokeWidth={1.75} />
          </button>
          {colsOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setColsOpen(false)} aria-hidden="true" />
              <div className="absolute right-0 z-20 mt-1 w-72 rounded-md border bg-background p-4 shadow-lg">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Primary columns</p>
                <div className="grid grid-cols-2 gap-2">
                  {OPTIONAL_COLS.filter((c) => c.primary).map((c) => (
                    <label key={c.key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={Boolean(colsDraft[c.key])} onChange={(e) => setColsDraft((s) => ({ ...s, [c.key]: e.target.checked }))} className="h-4 w-4 accent-black" />
                      {c.label}
                    </label>
                  ))}
                </div>
                <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Additional columns</p>
                <div className="grid grid-cols-2 gap-2">
                  {OPTIONAL_COLS.filter((c) => !c.primary).map((c) => (
                    <label key={c.key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={Boolean(colsDraft[c.key])} onChange={(e) => setColsDraft((s) => ({ ...s, [c.key]: e.target.checked }))} className="h-4 w-4 accent-black" />
                      {c.label}
                    </label>
                  ))}
                </div>
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button type="button" onClick={() => setColsDraft(DEFAULT_COLS)} className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors hover:bg-muted">Reset</button>
                  <button type="button" onClick={applyCols} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90">Apply</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="w-10 px-3 py-2.5"><span className="sr-only">Select</span></th>
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Items</th>
              {show('extractLineItems') && <th className="px-3 py-2.5 font-medium">Extract line items</th>}
              {show('extractStatements') && <th className="px-3 py-2.5 font-medium">Extract supplier statements</th>}
              {show('category') && <th className="px-3 py-2.5 font-medium">Category</th>}
              {show('customer') && <th className="px-3 py-2.5 font-medium">Customer</th>}
              {show('project') && <th className="px-3 py-2.5 font-medium">Project</th>}
              {show('taxRate') && <th className="px-3 py-2.5 font-medium">Tax rate</th>}
              <th className="px-3 py-2.5 font-medium">Rules</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <td className="px-3 py-3">
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} className="h-4 w-4 accent-black" />
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-medium">{s.name}</td>
                <td className="px-3 py-3 tabular-nums text-muted-foreground">{s.items}</td>
                {show('extractLineItems') && (
                  <td className="px-3 py-3">
                    <RowToggle
                      on={Boolean(getSupplierRule(s.id).extractLineItems)}
                      onToggle={() => setSupplierRule(s.id, { extractLineItems: !getSupplierRule(s.id).extractLineItems })}
                    />
                  </td>
                )}
                {show('extractStatements') && (
                  <td className="px-3 py-3">
                    <RowToggle
                      on={getSupplierRule(s.id).extractStatements !== false}
                      onToggle={() => setSupplierRule(s.id, { extractStatements: getSupplierRule(s.id).extractStatements === false })}
                    />
                  </td>
                )}
                {show('category') && (
                  <td className="px-3 py-3">
                    <div className="w-40">
                      <SearchSelect compact value={getSupplierRule(s.id).category || ''} options={categoryOptions} onChange={(v) => setSupplierRule(s.id, { category: v })} />
                    </div>
                  </td>
                )}
                {show('customer') && (
                  <td className="px-3 py-3">
                    <div className="w-40">
                      <SearchSelect compact value={getSupplierRule(s.id).customer || ''} options={customerOptions} onChange={(v) => setSupplierRule(s.id, { customer: v })} />
                    </div>
                  </td>
                )}
                {show('project') && (
                  <td className="px-3 py-3">
                    <div className="w-40">
                      <SearchSelect compact value={getSupplierRule(s.id).project || ''} options={projectOptions} onChange={(v) => setSupplierRule(s.id, { project: v })} />
                    </div>
                  </td>
                )}
                {show('taxRate') && (
                  <td className="px-3 py-3">
                    <div className="w-40">
                      <SearchSelect compact value={getSupplierRule(s.id).taxRate || ''} options={taxRateOptions} onChange={(v) => setSupplierRule(s.id, { taxRate: v })} />
                    </div>
                  </td>
                )}
                <td className="px-3 py-3">
                  <button
                    type="button"
                    onClick={() => setRulesFor(s.id)}
                    className="whitespace-nowrap text-xs font-medium text-emerald-600 hover:underline"
                  >
                    {supplierRuleCount(getSupplierRule(s.id)) > 0 ? 'Edit rules' : 'Set rules'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p className="mt-4 rounded-lg border bg-muted/20 px-4 py-12 text-center text-sm text-muted-foreground">
          {itemsFilter || q ? 'No suppliers match the current filter.' : 'No Xero supplier contacts found for this organisation.'}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Showing {rows.length} supplier{rows.length === 1 ? '' : 's'}
        {itemsFilter === 'has' ? ' with inbox items' : itemsFilter === 'none' ? ' with no inbox items' : ''}
      </p>

      <SupplierRulesModal
        open={Boolean(rulesFor)}
        supplier={rulesFor}
        categoryOptions={categoryOptions}
        customerOptions={customerOptions}
        projectOptions={projectOptions}
        taxRateOptions={taxRateOptions}
        paymentMethodOptions={paymentMethods.map((p) => p.label)}
        gstRegistered={gstRegistered}
        onClose={() => setRulesFor('')}
      />
      <SupplierDuplicatesModal
        open={dupOpen}
        names={supplierNames}
        onClose={() => setDupOpen(false)}
        onPick={(name) => { setDupOpen(false); setRulesFor(name); }}
      />
      <SupplierImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </AppShell>
  );
}
