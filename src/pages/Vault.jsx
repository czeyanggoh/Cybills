import { useState } from 'react';
import { Flag, FileText, ChevronDown, Filter, Settings2, LayoutGrid, Folder } from 'lucide-react';
import AppShell, { AddDocumentsButton } from '@/components/AppShell';
import VaultSubnav from '@/components/VaultSubnav';
import { VAULT_FILES } from '@/data/vaultFiles';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'folders', label: 'Folders' },
  { key: 'all', label: 'All files' },
  { key: 'review', label: 'To review', count: 1 },
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

export default function Vault() {
  const [tab, setTab] = useState('folders');
  const [selected, setSelected] = useState(() => new Set());

  const rows = VAULT_FILES;
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
    <AppShell subnav={<VaultSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Vault</h1>
        <AddDocumentsButton />
      </div>

      <div className="mb-4 flex items-center gap-6 border-b">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 pb-3 pt-1 text-sm transition-colors',
                active ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t.label}
              {t.count != null && (
                <span className={cn('rounded-full px-1.5 text-xs', active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground')}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarButton>Create folder</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Download</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Move</ToolbarButton>
        <ToolbarButton disabled={!hasSelection}>Delete</ToolbarButton>
        <ToolbarButton dropdown>Actions</ToolbarButton>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Filter">
            <Filter className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Settings">
            <Settings2 className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Grid view">
            <LayoutGrid className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Folder className="h-4 w-4" strokeWidth={1.75} />
        CYBM Workspace
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="w-24 px-3 py-2.5">
                <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} className="h-4 w-4 accent-black" />
              </th>
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">Tags</th>
              <th className="px-3 py-2.5 font-medium">Date added</th>
              <th className="px-3 py-2.5 font-medium">Creator</th>
              <th className="px-3 py-2.5 font-medium">Access</th>
              <th className="px-3 py-2.5 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 accent-black" />
                    <Flag className={cn('h-3.5 w-3.5', f.flagged ? 'fill-foreground text-foreground' : 'text-muted-foreground/60')} strokeWidth={1.75} />
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-semibold text-muted-foreground">PDF</span>
                  </div>
                </td>
                <td className="flex items-center gap-2 px-3 py-3">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="truncate">{f.name}</span>
                </td>
                <td className="px-3 py-3 text-muted-foreground">—</td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{f.dateAdded}</td>
                <td className="whitespace-nowrap px-3 py-3">{f.creator}</td>
                <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{f.access}</td>
                <td className="px-3 py-3">
                  <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors hover:bg-muted">
                    Actions <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>
    </AppShell>
  );
}
