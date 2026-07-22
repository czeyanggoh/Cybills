import { useState } from 'react';
import { ShoppingCart, Download } from 'lucide-react';
import AppShell from '@/components/AppShell';
import VaultSubnav from '@/components/VaultSubnav';
import { useVaultDownloads, removeVaultDownloads } from '@/lib/vaultDownloads';
import { cn } from '@/lib/utils';

export default function VaultDownloads() {
  const downloads = useVaultDownloads();
  const [selected, setSelected] = useState(() => new Set());
  const hasSelection = selected.size > 0;

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => (prev.size === downloads.length ? new Set() : new Set(downloads.map((d) => d.id))));
  const del = () => {
    if (hasSelection) { removeVaultDownloads([...selected]); setSelected(new Set()); }
  };

  return (
    <AppShell subnav={<VaultSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Downloads</h1>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <button type="button" disabled={!hasSelection} onClick={del} className={cn('inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors', hasSelection ? 'hover:bg-muted' : 'cursor-not-allowed text-muted-foreground/50')}>
          Delete
        </button>
      </div>

      {downloads.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <ShoppingCart className="mb-4 h-14 w-14 text-muted-foreground/40" strokeWidth={1.25} />
          <h2 className="text-lg font-semibold">No downloads yet.</h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            Once you download multiple files or folders, the ZIP archives containing those files will
            appear here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2.5"><input type="checkbox" checked={downloads.length > 0 && selected.size === downloads.length} onChange={toggleAll} className="h-4 w-4 accent-black" /></th>
                <th className="px-3 py-2.5 font-medium">Archive</th>
                <th className="px-3 py-2.5 font-medium">Files</th>
                <th className="px-3 py-2.5 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {downloads.map((d) => (
                <tr key={d.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                  <td className="px-3 py-3"><input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} className="h-4 w-4 accent-black" /></td>
                  <td className="flex items-center gap-2 px-3 py-3 font-medium">
                    <Download className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} /> {d.name}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{d.count} file(s)</td>
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{d.created}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {downloads.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {downloads.length} of {downloads.length} items</p>}
    </AppShell>
  );
}
