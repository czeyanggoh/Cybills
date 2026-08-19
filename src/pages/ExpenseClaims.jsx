import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronDown, Search, Filter, Settings2, X, Send } from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import ClaimApprovalModal from '@/components/ClaimApprovalModal';
import FlagMenu from '@/components/FlagMenu';
import ReceiptViewer from '@/components/ReceiptViewer';
import { useClaims, archiveClaims, deleteClaims, createClaim, submitForApproval, visibleClaimsFor } from '@/lib/claimStore';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

// Status pill for a claim's approval state (Draft / Pending / Approved / Rejected).
function ClaimStatusBadge({ status, label }) {
  const cls =
    status === 'approved'
      ? 'bg-foreground text-background'
      : status === 'rejected'
        ? 'border border-destructive text-destructive'
        : status === 'awaiting_approval'
          ? 'border border-foreground/40 text-foreground'
          : 'border border-dashed text-muted-foreground';
  return <span className={cn('inline-flex rounded px-2 py-0.5 text-xs font-medium', cls)}>{label}</span>;
}

// Bulk "Actions" dropdown for the claims list.
function ClaimsActions({ disabled, tab, onArchive, onDelete }) {
  const [open, setOpen] = useState(false);
  const items = [
    { label: tab === 'archive' ? 'Unarchive' : 'Archive', onClick: onArchive },
    { label: 'Delete', onClick: onDelete, danger: true },
  ];
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors',
          disabled ? 'cursor-not-allowed text-muted-foreground/50' : 'hover:bg-muted'
        )}
      >
        Actions <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute left-0 z-20 mt-1 w-40 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                onClick={() => { setOpen(false); it.onClick(); }}
                className={cn('flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted', it.danger && 'text-destructive')}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function ExpenseClaims() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('inbox');
  const [selected, setSelected] = useState(() => new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [newClaim, setNewClaim] = useState({ claimFor: 'Astrid Yang', endDate: '', name: '' });
  const [query, setQuery] = useState('');
  const [approveOpen, setApproveOpen] = useState(false);

  // "2026-07-27" → "27 Jul 2026" to match the rest of the list.
  const fmtEnd = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}`;
  };

  const submitCreate = async () => {
    await createClaim({
      claimFor: newClaim.claimFor,
      endDate: fmtEnd(newClaim.endDate),
      name: newClaim.name.trim() || 'Expense claim',
    });
    setShowCreate(false);
    setNewClaim({ claimFor: 'Astrid Yang', endDate: '', name: '' });
    setTab('inbox');
  };
  const { user, googleEnabled, membership } = useAuth();
  const allClaims = useClaims();
  // Gatekeep: a submitted claim is visible only to its claimant and their direct
  // manager. Admins keep full oversight (they process/export every claim).
  const isAdmin = !googleEnabled || ['Business Admin', 'User Admin'].includes(membership?.user?.role);
  const claims = isAdmin ? allClaims : visibleClaimsFor(allClaims, user);

  // Inbox = every claim that isn't approved yet — drafts, ones awaiting a
  // decision (still pending), and rejected ones to fix. Approvals = only claims
  // that have been APPROVED. So a not-yet-approved claim stays in the Inbox.
  const inbox = claims.filter((c) => !c.archived && c.approvalStatus !== 'approved');
  const approvals = claims.filter((c) => !c.archived && c.approvalStatus === 'approved');
  const archived = claims.filter((c) => c.archived);

  // Human-readable status for a claim, shown in the Status column.
  const STATUS_LABEL = { awaiting_approval: 'Pending', approved: 'Approved', rejected: 'Rejected' };
  const statusOf = (c) => STATUS_LABEL[c.approvalStatus] || 'Draft';

  const TABS = [
    { key: 'inbox', label: 'Inbox', count: inbox.length },
    { key: 'approvals', label: 'Approvals', count: approvals.length || null },
    { key: 'archive', label: 'Archive', count: archived.length || null },
  ];

  const base = tab === 'inbox' ? inbox : tab === 'approvals' ? approvals : tab === 'archive' ? archived : [];
  const q = query.trim().toLowerCase();
  const rows = q
    ? base.filter((c) => [c.claimFor, c.name, c.type].some((v) => String(v || '').toLowerCase().includes(q)))
    : base;
  const hasSelection = selected.size > 0;

  const clear = () => setSelected(new Set());
  const doArchive = (on) => {
    archiveClaims([...selected], on);
    clear();
  };
  const doDelete = () => {
    if (selected.size && window.confirm(`Delete ${selected.size} claim(s)?`)) {
      deleteClaims([...selected]);
      clear();
    }
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
        <h1 className="text-xl font-semibold tracking-tight">Expense claims</h1>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
        >
          <Plus className="h-4 w-4" strokeWidth={2} />
          Create expense claim
        </button>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex items-center gap-6 border-b">
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
                '-mb-px flex items-center gap-2 border-b-2 pb-3 pt-1 text-sm transition-colors',
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
        {tab === 'inbox' && (
          <button
            type="button"
            disabled={!hasSelection}
            onClick={() => setApproveOpen(true)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-opacity',
              hasSelection ? 'bg-primary text-primary-foreground hover:opacity-90' : 'cursor-not-allowed bg-muted text-muted-foreground/60'
            )}
          >
            <Send className="h-3.5 w-3.5" /> Submit for approval
          </button>
        )}
        <button
          type="button"
          disabled={!hasSelection}
          onClick={() => doArchive(tab !== 'archive')}
          className={cn(
            'inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors',
            hasSelection ? 'hover:bg-muted' : 'cursor-not-allowed text-muted-foreground/50'
          )}
        >
          {tab === 'archive' ? 'Unarchive' : 'Archive'}
        </button>
        <ClaimsActions
          disabled={!hasSelection}
          tab={tab}
          onArchive={() => doArchive(tab !== 'archive')}
          onDelete={doDelete}
        />
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
        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Filter">
          <Filter className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Table settings">
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
              <th className="px-3 py-2.5 font-medium">Claim for</th>
              <th className="px-3 py-2.5 font-medium">Type</th>
              <th className="px-3 py-2.5 font-medium">Name</th>
              <th className="px-3 py-2.5 font-medium">End date</th>
              <th className="px-3 py-2.5 text-right font-medium">Total</th>
              <th className="px-3 py-2.5 text-right font-medium">Tax</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.id}
                onClick={() => navigate(`/expense-claims/${c.id}`)}
                className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40"
              >
                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                      className="h-4 w-4 accent-black"
                    />
                    <FlagMenu id={c.id} />
                    <ReceiptViewer itemIds={(c.transactions || []).map((t) => t.itemId)} />
                  </div>
                </td>
                <td className="px-3 py-3">
                  <ClaimStatusBadge status={c.approvalStatus} label={statusOf(c)} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-medium">{c.claimFor}</td>
                <td className="px-3 py-3 text-muted-foreground">{c.type}</td>
                <td className="px-3 py-3">{c.name}</td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{c.endDate}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  <span className="text-xs text-muted-foreground">SGD </span>{c.total}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-muted-foreground">
                  SGD {c.tax}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  <Plus className="mx-auto mb-2 h-5 w-5" strokeWidth={1.5} />
                  Nothing in {TABS.find((t) => t.key === tab)?.label}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {rows.length} items</p>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-foreground/20" onClick={() => setShowCreate(false)} aria-hidden="true" />
          <div className="relative w-full max-w-md rounded-lg border bg-background shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="text-base font-semibold tracking-tight">Create expense claim</h2>
              <button type="button" onClick={() => setShowCreate(false)} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Claim for <span className="text-destructive">*</span></span>
                <select
                  value={newClaim.claimFor}
                  onChange={(e) => setNewClaim((c) => ({ ...c, claimFor: e.target.value }))}
                  className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option>Astrid Yang</option>
                  <option>Sean Tan</option>
                  <option>Clara Lee</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">End date <span className="text-destructive">*</span></span>
                <input
                  type="date"
                  value={newClaim.endDate}
                  onChange={(e) => setNewClaim((c) => ({ ...c, endDate: e.target.value }))}
                  className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Claim name</span>
                <input
                  type="text"
                  value={newClaim.name}
                  onChange={(e) => setNewClaim((c) => ({ ...c, name: e.target.value }))}
                  placeholder="Add claim name"
                  className="h-9 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-4">
              <button type="button" onClick={() => setShowCreate(false)} className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted">
                Cancel
              </button>
              <button
                type="button"
                onClick={submitCreate}
                disabled={!newClaim.claimFor || !newClaim.endDate}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      <ClaimApprovalModal
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        claims={rows.filter((c) => selected.has(c.id))}
        onSubmit={async (ids) => {
          setApproveOpen(false);
          // Each routes to the claimant's direct manager, resolved server-side.
          await Promise.all(ids.map((id) => submitForApproval(id).catch(() => {})));
          clear();
        }}
      />
    </AppShell>
  );
}
