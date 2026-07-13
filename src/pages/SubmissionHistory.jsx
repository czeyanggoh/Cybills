import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Image, Download, FileCheck, Search, ChevronDown } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { SUBMISSIONS } from '@/data/submissions';
import { cn } from '@/lib/utils';

const TABS = ['Costs and sales', 'Supplier statements', 'Vault'];

function StatusBadge({ status }) {
  const map = {
    ready: 'bg-foreground text-background',
    review: 'border border-dashed border-foreground text-foreground',
    expenseclaim: 'bg-muted text-muted-foreground',
  };
  const label = { ready: 'Ready', review: 'To review', expenseclaim: 'In expense claim' }[status];
  return <span className={cn('inline-flex whitespace-nowrap rounded px-2 py-0.5 text-xs', map[status] ?? map.expenseclaim)}>{label}</span>;
}

export default function SubmissionHistory() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('Costs and sales');
  const rows = tab === 'Costs and sales' ? SUBMISSIONS : [];

  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Submission history</h1>

      <div className="mb-4 flex items-center gap-6 border-b">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px border-b-2 pb-3 pt-1 text-sm transition-colors',
              tab === t ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className="inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors hover:bg-muted">
          Export history
        </button>
        <div className="relative ml-auto hidden sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="text" placeholder="Search" className="h-8 w-52 rounded-md border bg-background pl-8 pr-16 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
          <button type="button" className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
            Advanced <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[1300px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="w-24 px-3 py-2.5"><span className="sr-only">Actions</span></th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">Item ID</th>
              <th className="px-3 py-2.5 font-medium">Submitted at</th>
              <th className="px-3 py-2.5 font-medium">Submitted by</th>
              <th className="px-3 py-2.5 font-medium">Submission method</th>
              <th className="px-3 py-2.5 font-medium">Owned by</th>
              <th className="px-3 py-2.5 font-medium">Date</th>
              <th className="px-3 py-2.5 font-medium">Supplier</th>
              <th className="px-3 py-2.5 font-medium">Customer</th>
              <th className="px-3 py-2.5 text-right font-medium">Total amount</th>
              <th className="px-3 py-2.5 font-medium">Workspace</th>
              <th className="px-3 py-2.5 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <td className="px-3 py-3">
                  <div className="flex items-center gap-2 text-muted-foreground/60">
                    <Image className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <FileCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </div>
                </td>
                <td className="px-3 py-3"><StatusBadge status={s.status} /></td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums">{s.id}</td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{s.submittedAt}</td>
                <td className="whitespace-nowrap px-3 py-3">{s.submittedBy}</td>
                <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{s.method}</td>
                <td className="whitespace-nowrap px-3 py-3">{s.ownedBy}</td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{s.date}</td>
                <td className="whitespace-nowrap px-3 py-3">{s.supplier}</td>
                <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{s.customer}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  <span className="text-xs text-muted-foreground">SGD </span>{s.total}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{s.workspace}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => navigate(`/costs/${s.id}`)}
                    className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Show
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-4 py-16 text-center text-sm text-muted-foreground">No submissions in {tab}.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>}
    </AppShell>
  );
}
