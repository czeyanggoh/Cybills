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
  ListChecks,
} from 'lucide-react';
import AppShell, { AddDocumentsButton } from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import AddToClaimModal from '@/components/AddToClaimModal';
import DocsExportModal from '@/components/DocsExportModal';
import { useCategoryOptions } from '@/lib/organisations';
import { useAuth } from '@/lib/auth';
import { updateBill, notifyBillsChanged, displayItemId } from '@/lib/bills';
import { setDocOverride } from '@/lib/docOverrides';
import { addItemToClaim, createClaim, docToClaimTxn } from '@/lib/claimStore';
import { useCostsDocs, rowsFor } from '@/lib/costsData';
import { formatDate } from '@/lib/date';
import { cn } from '@/lib/utils';

// Native (working) category dropdown styled to match the row cells. `options`
// is the active org's live Xero chart (bundled fallback).
function CategorySelect({ value, onChange, options }) {
  const known = options.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-44 rounded-md border bg-background px-2 py-1.5 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {!known && <option value={value}>{value}</option>}
      {options.map((c) => (
        <option key={c} value={c}>{c}</option>
      ))}
    </select>
  );
}

// Tabs whose badge shows a live count of their rows. Processing/Approvals have
// no count badge (they render their own panels).
const TABS = [
  { key: 'inbox', label: 'Inbox', counted: true },
  { key: 'processing', label: 'Processing', counted: true },
  { key: 'review', label: 'To review', counted: true },
  { key: 'ready', label: 'Ready', counted: true },
  { key: 'approvals', label: 'Approvals' },
  { key: 'archive', label: 'Archive', counted: true },
];

function StatusBadge({ status }) {
  const map = {
    new: 'border border-foreground font-medium text-foreground',
    viewed: 'bg-muted text-muted-foreground',
    ready: 'bg-foreground text-background',
    review: 'border border-dashed border-foreground text-foreground',
    expenseclaim: 'bg-muted text-muted-foreground',
    archived: 'bg-muted text-muted-foreground',
  };
  const label = {
    new: 'New',
    viewed: 'Viewed',
    ready: 'Ready',
    review: 'To review',
    expenseclaim: 'In expense claim',
    archived: 'Archived',
  }[status];
  return (
    <span className={cn('inline-flex whitespace-nowrap rounded px-2 py-0.5 text-xs', map[status] ?? map.viewed)}>
      {label}
    </span>
  );
}

function ToolbarButton({ children, disabled = false, dropdown = false, onClick = () => {} }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
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

// A small toolbar dropdown menu.
function Dropdown({ label, disabled = false, items }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <ToolbarButton disabled={disabled} dropdown onClick={() => !disabled && setOpen((o) => !o)}>
        {label}
      </ToolbarButton>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute left-0 z-20 mt-1 w-48 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
            {items.map((it, i) =>
              it.divider ? (
                <div key={`d${i}`} className="my-1 h-px bg-border" />
              ) : (
                <button
                  key={it.label}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                  className={cn(
                    'flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted',
                    it.danger && 'text-destructive'
                  )}
                >
                  {it.label}
                </button>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Left-hand toolbar actions differ per tab (mirrors Dext). `a` holds the wired
// bulk-action handlers; all operate on the current selection.
function ToolbarActions({ tab, hasSelection, a }) {
  const moveTo = [
    { label: 'To review', onClick: () => a.move('review') },
    { label: 'Ready', onClick: () => a.move('ready') },
    { divider: true },
    { label: 'Archive', onClick: () => a.move('archived') },
  ];
  const actions = [
    { label: 'Move to review', onClick: () => a.move('review') },
    { label: 'Move to ready', onClick: () => a.move('ready') },
    { label: 'Add to expense claim', onClick: a.addClaim },
    { divider: true },
    { label: 'Archive', onClick: () => a.move('archived') },
    { label: 'Delete', onClick: a.del, danger: true },
  ];

  if (tab === 'review' || tab === 'ready') {
    return (
      <>
        <ToolbarButton onClick={a.exportCsv}>Export all</ToolbarButton>
        <ToolbarButton disabled={!hasSelection} onClick={() => a.move(tab === 'review' ? 'ready' : 'review')}>
          {tab === 'review' ? 'Move to ready' : 'Move to review'}
        </ToolbarButton>
        <ToolbarButton disabled={!hasSelection} onClick={() => a.move('archived')}>Archive</ToolbarButton>
        <ToolbarButton disabled={!hasSelection} onClick={a.addClaim}>Add to expense claim</ToolbarButton>
        <Dropdown label="Move to" disabled={!hasSelection} items={moveTo} />
        <Dropdown label="Actions" disabled={!hasSelection} items={actions} />
      </>
    );
  }
  if (tab === 'archive') {
    return (
      <>
        <ToolbarButton onClick={a.exportCsv}>Export all</ToolbarButton>
        <ToolbarButton disabled={!hasSelection} onClick={() => a.move('new')}>Unarchive</ToolbarButton>
        <Dropdown label="Move to" disabled={!hasSelection} items={moveTo} />
        <ToolbarButton disabled={!hasSelection} onClick={a.del}>Delete</ToolbarButton>
        <ToolbarButton onClick={() => a.navigate('/submission-history')}>See submission history</ToolbarButton>
      </>
    );
  }
  if (tab === 'processing') {
    return <ToolbarButton onClick={a.exportCsv}>Export all</ToolbarButton>;
  }
  // inbox
  return (
    <>
      <ToolbarButton onClick={a.exportCsv}>Export all</ToolbarButton>
      <ToolbarButton disabled={!hasSelection} onClick={() => a.move('archived')}>Archive</ToolbarButton>
      <ToolbarButton disabled={!hasSelection} onClick={a.addClaim}>Add to expense claim</ToolbarButton>
      <Dropdown label="Move to" disabled={!hasSelection} items={moveTo} />
      <Dropdown label="Actions" disabled={!hasSelection} items={actions} />
    </>
  );
}

function SearchAndTools({ query, setQuery }) {
  return (
    <>
      <div className="relative ml-auto hidden sm:block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
    </>
  );
}

// Sortable table header cell: click to sort, with an up/down arrow.
function SortTh({ label, sortKey, sort, setSort, align = 'left' }) {
  const active = sort.key === sortKey;
  const arrow = !active ? '↕' : sort.dir === 'asc' ? '↑' : '↓';
  return (
    <th className={cn('px-3 py-2.5 font-medium', align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => setSort((s) => (s.key === sortKey ? { key: sortKey, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: sortKey, dir: 'asc' }))}
        className={cn('inline-flex items-center gap-1 hover:text-foreground', align === 'right' && 'flex-row-reverse', active ? 'text-foreground' : 'text-muted-foreground')}
      >
        {label}
        <span className={cn('text-[11px]', active ? 'text-foreground' : 'text-muted-foreground/50')}>{arrow}</span>
      </button>
    </th>
  );
}

// Search + Filter popover + Advanced-search popover for the Costs table.
function CostsToolbar({ query, setQuery, flagFilter, setFlagFilter, adv, setAdv }) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const chip = (on) => cn('rounded-md border px-3 py-1 text-sm transition-colors', on ? 'border-foreground bg-foreground text-background' : 'hover:bg-muted');
  const field = 'h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <>
      <div className="relative ml-auto hidden sm:block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 w-52 rounded-md border bg-background pl-8 pr-20 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        <button type="button" onClick={() => { setAdvOpen((o) => !o); setFilterOpen(false); }} className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
          Advanced <ChevronDown className="h-3 w-3" />
        </button>
        {advOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setAdvOpen(false)} aria-hidden="true" />
            <div className="absolute right-0 z-20 mt-1 w-80 rounded-lg border bg-background p-4 shadow-lg">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Advanced search</p>
              <div className="space-y-3 text-sm">
                <div>
                  <span className="mb-1 block text-muted-foreground">Amount (SGD)</span>
                  <div className="flex items-center gap-2">
                    <input inputMode="decimal" value={adv.min} onChange={(e) => setAdv((a) => ({ ...a, min: e.target.value }))} placeholder="min" className={field} />
                    <span className="text-muted-foreground">to</span>
                    <input inputMode="decimal" value={adv.max} onChange={(e) => setAdv((a) => ({ ...a, max: e.target.value }))} placeholder="max" className={field} />
                  </div>
                </div>
                <div>
                  <span className="mb-1 block text-muted-foreground">Date</span>
                  <div className="flex items-center gap-2">
                    <input type="date" value={adv.from} onChange={(e) => setAdv((a) => ({ ...a, from: e.target.value }))} className={field} />
                    <span className="text-muted-foreground">to</span>
                    <input type="date" value={adv.to} onChange={(e) => setAdv((a) => ({ ...a, to: e.target.value }))} className={field} />
                  </div>
                </div>
                <label className="block">
                  <span className="mb-1 block text-muted-foreground">Supplier</span>
                  <input value={adv.supplier} onChange={(e) => setAdv((a) => ({ ...a, supplier: e.target.value }))} placeholder="Contains…" className={field} />
                </label>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setAdv({ min: '', max: '', from: '', to: '', supplier: '' })} className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">Reset</button>
                <button type="button" onClick={() => setAdvOpen(false)} className="inline-flex h-8 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Apply</button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="relative">
        <button type="button" onClick={() => { setFilterOpen((o) => !o); setAdvOpen(false); }} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Filter">
          <Filter className={cn('h-4 w-4', flagFilter !== 'all' && 'text-foreground')} strokeWidth={1.75} />
        </button>
        {filterOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} aria-hidden="true" />
            <div className="absolute right-0 z-20 mt-1 w-64 rounded-lg border bg-background p-4 shadow-lg">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter</p>
              <div className="grid grid-cols-[60px_1fr] items-center gap-2 text-sm">
                <span>Flag</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setFlagFilter(flagFilter === 'flagged' ? 'all' : 'flagged')} className={chip(flagFilter === 'flagged')}>Flagged</button>
                  <button type="button" onClick={() => setFlagFilter(flagFilter === 'unflagged' ? 'all' : 'unflagged')} className={chip(flagFilter === 'unflagged')}>Unflagged</button>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setFlagFilter('all')} className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">Reset</button>
                <button type="button" onClick={() => setFilterOpen(false)} className="inline-flex h-8 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Apply</button>
              </div>
            </div>
          </>
        )}
      </div>
      <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Table settings">
        <Settings2 className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </>
  );
}

// Approvals has its own toolbar + empty state.
function ApprovalsPanel() {
  const navigate = useNavigate();
  const [scope, setScope] = useState('me');
  const [q, setQ] = useState('');
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarButton disabled dropdown>Approve</ToolbarButton>
        <ToolbarButton disabled>Reject</ToolbarButton>
        <ToolbarButton disabled dropdown>Actions</ToolbarButton>
        <ToolbarButton disabled>Archive</ToolbarButton>
        <div className="ml-auto inline-flex overflow-hidden rounded-md border text-sm">
          {[
            { key: 'me', label: 'Assigned to me' },
            { key: 'all', label: 'All items' },
          ].map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setScope(s.key)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                scope === s.key ? 'bg-foreground text-background' : 'hover:bg-muted'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <SearchAndTools query={q} setQuery={setQ} />
      </div>

      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-xl border">
          <ListChecks className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
        </div>
        <p className="text-lg font-semibold tracking-tight">
          {scope === 'me' ? 'No documents assigned to you' : 'No documents awaiting approval'}
        </p>
        <p className="text-sm text-muted-foreground">
          Documents that need your approval will appear here.
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted">
            View all approvals
          </button>
          <button
            type="button"
            onClick={() => navigate('/settings?section=approvals')}
            className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
          >
            Go to approvals settings
          </button>
        </div>
      </div>
    </>
  );
}

// Processing tab: freshly-uploaded cost documents still being read, shown with
// extraction progress and a manual "Move to inbox" step (they also auto-advance
// to the inbox a moment after upload). Mirrors the Sales processing view.
function CostProcessingView({ rows, onMoveOne, onMoveAll }) {
  const doneCount = (d) => {
    const present = (v) => v != null && v !== '' && v !== '—' && v !== 'Unknown supplier' && v !== 'Uncategorised';
    return [d.supplier, d.date, d.invoiceNumber, d.category, d.total, d.currency].filter(present).length;
  };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarButton disabled={rows.length === 0} onClick={onMoveAll}>
          Move all items to inbox
        </ToolbarButton>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="w-16 px-3 py-2.5"><span className="sr-only">Flag</span></th>
              <th className="px-3 py-2.5 font-medium">Item ID</th>
              <th className="px-3 py-2.5 font-medium">User</th>
              <th className="px-3 py-2.5 font-medium">File name</th>
              <th className="px-3 py-2.5 font-medium">Submission method</th>
              <th className="px-3 py-2.5 font-medium">Extraction process</th>
              <th className="px-3 py-2.5 text-right font-medium">Move to inbox</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const done = doneCount(d);
              return (
                <tr key={d.id} className="group border-b last:border-0">
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1.5">
                      <Flag className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={1.75} />
                      <Image className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={1.75} />
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-muted-foreground">{displayItemId(d.id)}</td>
                  <td className="whitespace-nowrap px-3 py-3">{d.user}</td>
                  <td className="px-3 py-3">{d.fileName || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">Via web</td>
                  <td className="px-3 py-3">
                    <div className="w-56">
                      <div className="mb-1 text-xs text-muted-foreground">{done} out of 6 fields extracted</div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${(done / 6) * 100}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onMoveOne(d.id)}
                      className="inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors hover:bg-muted"
                    >
                      Move to inbox
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  Nothing is processing.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>
      )}
    </>
  );
}

export default function Costs() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState('inbox');
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [claimOpen, setClaimOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [sort, setSort] = useState({ key: '', dir: 'asc' });
  const [flagFilter, setFlagFilter] = useState('all'); // all | flagged | unflagged
  const [adv, setAdv] = useState({ min: '', max: '', from: '', to: '', supplier: '' });

  // Combined document set (persisted bills + sample docs with local edits).
  const { allDocs, reload } = useCostsDocs();
  const categoryOptions = useCategoryOptions();

  // Every tab's rows, so its badge count ties to what the tab actually shows.
  const rowsByTab = {
    processing: rowsFor(allDocs, 'processing'),
    inbox: rowsFor(allDocs, 'inbox'),
    review: rowsFor(allDocs, 'review'),
    ready: rowsFor(allDocs, 'ready'),
    archive: rowsFor(allDocs, 'archive'),
  };
  const allRows = rowsByTab[tab] ?? [];
  const q = query.trim().toLowerCase();
  const toNum = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const toTime = (v) => { const t = new Date(v).getTime(); return Number.isNaN(t) ? 0 : t; };

  let rows = q
    ? allRows.filter((d) =>
        [d.supplier, d.user, d.category, d.date].some((v) => String(v || '').toLowerCase().includes(q))
      )
    : allRows;
  // Filter popover (flag) + Advanced search (amount / date / supplier).
  if (flagFilter === 'flagged') rows = rows.filter((d) => d.flagged);
  if (flagFilter === 'unflagged') rows = rows.filter((d) => !d.flagged);
  if (adv.min) rows = rows.filter((d) => toNum(d.total) >= toNum(adv.min));
  if (adv.max) rows = rows.filter((d) => toNum(d.total) <= toNum(adv.max));
  if (adv.from) rows = rows.filter((d) => toTime(d.date) >= toTime(adv.from));
  if (adv.to) rows = rows.filter((d) => toTime(d.date) <= toTime(adv.to));
  if (adv.supplier.trim()) {
    const s = adv.supplier.trim().toLowerCase();
    rows = rows.filter((d) => String(d.supplier || '').toLowerCase().includes(s));
  }
  if (sort.key) {
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      if (sort.key === 'total' || sort.key === 'tax') return (toNum(a[sort.key]) - toNum(b[sort.key])) * dir;
      if (sort.key === 'date') return (toTime(a.date) - toTime(b.date)) * dir;
      return String(a[sort.key] || '').localeCompare(String(b[sort.key] || '')) * dir;
    });
  }
  const hasSelection = selected.size > 0;

  // Change a row's category — persists for uploaded bills (server) and samples
  // (localStorage).
  const changeCategory = (d, value) => {
    if (d.persisted) updateBill(d.id, { category: value }).then(reload).catch(() => {});
    else setDocOverride(d.id, { category: value });
  };

  // Move every selected document to a workflow status (the pipeline step) —
  // persisted bills via the server, sample docs via localStorage overrides.
  const moveSelected = async (status) => {
    const byId = new Map(allRows.map((r) => [r.id, r]));
    await Promise.all(
      [...selected].map((id) => {
        const d = byId.get(id);
        if (!d) return null;
        if (d.persisted) return updateBill(d.id, { status }).catch(() => {});
        setDocOverride(d.id, { status });
        return null;
      })
    );
    notifyBillsChanged();
    setSelected(new Set());
  };

  // Advance processing uploads into the inbox (Dext's "Move to inbox" step) —
  // the manual fallback to the drawer's automatic advance.
  const moveToInbox = async (ids) => {
    const list = ids ?? rowsByTab.processing.map((d) => d.id);
    if (!list.length) return;
    await Promise.all(list.map((id) => updateBill(id, { status: 'new' }).catch(() => {})));
    notifyBillsChanged();
  };

  const deleteSelected = () => {
    if (selected.size && window.confirm(`Delete ${selected.size} item(s)? They leave every tab.`)) {
      moveSelected('deleted');
    }
  };

  // Add the selected docs to a chosen expense claim, then mark them accordingly.
  const addSelectedToClaim = (targetId) => {
    const actor = user?.name || 'Astrid Yang';
    const byId = new Map(allRows.map((r) => [r.id, r]));
    for (const id of selected) {
      const d = byId.get(id);
      if (d) addItemToClaim(targetId, docToClaimTxn(d, d, actor));
    }
    moveSelected('expenseclaim');
  };

  const actions = {
    move: moveSelected,
    del: deleteSelected,
    addClaim: () => hasSelection && setClaimOpen(true),
    exportCsv: () => setExportOpen(true),
    navigate,
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
    <AppShell subnav={<CostsSubnav />}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Costs inbox</h1>
        <AddDocumentsButton />
      </div>

      {/* Tabs */}
      <div className="mb-4 flex items-center gap-6 overflow-x-auto border-b">
        {TABS.map((t) => {
          const active = tab === t.key;
          const count = t.counted ? (rowsByTab[t.key]?.length ?? 0) : null;
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
              {count != null && (
                <span
                  className={cn(
                    'rounded-full px-1.5 text-xs',
                    active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === 'approvals' ? (
        <ApprovalsPanel />
      ) : tab === 'processing' ? (
        <CostProcessingView
          rows={rowsByTab.processing}
          onMoveOne={(id) => moveToInbox([id])}
          onMoveAll={() => moveToInbox()}
        />
      ) : (
        <>
          {/* Toolbar */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <ToolbarActions tab={tab} hasSelection={hasSelection} a={actions} />
            <CostsToolbar
              query={query}
              setQuery={setQuery}
              flagFilter={flagFilter}
              setFlagFilter={setFlagFilter}
              adv={adv}
              setAdv={setAdv}
            />
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[1000px] text-sm">
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
                  <SortTh label="Status" sortKey="status" sort={sort} setSort={setSort} />
                  <SortTh label="User" sortKey="user" sort={sort} setSort={setSort} />
                  <SortTh label="Date" sortKey="date" sort={sort} setSort={setSort} />
                  <SortTh label="Supplier" sortKey="supplier" sort={sort} setSort={setSort} />
                  <SortTh label="Category" sortKey="category" sort={sort} setSort={setSort} />
                  <SortTh label="Total" sortKey="total" sort={sort} setSort={setSort} align="right" />
                  <SortTh label="Tax" sortKey="tax" sort={sort} setSort={setSort} align="right" />
                  <th className="px-3 py-2.5 font-medium">Tax rate</th>
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
                        <span className={cn('h-2 w-2 rounded-full', d.unread ? 'bg-foreground' : 'bg-transparent')} />
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
                    <td className={cn('whitespace-nowrap px-3 py-3', d.unread && 'font-semibold')}>{d.user}</td>
                    <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{formatDate(d.date)}</td>
                    <td className={cn('px-3 py-3', d.unread && 'font-semibold')}>{d.supplier}</td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <CategorySelect
                        value={d.category || 'Uncategorised'}
                        onChange={(v) => changeCategory(d, v)}
                        options={categoryOptions}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                      <span className="text-xs text-muted-foreground">SGD </span>
                      <span className={cn(d.unread && 'font-semibold')}>{d.total}</span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{d.tax}</td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex w-36 items-center justify-between rounded-md border px-2.5 py-1.5 text-xs text-muted-foreground">
                        <span className="truncate">Extracted amount</span>
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      </div>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-16 text-center text-sm text-muted-foreground">
                      <Plus className="mx-auto mb-2 h-5 w-5" strokeWidth={1.5} />
                      {tab === 'processing'
                        ? 'Nothing processing right now.'
                        : `Nothing in ${TABS.find((t) => t.key === tab)?.label} — add documents to get started.`}
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
              Showing {rows.length} of {rows.length} documents
            </p>
          )}
        </>
      )}

      <AddToClaimModal
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        count={selected.size}
        onAdd={({ claimId, newClaim }) => {
          setClaimOpen(false);
          const targetId = newClaim ? createClaim(newClaim).id : claimId;
          if (targetId) addSelectedToClaim(targetId);
        }}
      />

      <DocsExportModal open={exportOpen} kind="costs" rows={rows} onClose={() => setExportOpen(false)} />
    </AppShell>
  );
}
