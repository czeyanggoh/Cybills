import { useState } from 'react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import SalesSubnav from '@/components/SalesSubnav';
import { useExports, getExportBlob } from '@/lib/exportsStore';
import { downloadExportBlob } from '@/lib/docsExport';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'costs', label: 'Costs' },
  { key: 'sales', label: 'Sales' },
  { key: 'claims', label: 'Expense claims' },
  { key: 'bank', label: 'Bank' },
];

function ExportsTable({ kind }) {
  const rows = useExports(kind);

  const download = async (id) => {
    const rec = await getExportBlob(id);
    if (rec?.blob) downloadExportBlob(rec);
  };

  if (rows.length === 0) {
    return <p className="rounded-lg border bg-muted/20 px-4 py-16 text-center text-sm text-muted-foreground">No exports generated yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="border-b bg-muted/40 text-left text-muted-foreground">
          <tr>
            <th className="px-3 py-2.5 font-medium">Date generated</th>
            <th className="px-3 py-2.5 font-medium">Name</th>
            <th className="px-3 py-2.5 font-medium">Format</th>
            <th className="px-3 py-2.5 font-medium">CSV Format</th>
            <th className="px-3 py-2.5 font-medium">Number of items</th>
            <th className="px-3 py-2.5 font-medium">Exported by</th>
            <th className="px-3 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className="border-b last:border-0 hover:bg-muted/40">
              <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{e.generated}</td>
              <td className="max-w-[220px] truncate px-3 py-3 font-medium" title={e.filename}>{e.filename}</td>
              <td className="px-3 py-3">{e.format}</td>
              <td className="px-3 py-3 text-muted-foreground">{e.csvFormat}</td>
              <td className="px-3 py-3 tabular-nums">{e.count}</td>
              <td className="whitespace-nowrap px-3 py-3">{e.exportedBy}</td>
              <td className="px-3 py-3 text-right">
                <button type="button" onClick={() => download(e.id)} className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted">
                  Download
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Exports({ workspace = 'costs' }) {
  const [tab, setTab] = useState(workspace === 'sales' ? 'sales' : 'costs');
  // Standalone top-level Exports page (workspace="all") shows no Costs/Sales
  // subnav — it's its own destination, like Dext's Exports.
  const subnav = workspace === 'all' ? undefined : workspace === 'sales' ? <SalesSubnav /> : <CostsSubnav />;

  return (
    <AppShell subnav={subnav}>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Exports</h1>
      <div className="mb-4 flex items-center gap-6 overflow-x-auto border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn('-mb-px border-b-2 pb-3 pt-1 text-sm transition-colors', tab === t.key ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ExportsTable kind={tab} />
    </AppShell>
  );
}
