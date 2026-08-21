import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Image, Download, FileClock, Search, ChevronDown } from 'lucide-react';
import AppShell from '@/components/AppShell';
import HistoryModal from '@/components/HistoryModal';
import { fetchBills, billToDoc, displayItemId, billFileUrl, BILLS_CHANGED_EVENT } from '@/lib/bills';
import { cn } from '@/lib/utils';

const TABS = ['Costs and sales', 'Supplier statements'];

// Real documents, newest first, mapped to the history-table shape. Excludes
// mid-upload ('processing') and deleted docs — everything else has been
// submitted and belongs in the history.
function useSubmittedDocs() {
  const [docs, setDocs] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const bills = (await fetchBills()).map(billToDoc);
        if (alive) setDocs(bills.filter((d) => d.status !== 'deleted' && d.status !== 'processing'));
      } catch {
        if (alive) setDocs([]);
      }
    };
    load();
    window.addEventListener(BILLS_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(BILLS_CHANGED_EVENT, load);
    };
  }, []);
  return docs;
}

const fmtDate = (iso) => {
  if (!iso || iso === '—') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' });
};

function StatusBadge({ status }) {
  const map = {
    ready: 'bg-foreground text-background',
    review: 'border border-dashed border-foreground text-foreground',
    expenseclaim: 'bg-muted text-muted-foreground',
    archived: 'bg-muted text-muted-foreground',
    merged: 'bg-muted text-muted-foreground',
    new: 'border border-foreground/30 text-foreground',
  };
  const label = {
    ready: 'Ready',
    review: 'To review',
    expenseclaim: 'In expense claim',
    archived: 'Archived',
    merged: 'Merged',
    new: 'Inbox',
  }[status] || 'Inbox';
  return <span className={cn('inline-flex whitespace-nowrap rounded px-2 py-0.5 text-xs', map[status] ?? map.new)}>{label}</span>;
}

// Row action icons; the history (clock) icon opens the timeline modal.
function RowActions({ doc, onHistory }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground/60">
      {doc.hasFile ? (
        <>
          <a href={billFileUrl(doc.id)} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground" aria-label="View file">
            <Image className="h-3.5 w-3.5" strokeWidth={1.75} />
          </a>
          <a href={billFileUrl(doc.id)} download className="transition-colors hover:text-foreground" aria-label="Download file">
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
          </a>
        </>
      ) : (
        <>
          <Image className="h-3.5 w-3.5" strokeWidth={1.75} />
          <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
        </>
      )}
      <button type="button" onClick={onHistory} className="transition-colors hover:text-foreground" aria-label="View history">
        <FileClock className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}

export default function SubmissionHistory() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('Costs and sales');
  const [query, setQuery] = useState('');
  const [historyItem, setHistoryItem] = useState(null);
  const docs = useSubmittedDocs();

  // Costs and sales share one tab; supplier statements have their own.
  const forTab = docs.filter((d) =>
    tab === 'Supplier statements' ? d.kind === 'supplier_statement' : d.kind === 'cost' || d.kind === 'sales'
  );
  const q = query.trim().toLowerCase();
  // Newest submission on top, always — don't rely on the store's order.
  const sortByNewest = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  const rows = (q
    ? forTab.filter((d) =>
        [d.supplier, d.user, d.customer, displayItemId(d.id)].some((v) => String(v || '').toLowerCase().includes(q))
      )
    : forTab
  )
    .slice()
    .sort(sortByNewest)
    .map((d) => ({
    doc: d,
    id: displayItemId(d.id),
    status: d.status,
    submittedAt: fmtDate(d.createdAt),
    submittedBy: d.user,
    method: 'Uploaded',
    ownedBy: d.user,
    date: fmtDate(d.date),
    supplier: d.supplier,
    customer: d.customer || '—',
    total: d.total,
    workspace: d.kind === 'sales' ? 'Sales' : d.kind === 'supplier_statement' ? 'Supplier statements' : 'Costs',
  }));

  const showDoc = (d) => navigate(d.kind === 'sales' ? `/sales/${d.id}` : `/costs/${d.id}`);

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
        <div className="relative ml-auto hidden sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="h-8 w-52 rounded-md border bg-background pl-8 pr-16 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button type="button" className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
            Advanced <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[1200px] text-sm">
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
              <tr key={s.doc.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <td className="px-3 py-3"><RowActions doc={s.doc} onHistory={() => setHistoryItem(s)} /></td>
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
                  <span className="text-xs text-muted-foreground">{s.doc.currency || 'SGD'} </span>{s.total}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{s.workspace}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => showDoc(s.doc)}
                    className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Show
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={13} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  {q ? `No submissions match “${query}”.` : `No submissions in ${tab} yet.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>}

      <HistoryModal open={Boolean(historyItem)} onClose={() => setHistoryItem(null)} item={historyItem} />
    </AppShell>
  );
}
