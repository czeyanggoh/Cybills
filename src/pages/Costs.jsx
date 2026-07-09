import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Flag,
  Image,
  ChevronDown,
  SlidersHorizontal,
  Search,
  Filter,
  Settings2,
} from 'lucide-react';
import AppShell, { useAppShell } from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import { DOCS } from '@/data/docs';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'inbox', label: 'Inbox', count: 78 },
  { key: 'processing', label: 'Processing' },
  { key: 'review', label: 'To review', count: 23 },
  { key: 'ready', label: 'Ready', count: 55 },
  { key: 'approvals', label: 'Approvals' },
  { key: 'archive', label: 'Archive' },
];

function StatusBadge({ status }) {
  const map = {
    new: 'border border-foreground font-medium text-foreground',
    viewed: 'bg-muted text-muted-foreground',
    ready: 'bg-foreground text-background',
    review: 'border border-dashed border-foreground text-foreground',
  };
  const label = { new: 'New', viewed: 'Viewed', ready: 'Ready', review: 'To review' }[status];
  return (
    <span className={cn('inline-flex rounded px-2 py-0.5 text-xs', map[status] ?? map.viewed)}>
      {label}
    </span>
  );
}

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

export default function Costs() {
  const { openAddDocuments } = useAppShell();
  const navigate = useNavigate();
  const [tab, setTab] = useState('inbox');
  const [selected, setSelected] = useState(() => new Set());

  const rowsFor = (key) => {
    if (key === 'inbox') return DOCS.filter((d) => d.status === 'new' || d.status === 'viewed');
    if (key === 'ready') return DOCS.filter((d) => d.status === 'ready');
    if (key === 'review') return DOCS.filter((d) => d.status === 'review');
    return [];
  };
  const rows = rowsFor(tab);
  const hasSelection = selected.size > 0;

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
    <AppShell subnav={<CostsSubnav />}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Costs inbox</h1>
        <button
          type="button"
          onClick={openAddDocuments}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
        >
          <Plus className="h-4 w-4" strokeWidth={2} />
          Add documents
        </button>
      </div>

      {/* Tabs */}
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

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarButton>Export all</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Archive</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Add to expense claim</ToolbarButton>
        <ToolbarButton disabled={!hasSelection} dropdown>
          Move to
        </ToolbarButton>
        <ToolbarButton dropdown>Tools</ToolbarButton>
        <div className="relative ml-auto hidden sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search"
            className="h-8 w-52 rounded-md border bg-background pl-8 pr-16 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="button"
            className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Advanced <ChevronDown className="h-3 w-3" />
          </button>
        </div>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Filter"
        >
          <Filter className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Table settings"
        >
          <Settings2 className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="w-24 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={toggleAll}
                  className="h-4 w-4 accent-black"
                />
              </th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">User</th>
              <th className="px-3 py-2.5 font-medium">Date</th>
              <th className="px-3 py-2.5 font-medium">Supplier</th>
              <th className="px-3 py-2.5 font-medium">Category</th>
              <th className="px-3 py-2.5 text-right font-medium">Total</th>
              <th className="px-3 py-2.5 text-right font-medium">Tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.id}
                onClick={() => navigate(`/costs/${d.id}`)}
                className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40"
              >
                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn('h-2 w-2 rounded-full', d.unread ? 'bg-foreground' : 'bg-transparent')}
                    />
                    <input
                      type="checkbox"
                      checked={selected.has(d.id)}
                      onChange={() => toggle(d.id)}
                      className="h-4 w-4 accent-black"
                    />
                    <Flag className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={1.75} />
                    <Image className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={1.75} />
                  </div>
                </td>
                <td className="px-3 py-3"><StatusBadge status={d.status} /></td>
                <td className={cn('px-3 py-3', d.unread && 'font-semibold')}>{d.user}</td>
                <td className="px-3 py-3 tabular-nums text-muted-foreground">{d.date}</td>
                <td className={cn('px-3 py-3', d.unread && 'font-semibold')}>{d.supplier}</td>
                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex w-48 items-center justify-between rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{d.category}</span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  <span className="text-xs text-muted-foreground">SGD </span>
                  <span className={cn(d.unread && 'font-semibold')}>{d.total}</span>
                </td>
                <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{d.tax}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  <Plus className="mx-auto mb-2 h-5 w-5" strokeWidth={1.5} />
                  Nothing in {TABS.find((t) => t.key === tab)?.label} — add documents to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {selected.size > 0 ? `${selected.size} selected · ` : ''}
          Showing {rows.length} of {tab === 'inbox' ? 78 : rows.length} documents
        </p>
      )}
    </AppShell>
  );
}
