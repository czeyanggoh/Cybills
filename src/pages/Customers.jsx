import { useState } from 'react';
import { Search, Filter } from 'lucide-react';
import AppShell from '@/components/AppShell';
import SalesSubnav from '@/components/SalesSubnav';
import SearchSelect from '@/components/SearchSelect';
import { CUSTOMERS } from '@/data/customers';
import { useCategoryOptions } from '@/lib/organisations';
import { getCustomerRule, saveCustomerRule } from '@/lib/customerRules';
import { useProjectOptions } from '@/lib/listsStore';
import { cn } from '@/lib/utils';

export default function Customers() {
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const categoryOptions = useCategoryOptions();
  const PROJECTS = useProjectOptions();
  // Per-customer Category/Project, seeded from any saved customer rule. Editing a
  // cell writes back to that customer's rule so it also applies to new uploads.
  const [assign, setAssign] = useState(() => {
    const init = {};
    for (const c of CUSTOMERS) {
      const rule = getCustomerRule(c.name);
      init[c.id] = { category: rule?.category || '', project: rule?.project || '' };
    }
    return init;
  });

  const q = query.trim().toLowerCase();
  const rows = CUSTOMERS.filter((c) => !q || c.name.toLowerCase().includes(q));
  const hasSelection = selected.size > 0;

  const setField = (customer, field, value) => {
    setAssign((a) => ({ ...a, [customer.id]: { ...a[customer.id], [field]: value } }));
    const rule = getCustomerRule(customer.name) || {};
    saveCustomerRule(customer.name, { ...rule, [field]: value });
  };

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))));

  return (
    <AppShell subnav={<SalesSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Customers</h1>
        <button type="button" className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted">
          Add new customer
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={!hasSelection} className={cn('inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors', hasSelection ? 'hover:bg-muted' : 'cursor-not-allowed text-muted-foreground/50')}>
          Actions
        </button>
        <button type="button" className="inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors hover:bg-muted">
          Import from CSV
        </button>
        <div className="relative ml-auto hidden sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name"
            className="h-8 w-52 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Filter">
          <Filter className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="w-10 px-3 py-2.5">
                <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} className="h-4 w-4 accent-black" />
              </th>
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="w-1/3 px-3 py-2.5 font-medium">Category</th>
              <th className="w-1/3 px-3 py-2.5 font-medium">Project</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <td className="px-3 py-3">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="h-4 w-4 accent-black" />
                </td>
                <td className="px-3 py-3 font-medium">{c.name}</td>
                <td className="px-3 py-3">
                  <SearchSelect
                    compact
                    value={assign[c.id]?.category || ''}
                    options={categoryOptions}
                    onChange={(v) => setField(c, 'category', v)}
                  />
                </td>
                <td className="px-3 py-3">
                  <SearchSelect
                    compact
                    value={assign[c.id]?.project || ''}
                    options={PROJECTS}
                    onChange={(v) => setField(c, 'project', v)}
                  />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  No customers match “{query}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>
    </AppShell>
  );
}
