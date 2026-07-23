import { useState } from 'react';
import { Search, Filter, Settings2 } from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import SearchSelect from '@/components/SearchSelect';
import { SUPPLIERS } from '@/data/suppliers';
import { CUSTOMERS } from '@/data/customers';
import { useCategoryOptions } from '@/lib/organisations';
import { getSupplierRule, setSupplierRule, useSupplierRules } from '@/lib/supplierRules';
import { cn } from '@/lib/utils';

// Small b&w toggle used per-row.
function RowToggle({ defaultOn = false }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button type="button" onClick={() => setOn((v) => !v)} className="inline-flex items-center gap-2 text-xs">
      <span className={cn('flex h-4 w-7 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-foreground' : 'justify-start bg-muted')}>
        <span className="h-3 w-3 rounded-full bg-background" />
      </span>
      <span className="text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

function ToolbarButton({ children, disabled = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
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
  const rows = SUPPLIERS;
  const hasSelection = selected.size > 0;
  const categoryOptions = useCategoryOptions();
  const customerOptions = CUSTOMERS.map((c) => c.name);
  useSupplierRules(); // re-render when a supplier's category/customer changes

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <AppShell subnav={<CostsSubnav />}>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Suppliers</h1>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarButton disabled={!hasSelection}>Bulk edit</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Merge suppliers</ToolbarButton>
        <ToolbarButton>Import from CSV</ToolbarButton>
        <ToolbarButton>Supplier duplicates</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Delete</ToolbarButton>
        <div className="relative ml-auto hidden sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="text" placeholder="Filter by name" className="h-8 w-52 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Filter">
          <Filter className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Table settings">
          <Settings2 className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="w-10 px-3 py-2.5"><span className="sr-only">Select</span></th>
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Items</th>
              <th className="px-3 py-2.5 font-medium">Extract line items</th>
              <th className="px-3 py-2.5 font-medium">Extract supplier statements</th>
              <th className="px-3 py-2.5 font-medium">Category</th>
              <th className="px-3 py-2.5 font-medium">Customer</th>
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
                <td className="px-3 py-3"><RowToggle defaultOn={s.extractLines} /></td>
                <td className="px-3 py-3"><RowToggle defaultOn={s.extractStatements} /></td>
                <td className="px-3 py-3">
                  <div className="w-40">
                    <SearchSelect
                      compact
                      value={getSupplierRule(s.id).category || ''}
                      options={categoryOptions}
                      onChange={(v) => setSupplierRule(s.id, { category: v })}
                    />
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div className="w-40">
                    <SearchSelect
                      compact
                      value={getSupplierRule(s.id).customer || ''}
                      options={customerOptions}
                      onChange={(v) => setSupplierRule(s.id, { customer: v })}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of 307 items</p>
    </AppShell>
  );
}
