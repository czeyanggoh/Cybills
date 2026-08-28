import { useState } from 'react';
import { xeroPaidStatus } from '@/lib/xeroPaidStatus';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronDown, Search, Filter, X, Send, CalendarClock } from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import ClaimApprovalModal from '@/components/ClaimApprovalModal';
import AutoClaimsModal from '@/components/AutoClaimsModal';
import FlagMenu from '@/components/FlagMenu';
import ReceiptViewer from '@/components/ReceiptViewer';
import { useClaims, archiveClaims, deleteClaims, createClaim, submitForApproval, visibleClaimsFor, formatClaimDate, isClaimArchived } from '@/lib/claimStore';
import { useAuth } from '@/lib/auth';
import { canManageBusiness, useUsers } from '@/lib/userStore';
import { cn } from '@/lib/utils';

// Status pill for a claim's approval state (Not submitted / Waiting / Approved / Rejected).
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
          'inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-3 text-sm transition-colors',
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

// Search, plus the two narrowings that sit beside it. Both were buttons with no
// handler until now — the shape of a filter with none of the behaviour, which
// is worse than no filter, because somebody clicks it and concludes the page is
// broken rather than that the feature was never there.
//
// A column chooser used to sit here too (the gear). It is gone rather than
// faked: the claims table renders a fixed set of columns, so choosing them
// would need the table to honour the choice, and a third dead button is not an
// improvement on two.
function ClaimsToolbar({
  query, setQuery, filters, setFilters, adv, setAdv, narrowed,
  statusOptions, reimbursementOptions, typeOptions, claimForOptions,
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const setA = (k, v) => setAdv((a) => ({ ...a, [k]: v }));
  const field = 'h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const label = 'mb-1 block text-xs text-muted-foreground';

  const Select = ({ value, onChange, options, anyLabel }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={field}>
      <option value="">{anyLabel}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );

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
          onClick={() => { setAdvOpen((v) => !v); setFilterOpen(false); }}
          className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Advanced <ChevronDown className="h-3 w-3" />
        </button>
        {advOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setAdvOpen(false)} aria-hidden="true" />
            <div className="absolute right-0 top-10 z-40 w-72 rounded-md border bg-popover p-3 shadow-lg">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Advanced search</p>
              <div className="space-y-3">
                <div>
                  <span className={label}>Claim for</span>
                  <Select value={adv.claimFor} onChange={(v) => setA('claimFor', v)} options={claimForOptions} anyLabel="Anyone" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className={label}>Total from</span>
                    <input value={adv.min} onChange={(e) => setA('min', e.target.value)} inputMode="decimal" className={field} />
                  </div>
                  <div>
                    <span className={label}>to</span>
                    <input value={adv.max} onChange={(e) => setA('max', e.target.value)} inputMode="decimal" className={field} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className={label}>End date from</span>
                    <input type="date" value={adv.from} onChange={(e) => setA('from', e.target.value)} className={field} />
                  </div>
                  <div>
                    <span className={label}>to</span>
                    <input type="date" value={adv.to} onChange={(e) => setA('to', e.target.value)} className={field} />
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setAdv({ min: '', max: '', from: '', to: '', claimFor: '' })}
                className="mt-3 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear
              </button>
            </div>
          </>
        )}
      </div>
      <div className="relative">
        <button
          type="button"
          onClick={() => { setFilterOpen((v) => !v); setAdvOpen(false); }}
          className={cn(
            'flex h-8 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            narrowed && 'bg-muted text-foreground'
          )}
          aria-label="Filter"
        >
          <Filter className="h-4 w-4" strokeWidth={1.75} />
          {/* How many narrowings are on, so a list that looks short has a
              visible reason rather than looking like missing claims. */}
          {narrowed ? <span className="text-xs font-medium">{narrowed}</span> : null}
        </button>
        {filterOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setFilterOpen(false)} aria-hidden="true" />
            <div className="absolute right-0 top-10 z-40 w-64 rounded-md border bg-popover p-3 shadow-lg">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter</p>
              <div className="space-y-3">
                <div>
                  <span className={label}>Approval status</span>
                  <Select value={filters.status} onChange={(v) => set('status', v)} options={statusOptions} anyLabel="Any" />
                </div>
                <div>
                  <span className={label}>Reimbursement</span>
                  <Select value={filters.reimbursement} onChange={(v) => set('reimbursement', v)} options={reimbursementOptions} anyLabel="Any" />
                </div>
                {typeOptions.length > 1 && (
                  <div>
                    <span className={label}>Type</span>
                    <Select value={filters.type} onChange={(v) => set('type', v)} options={typeOptions} anyLabel="Any" />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setFilters({ status: '', reimbursement: '', type: '' })}
                className="mt-3 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export default function ExpenseClaims() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('inbox');
  const [selected, setSelected] = useState(() => new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [newClaim, setNewClaim] = useState({ claimFor: '', endDate: '', name: '' });
  const [query, setQuery] = useState('');
  // Two narrowings beside the search box, which used to be a funnel and an
  // "Advanced" that did nothing at all — the buttons were there, the handlers
  // never were, and Cze quite reasonably reported them as broken.
  const [filters, setFilters] = useState({ status: '', reimbursement: '', type: '' });
  const [adv, setAdv] = useState({ min: '', max: '', from: '', to: '', claimFor: '' });
  const [approveOpen, setApproveOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);

  // "2026-07-27" → "27 Jul 2026" to match the rest of the list.
  const submitCreate = async () => {
    await createClaim({
      claimFor: newClaim.claimFor || meName,
      endDate: newClaim.endDate, // ISO from the date picker; createClaim canonicalises
      name: newClaim.name.trim() || 'Expense claim',
    });
    setShowCreate(false);
    setNewClaim({ claimFor: '', endDate: '', name: '' });
    setTab('inbox');
  };
  const { user, googleEnabled, membership } = useAuth();
  const roster = useUsers();
  const meName = user?.name || user?.email || '';
  // Claim-for options: the real roster, with the current user always available.
  const claimForOptions = Array.from(new Set([meName, ...roster.map((u) => u.name || u.email)].filter(Boolean)));
  const allClaims = useClaims();
  // Gatekeep: a submitted claim is visible only to its claimant and their direct
  // manager. Business Admins keep full oversight (they process/export every
  // claim); a User Admin runs the roster, not other people's documents.
  const isAdmin = canManageBusiness(membership, googleEnabled);
  const claims = isAdmin ? allClaims : visibleClaimsFor(allClaims, user);

  // Inbox = every claim that isn't approved yet — drafts, ones awaiting a
  // Inbox holds every non-archived claim (like the Costs inbox) — each row shows
  // its own Approval status, so there's no separate Approvals tab.
  // Newest claim on top (createdAt is an ISO stamp, so lexical sort = chrono).
  const byNewest = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  // A claim published to Xero belongs in Archive (out of the active inbox), even
  // if it was published before auto-archiving was added — isClaimArchived is the
  // shared rule, so the subnav badge counts exactly what the Inbox tab lists.
  const inbox = claims.filter((c) => !isClaimArchived(c)).sort(byNewest);
  const archived = claims.filter(isClaimArchived).sort(byNewest);

  // Per-claim approval status shown in its column (Dext wording).
  const STATUS_LABEL = { awaiting_approval: 'Waiting', approved: 'Approved', rejected: 'Rejected' };
  const statusOf = (c) => STATUS_LABEL[c.approvalStatus] || 'Not submitted';

  const TABS = [
    { key: 'inbox', label: 'Inbox', count: inbox.length },
    { key: 'archive', label: 'Archive', count: archived.length || null },
  ];

  const base = tab === 'inbox' ? inbox : tab === 'archive' ? archived : [];
  const q = query.trim().toLowerCase();
  const amount = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const rows = base.filter((c) => {
    if (q && ![c.claimFor, c.name, c.type].some((v) => String(v || '').toLowerCase().includes(q))) return false;
    if (filters.status && statusOf(c) !== filters.status) return false;
    // Reimbursement is what Xero says about the bill the claim posted as, so a
    // claim that was never published has none — which is its own answer.
    if (filters.reimbursement) {
      const paid = xeroPaidStatus(c)?.label || 'Not published';
      if (paid !== filters.reimbursement) return false;
    }
    if (filters.type && String(c.type || '') !== filters.type) return false;
    if (adv.claimFor && String(c.claimFor || '') !== adv.claimFor) return false;
    if (adv.min && amount(c.total) < amount(adv.min)) return false;
    if (adv.max && amount(c.total) > amount(adv.max)) return false;
    // Dates compare as ISO strings, which is what the claim stores.
    if (adv.from && String(c.endDate || '') < adv.from) return false;
    if (adv.to && String(c.endDate || '') > adv.to) return false;
    return true;
  });
  // What the two popovers can offer, taken from the claims actually here — a
  // filter listing a status nothing has is a dead end with a count of zero.
  const statusOptions = [...new Set(base.map(statusOf))].sort();
  const reimbursementOptions = [...new Set(base.map((c) => xeroPaidStatus(c)?.label || 'Not published'))].sort();
  const typeOptions = [...new Set(base.map((c) => String(c.type || '')).filter(Boolean))].sort();
  // Who actually has a claim in this tab — not the whole roster, which already
  // has its own list for CREATING one. Filtering by somebody with no claims is
  // an empty screen with no explanation.
  const claimantsPresent = [...new Set(base.map((c) => String(c.claimFor || '')).filter(Boolean))].sort();
  const narrowed =
    Object.values(filters).filter(Boolean).length + Object.values(adv).filter(Boolean).length;
  const hasSelection = selected.size > 0;

  const clear = () => setSelected(new Set());
  const doArchive = (on) => {
    archiveClaims([...selected], on);
    clear();
  };
  const doDelete = () => {
    // The receipts go too, so the list's own delete says so as plainly as the
    // claim page's does.
    if (
      selected.size &&
      window.confirm(
        `Delete ${selected.size} claim${selected.size === 1 ? '' : 's'}?\n\nThe receipts on ${selected.size === 1 ? 'it' : 'them'} will be permanently deleted, including the stored files. This cannot be undone.`
      )
    ) {
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
      {/* Header. The two buttons carry three-word labels that wrapped into
          three lines each on a phone and squeezed the title with them, so the
          row stacks and the labels stay on one line. */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Expense claims</h1>
        <div className="flex items-center gap-2 overflow-x-auto pb-1 sm:overflow-x-visible sm:pb-0">
          {/* The schedule is account-wide, so it's a Business Admin's to set. */}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setAutoOpen(true)}
              className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              <CalendarClock className="h-4 w-4" strokeWidth={2} />
              Auto expense claims
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
          >
            <Plus className="h-4 w-4" strokeWidth={2} />
            Create expense claim
          </button>
        </div>
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
      {/* One scrolling row on a phone rather than several wrapped ones. */}
      <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-x-visible md:pb-0">
        {tab === 'inbox' && (
          <button
            type="button"
            disabled={!hasSelection}
            onClick={() => setApproveOpen(true)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-opacity',
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
            'inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md border px-3 text-sm transition-colors',
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
        <ClaimsToolbar
          query={query}
          setQuery={setQuery}
          filters={filters}
          setFilters={setFilters}
          adv={adv}
          setAdv={setAdv}
          narrowed={narrowed}
          statusOptions={statusOptions}
          reimbursementOptions={reimbursementOptions}
          typeOptions={typeOptions}
          claimForOptions={claimantsPresent}
        />
      </div>

      {/* Phone: cards. A claim's identity is whose it is, what it comes to and
          where it has got to in approval — the 880px table put Total and Tax
          off the edge, which is most of the point of looking. */}
      <ul className="space-y-2 md:hidden">
        {rows.map((c) => (
          <li
            key={c.id}
            className={cn(
              'rounded-lg border transition-colors',
              selected.has(c.id) ? 'border-foreground bg-muted/40' : 'bg-background'
            )}
          >
            <div className="flex items-start gap-3 p-3">
              <label className="-m-1.5 flex min-h-11 min-w-11 shrink-0 items-center justify-center p-1.5">
                <span className="sr-only">Select {c.name}</span>
                <input
                  type="checkbox"
                  checked={selected.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="h-5 w-5 accent-black"
                />
              </label>
              <button
                type="button"
                onClick={() => navigate(`/expense-claims/${c.id}`)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words text-sm font-medium">{c.claimFor}</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">SGD {c.total}</span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">{formatClaimDate(c.endDate)}</span>
                  <span className="tabular-nums">Tax SGD {c.tax}</span>
                </div>
                <div className="mt-1.5 break-words text-xs text-muted-foreground">
                  {c.name}
                  {c.auto && (
                    <span className="ml-2 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">Auto</span>
                  )}
                </div>
              </button>
            </div>
            <div className="flex items-center gap-1 border-t px-2 py-1.5">
              <FlagMenu id={c.id} />
              <ReceiptViewer itemIds={(c.transactions || []).map((t) => t.itemId)} />
              <span className="ml-1 min-w-0 truncate">
                <ClaimStatusBadge status={c.approvalStatus} label={statusOf(c)} />
              </span>
            </div>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="rounded-lg border px-4 py-12 text-center text-sm text-muted-foreground">
            <Plus className="mx-auto mb-2 h-5 w-5" strokeWidth={1.5} />
            Nothing in {TABS.find((t) => t.key === tab)?.label}.
          </li>
        )}
      </ul>

      {/* Table (md and up) */}
      <div className="hidden overflow-x-auto rounded-lg border md:block">
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
              <th className="px-3 py-2.5 font-medium">Approval status</th>
              {/* Approval is the company saying it owes the money; this is the
                  bank saying it left. A claimant's question is the second one,
                  and until now nothing here answered it. */}
              <th className="px-3 py-2.5 font-medium">Reimbursement</th>
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
                <td className="whitespace-nowrap px-3 py-3">
                  {(() => {
                    const paid = xeroPaidStatus(c);
                    // Nothing heard is a dash, never "unpaid": a claim nobody
                    // has published has no answer in Xero to report yet.
                    if (!paid) return <span className="text-muted-foreground">—</span>;
                    return (
                      <span
                        className={
                          paid.tone === 'paid'
                            ? 'font-medium text-green-700'
                            : paid.tone === 'void'
                              ? 'text-muted-foreground line-through'
                              : 'text-muted-foreground'
                        }
                      >
                        {paid.label}
                        {c.xeroPaidDate ? ` · ${formatClaimDate(c.xeroPaidDate)}` : ''}
                      </span>
                    );
                  })()}
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-medium">{c.claimFor}</td>
                <td className="px-3 py-3 text-muted-foreground">{c.type}</td>
                <td className="px-3 py-3">
                  {c.name}
                  {/* Say plainly which claims nobody assembled by hand. */}
                  {c.auto && (
                    <span className="ml-2 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Auto
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{formatClaimDate(c.endDate)}</td>
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
                  value={newClaim.claimFor || meName}
                  onChange={(e) => setNewClaim((c) => ({ ...c, claimFor: e.target.value }))}
                  className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {claimForOptions.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
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
                disabled={!(newClaim.claimFor || meName) || !newClaim.endDate}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      <AutoClaimsModal open={autoOpen} onClose={() => setAutoOpen(false)} />

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
