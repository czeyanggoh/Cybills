import { useState } from 'react';
import { Search, Filter, Tag as TagIcon } from 'lucide-react';
import AppShell from '@/components/AppShell';
import VaultSubnav from '@/components/VaultSubnav';
import AddTagsModal from '@/components/AddTagsModal';
import { useVaultTags, removeVaultTags } from '@/lib/vaultTags';
import { cn } from '@/lib/utils';

export default function VaultTags() {
  const tags = useVaultTags();
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const rows = tags.filter((t) => !q || t.name.toLowerCase().includes(q));
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
  const del = () => {
    if (hasSelection) { removeVaultTags([...selected]); setSelected(new Set()); }
  };

  return (
    <AppShell subnav={<VaultSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Tags</h1>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setAddOpen(true)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted">
          Add tags
        </button>
        <button type="button" disabled={!hasSelection} onClick={del} className={cn('inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors', hasSelection ? 'hover:bg-muted' : 'cursor-not-allowed text-muted-foreground/50')}>
          Delete
        </button>
        <div className="relative ml-auto hidden sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name" className="h-8 w-56 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        </div>
        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Filter">
          <Filter className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <TagIcon className="mb-4 h-14 w-14 text-muted-foreground/40" strokeWidth={1.25} />
          <h2 className="text-lg font-semibold">No tags yet</h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            {q ? `No tags match “${query}”.` : 'Upload files to your Vault Workspace and tag them. Their tags will appear here.'}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2.5"><input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} className="h-4 w-4 accent-black" /></th>
                <th className="px-3 py-2.5 font-medium">Tag</th>
                <th className="px-3 py-2.5 font-medium">Rules</th>
                <th className="px-3 py-2.5 font-medium">Auto-apply</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                  <td className="px-3 py-3"><input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} className="h-4 w-4 accent-black" /></td>
                  <td className="px-3 py-3">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                      <TagIcon className="h-3 w-3" strokeWidth={2} /> {t.name}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{t.rules || '—'}</td>
                  <td className="px-3 py-3">{t.autoApply ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>}

      <AddTagsModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={() => setAddOpen(false)} />
    </AppShell>
  );
}
