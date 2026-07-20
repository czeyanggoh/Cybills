import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Flag, Image, ChevronDown, Search, Filter, Settings2 } from 'lucide-react';
import AppShell, { AddDocumentsButton } from '@/components/AppShell';
import SalesSubnav from '@/components/SalesSubnav';
import { SALES } from '@/data/sales';
import { useCategoryOptions } from '@/lib/organisations';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'inbox', label: 'Inbox', count: 2 },
  { key: 'processing', label: 'Processing' },
  { key: 'review', label: 'To review' },
  { key: 'ready', label: 'Ready' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'archive', label: 'Archive' },
];

function ToolbarButton({ children, disabled = false, dropdown = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors',
        disabled ? 'cursor-not-allowed text-muted-foreground/50' : 'hover:bg-muted'
      )}
    >
      {children}
      {dropdown && <ChevronDown className="h-3.5 w-3.5" />}
    </button>
  );
}

export default function Sales() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('inbox');
  const [selected, setSelected] = useState(() => new Set());
  const categoryOptions = useCategoryOptions();

  const rows = tab === 'inbox' ? SALES : [];
  const hasSelection = selected.size > 0;

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <AppShell subnav={<SalesSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Sales inbox</h1>
        <AddDocumentsButton />
      </div>

      <div className="mb-4 flex items-center gap-6 overflow-x-auto border-b">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                setSelected(new Set());
              }}
              className={cn(
                '-mb-px flex shrink-0 items-center gap-2 border-b-2 pb-3 pt-1 text-sm transition-colors',
                active
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t.label}
              {t.count != null && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-xs',
                    active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarButton>Export all</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Archive</ToolbarButton>
        <ToolbarButton disabled={!hasSelection} dropdown>Move to</ToolbarButton>
        <ToolbarButton dropdown>Actions</ToolbarButton>
        <div className="relative ml-auto hidden sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search"
            className="h-8 w-52 rounded-md border bg-background pl-8 pr-16 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button type="button" className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
            Advanced <ChevronDown className="h-3 w-3" />
          </button>
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
              <th className="w-24 px-3 py-2.5"><span className="sr-only">Select</span></th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">User</th>
              <th className="px-3 py-2.5 font-medium">Date</th>
              <th className="px-3 py-2.5 font-medium">Customer</th>
              <th className="px-3 py-2.5 font-medium">Category</th>
              <th className="px-3 py-2.5 font-medium">Document reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.id}
                onClick={() => navigate(`/sales/${d.id}`)}
                className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40"
              >
                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} className="h-4 w-4 accent-black" />
                    <Flag className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={1.75} />
                    <Image className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={1.75} />
                  </div>
                </td>
                <td className="px-3 py-3">
                  <span className="inline-flex rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Viewed</span>
                </td>
                <td className="whitespace-nowrap px-3 py-3">{d.user}</td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{d.date}</td>
                <td className="px-3 py-3">{d.customer}</td>
                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                  <select defaultValue={d.category} className="w-44 rounded-md border bg-background px-2 py-1.5 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {!categoryOptions.includes(d.category) && <option value={d.category}>{d.category}</option>}
                    {categoryOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-muted-foreground">{d.ref}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  Nothing in {TABS.find((t) => t.key === tab)?.label}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>}
    </AppShell>
  );
}
