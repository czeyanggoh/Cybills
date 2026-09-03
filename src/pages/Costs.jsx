import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  ChevronDown,
  SlidersHorizontal,
  Search,
  Filter,
  Settings2,
  Info,
  Trash2,
  AlertTriangle,
  Layers,
} from 'lucide-react';
import AppShell, { AddDocumentsButton } from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import AddToClaimModal from '@/components/AddToClaimModal';
import DocsExportModal from '@/components/DocsExportModal';
import FlagMenu from '@/components/FlagMenu';
import ReceiptViewer from '@/components/ReceiptViewer';
import { useFlagAssignments } from '@/lib/flagAssignments';
import {
  useCategoryOptions,
  useVisibleTaxRates, useManagedTaxRates,
  getExtractionAccounts,
  resolveCategorisationOrgId,
  fetchXeroAccounts,
  fetchXeroTaxRates,
  publishBillToXero,
  useBridgeEntity,
  useXeroShortCode,
} from '@/lib/organisations';
import { useGstRegistered, useBusinessProfile } from '@/lib/businessProfile';
import { useExtractionSettings, noTaxRateName, publishStatusLabel } from '@/lib/extractionSettings';
import { useReaderName } from '@/lib/readerProvider';
import { reReadDocument } from '@/lib/reRead';
import { accountCodeFromCategory } from '@/data/xeroAccounts';
import { useAuth } from '@/lib/auth';
import { updateBill, deleteBill, notifyBillsChanged, itemNumber, costPath } from '@/lib/bills';
import { setDocOverride } from '@/lib/docOverrides';
import { addItemToClaim, createClaim, docToClaimTxn } from '@/lib/claimStore';
import { buildMergePreview, commitMerge } from '@/lib/mergeDocs';
import { findMergeCandidates, docFacts, statesNothing } from '@/lib/mergeDetect';
import MergeModal from '@/components/MergeModal';
import BulkEditModal from '@/components/BulkEditModal';
import DocCardList from '@/components/DocCardList';
import DuplicateReviewModal from '@/components/DuplicateReviewModal';
import { useCostsDocs, rowsFor, isInInbox, isComplete, isArchived, needsReview, missingFields } from '@/lib/costsData';
import { COST_FILTERS, FILTER_IDS, applyCostFilters, emptyFilters, filterCount, ANYONE, UNASSIGNED, isOwnedBy, ownersOf } from '@/lib/costFilters';
import { useCategoryDisplayMode, formatCategory } from '@/lib/categoryDisplay';
import { formatDate } from '@/lib/date';
import TableSettingsMenu from '@/components/TableSettingsMenu';
import ExtractionProgress from '@/components/ExtractionProgress';
import { xeroBillUrl } from '@/lib/autoPublish';
import { xeroPaidStatus } from '@/lib/xeroPaidStatus';
import { useListView } from '@/lib/listView';
import { COST_COLUMNS, DENSITY_CLASS, useTablePrefs } from '@/lib/tablePrefs';
import { useProjectLabels, withProjectLabels } from '@/lib/projectLabels';
import { cn } from '@/lib/utils';
import ComboSelect from '@/components/ComboSelect';
import SortTh from '@/components/SortTh';

// Type-to-find category dropdown styled to match the row cells. `options` is
// the active org's live Xero chart (bundled fallback), which runs to hundreds
// of accounts — hence the search box rather than a native select.
function CategorySelect({ value, onChange, options }) {
  const mode = useCategoryDisplayMode();
  return (
    <ComboSelect
      size="xs"
      className="w-44"
      aria-label="Category"
      value={value}
      options={options}
      onChange={onChange}
      format={(c) => formatCategory(c, mode)}
    />
  );
}

// Tabs whose badge shows a live count of their rows. Processing/Approvals have
// no count badge (they render their own panels).
const TABS = [
  // Costs is the work still in front of somebody, and it is the sum of the
  // three tabs after it: Processing + To review + Ready. It used to hold the
  // ARCHIVED documents too, which is what made the first badge say 15 while the
  // three beside it added up to 8 — a settled document sitting in the working
  // list, wearing a badge saying it was finished.
  { key: 'all', label: 'Costs', counted: true },
  { key: 'processing', label: 'Processing', counted: true },
  { key: 'review', label: 'To review', counted: true },
  { key: 'ready', label: 'Ready', counted: true },
  // Archived is where the settled work is looked at, on its own, with the
  // Unpublished / All costs toggle deciding how far back it reaches.
  { key: 'archived', label: 'Archived', counted: true },
];

// How much of the book a tab is looking at. "Unpublished" is the work still to
// do and is the default, because it is the question the page exists to answer;
// "All costs" is the same list with the finished documents left in.
//
// It is drawn on Costs and on Archived, and it means the same thing on both
// while reaching different documents, because the two tabs hold different
// piles. On COSTS it is what answers a question the working list cannot:
// "which month of this subscription is missing?" — filter the supplier across
// All costs and the published invoices are there to count. On ARCHIVED it is
// how far back the set-aside pile reaches.
const SCOPES = [
  { key: 'unpublished', label: 'Unpublished' },
  { key: 'all', label: 'All costs' },
];

function ScopeToggle({ scope, setScope, counts }) {
  return (
    <div className="mb-3 inline-flex rounded-md border p-0.5" role="group" aria-label="Which costs to show">
      {SCOPES.map((s) => {
        const active = scope === s.key;
        return (
          <button
            key={s.key}
            type="button"
            aria-pressed={active}
            onClick={() => setScope(s.key)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded px-3 text-sm transition-colors',
              active
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {s.label}
            <span
              className={cn(
                'rounded-full px-1.5 text-xs',
                active ? 'bg-background/20 text-background' : 'bg-muted text-muted-foreground'
              )}
            >
              {counts[s.key] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// `published` distinguishes the two ways a document leaves the inbox for
// Archive: published to Xero, or carried by an expense claim. Both are finished
// states, and each rules the other out — so the row says which one it is.
function StatusBadge({ status, published = false }) {
  if (published) {
    return (
      <span className="inline-flex whitespace-nowrap rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        Published to Xero
      </span>
    );
  }
  const map = {
    processing: 'bg-muted text-muted-foreground',
    new: 'border border-foreground font-medium text-foreground',
    viewed: 'bg-muted text-muted-foreground',
    ready: 'bg-foreground text-background',
    review: 'border border-dashed border-foreground text-foreground',
    expenseclaim: 'bg-muted text-muted-foreground',
    archived: 'bg-muted text-muted-foreground',
    merged: 'bg-muted text-muted-foreground',
  };
  const label = {
    processing: 'Processing',
    new: 'New',
    viewed: 'Viewed',
    ready: 'Ready',
    review: 'To review',
    expenseclaim: 'In expense claim',
    archived: 'Archived',
    merged: 'Merged',
  }[status];
  return (
    <span className={cn('inline-flex whitespace-nowrap rounded px-2 py-0.5 text-xs', map[status] ?? map.viewed)}>
      {label}
    </span>
  );
}

function ToolbarButton({ children, disabled = false, dropdown = false, danger = false, onClick = () => {} }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2.5 text-xs transition-colors',
        disabled ? 'cursor-not-allowed text-muted-foreground/50' : 'hover:bg-muted',
        // Deleting reclaims the stored file too — it can't be undone, so it
        // shouldn't read as just another grey button in the row.
        !disabled && danger && 'text-destructive'
      )}
    >
      {children}
      {dropdown && <ChevronDown className="h-3.5 w-3.5" />}
    </button>
  );
}

// How a detected merge suggestion reads to the reviewer. The two kinds are
// genuinely different findings, so they are not described with one wording:
// pages are one document arriving in halves, a payment pair is one transaction
// papered twice.
function describeMergeGroup(g) {
  const n = g.docs.length;
  // A split is not a guess, so it isn't phrased as one.
  const cut = g.docs.find((d) => d?.splitGroup);
  if (cut && g.docs.every((d) => d?.splitGroup === cut.splitGroup)) {
    return `These ${n} documents are the pages of one PDF you split on upload — one receipt, not ${n}.`;
  }
  return g.kind === 'pages'
    ? `${n} uploads look like parts of ONE document (${g.why}).`
    : 'A receipt and its card slip look like the same payment (the same total, from two different documents).';
}

// The short badge shown on a row that belongs to a suggestion.
//
// A page the app itself cut out of a PDF is named for what it IS — "Page 2 of
// 2" — rather than the hedged "Part of another document" a heuristic has to
// use. Splitting a two-page receipt makes two rows out of one payment, and the
// row that carries no money has to say plainly why it exists.
function mergeBadgeLabel(g, doc) {
  if (doc?.splitGroup && doc.splitPages > 1) {
    return `Page ${doc.splitPage || '?'} of ${doc.splitPages} — merge back`;
  }
  return g.kind === 'pages' ? 'Part of another document' : 'Receipt + card slip';
}

// Left-hand toolbar actions differ per tab (mirrors Dext). `a` holds the wired
// bulk-action handlers; all operate on the current selection.
//
// Every action is a BUTTON. The "Move to" and "Actions" dropdowns this replaces
// were a menu of things that are each one click on their own — a second click
// and a hunt through a list to reach them was pure overhead. The row wraps.
function ToolbarActions({ tab, hasSelection, canMerge, a }) {
  const bridge = useBridgeEntity();
  // One export, over whatever you're pointing at: the ticked rows if any are
  // ticked, otherwise everything the tab is showing. (Two separate buttons for
  // that were only ever a way to pick the wrong one.)
  const exportBtn = (
    <ToolbarButton onClick={hasSelection ? a.exportSelected : a.exportCsv}>
      {hasSelection ? 'Export selected' : 'Export all'}
    </ToolbarButton>
  );
  const bulkEditBtn = (
    <ToolbarButton disabled={!hasSelection} onClick={a.bulkEdit}>
      Bulk edit
    </ToolbarButton>
  );
  const mergeBtn = (
    <ToolbarButton disabled={!canMerge} onClick={a.merge}>
      Merge
    </ToolbarButton>
  );
  // Detection runs on its own over the whole inbox, so this button reports what
  // has already been found rather than starting a search: it opens the review
  // modal on the first suggestion. Detection runs by itself over the inbox, so
  // there is nothing to "scan for" — the button appears only when there is
  // something to review, and says how much.
  const scanBtn = a.mergeCount > 0 ? (
    <ToolbarButton onClick={a.scanMerges}>Merge suggestions ({a.mergeCount})</ToolbarButton>
  ) : null;
  // Read the selected documents again. The first read can come back with
  // nothing (a dark photo, a PDF that turned out to be a scan), which lands the
  // document in the inbox as "Unknown supplier / 0.00" — this is the way out of
  // that, and the way a supplier rule written afterwards reaches the documents
  // it was written for. Hidden when no reader is configured: there would be
  // nothing to process WITH.
  const reprocessBtn = a.canReRead ? (
    <ToolbarButton disabled={!hasSelection || a.busy} onClick={a.reRead}>
      Rerun processing
    </ToolbarButton>
  ) : null;
  // Permanent delete, sat at the end of the row away from the everyday buttons.
  // It confirms before it does anything (it also drops the stored file).
  const deleteBtn = (
    <ToolbarButton danger disabled={!hasSelection} onClick={a.del}>
      Delete
    </ToolbarButton>
  );
  // The whole-book duplicate check runs on the server whenever the book changes
  // (see autoScanDuplicates), so there is no scan to start by hand either.
  // Only worth offering once something is flagged: opens the flagged documents
  // beside what they matched, one pair at a time.
  const reviewDupBtn = a.dupCount > 0 ? (
    <ToolbarButton onClick={a.reviewDuplicates}>Review duplicates ({a.dupCount})</ToolbarButton>
  ) : null;
  // A bridge entity's costs reach the parent's ledger as the lines of an
  // expense claim, never on their own — it has no Xero and its categories carry
  // no account code. The button would refuse every time it was pressed.
  const publishBtn = bridge ? null : (
    <ToolbarButton disabled={!hasSelection || a.busy} onClick={a.publish}>
      Publish to Xero
    </ToolbarButton>
  );
  const claimBtn = (
    <ToolbarButton disabled={!hasSelection} onClick={a.addClaim}>Add to expense claim</ToolbarButton>
  );
  // Archive and its undo are ONE button, because the tab already says which of
  // them is meant: a working tab holds nothing archived and the Archived tab
  // holds nothing else, so the other of the pair was always the greyed-out one
  // sitting beside it. It still acts only on the half of the selection it can
  // move — a selection carried over from another tab can hold rows this move
  // must leave alone — and goes disabled when that half is empty.
  const undo = tab === 'archived';
  const archiveBtn = (
    <ToolbarButton
      disabled={undo ? !a.canUnarchive : !a.canArchive}
      onClick={undo ? a.unarchive : a.archive}
    >
      {undo ? 'Unarchive' : 'Archive'}
    </ToolbarButton>
  );

  if (tab === 'processing') {
    return <ToolbarButton onClick={a.exportCsv}>Export all</ToolbarButton>;
  }
  // Costs / To review / Ready share one row — they are the same pool of work
  // seen through different filters.
  return (
    <>
      {exportBtn}
      {bulkEditBtn}
      {reprocessBtn}
      {claimBtn}
      {publishBtn}
      {mergeBtn}
      {scanBtn}
      {reviewDupBtn}
      {archiveBtn}
      {deleteBtn}
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

// Advanced search, empty. The `user` here is the document's OWNER (the User
// column), which is editable per document — not whoever happened to upload it.
const emptyAdv = () => ({ min: '', max: '', from: '', to: '', supplier: '', user: '' });

// Search + Filter popover + Advanced-search popover for the Costs table.
function CostsToolbar({ query, setQuery, filters, setFilters, adv, setAdv, userOptions }) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const chip = (on) => cn('rounded-md border px-2.5 py-1 text-xs transition-colors', on ? 'border-foreground bg-foreground text-background' : 'hover:bg-muted');
  const chosen = filterCount(filters);
  const advOn = Object.values(adv).some((v) => String(v).trim() !== '');
  const field = 'h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <>
      <div className="relative ml-auto hidden sm:block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 w-52 rounded-md border bg-background pl-8 pr-20 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
        <button type="button" onClick={() => { setAdvOpen((o) => !o); setFilterOpen(false); }} className={cn('absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:text-foreground', advOn ? 'font-medium text-foreground' : 'text-muted-foreground')}>
          {advOn && <span className="h-1.5 w-1.5 rounded-full bg-foreground" aria-hidden="true" />}
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
                <div>
                  {/* The people who actually own documents here — picking from
                      the list beats typing a name that has to match exactly.
                      ANYONE is the way back to "no user chosen". */}
                  <span className="mb-1 block text-muted-foreground">User</span>
                  <ComboSelect
                    aria-label="User"
                    size="sm"
                    className="w-full"
                    value={adv.user || ANYONE}
                    options={[ANYONE, ...userOptions]}
                    onChange={(v) => setAdv((a) => ({ ...a, user: v === ANYONE ? '' : v }))}
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setAdv(emptyAdv())} className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">Reset</button>
                <button type="button" onClick={() => setAdvOpen(false)} className="inline-flex h-8 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Apply</button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="relative">
        <button type="button" onClick={() => { setFilterOpen((o) => !o); setAdvOpen(false); }} className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Filter">
          <Filter className={cn('h-4 w-4', chosen > 0 && 'text-foreground')} strokeWidth={1.75} />
          {chosen > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-medium text-background">
              {chosen}
            </span>
          )}
        </button>
        {filterOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setFilterOpen(false)} aria-hidden="true" />
            <div className="absolute right-0 z-30 mt-1 flex max-h-[min(70vh,32rem)] w-[22rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border bg-background shadow-lg">
              <p className="shrink-0 px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filter</p>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 text-sm">
                {FILTER_IDS.map((id) => (
                  <div key={id} className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
                    <span className="text-muted-foreground">{COST_FILTERS[id].label}</span>
                    <div className="flex flex-wrap gap-2">
                      {COST_FILTERS[id].options.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          onClick={() => setFilters((f) => ({ ...f, [id]: f[id] === o.value ? '' : o.value }))}
                          className={chip(filters[id] === o.value)}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex shrink-0 justify-end gap-2 border-t px-4 py-3">
                <button type="button" onClick={() => setFilters(emptyFilters())} className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">Reset</button>
                <button type="button" onClick={() => setFilterOpen(false)} className="inline-flex h-8 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90">Apply</button>
              </div>
            </div>
          </>
        )}
      </div>
      <TableSettingsMenu table="costs" />
    </>
  );
}

// Processing tab: freshly-uploaded cost documents still being read, shown with
// extraction progress and a manual "Move to inbox" step (they also auto-advance
// to the inbox a moment after upload). Mirrors the Sales processing view.
function CostProcessingView({ rows, onMoveOne, onMoveAll, meName = 'You' }) {
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
            {rows.map((d) => (
                <tr key={d.id} className="group border-b last:border-0">
                  <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1.5">
                      <FlagMenu id={d.id} />
                      <ReceiptViewer itemIds={d.id} />
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-muted-foreground">{itemNumber(d)}</td>
                  <td className="whitespace-nowrap px-3 py-3">{d.user && d.user !== 'You' ? d.user : meName}</td>
                  <td className="px-3 py-3">{d.fileName || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">Via web</td>
                  <td className="px-3 py-3">
                    <ExtractionProgress doc={d} />
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
              ))}
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
  // Read before the column list is built below — shownColumns evaluates
  // immediately, so these have to exist by then.
  const tablePrefs = useTablePrefs('costs');
  const projectLabels = useProjectLabels();
  const bridge = useBridgeEntity(); // decides whether the Tax rate column exists
  const densityClass = DENSITY_CLASS[tablePrefs.density] || DENSITY_CLASS.Medium;
  // Documents under side-by-side duplicate review — held as ids and paired with
  // what they matched at render time, so the panes follow the live rows. Up here
  // with tablePrefs because the column definitions below reference the setter.
  const [dupIds, setDupIds] = useState(null);
  const navigate = useNavigate();
  const { user, visionEnabled } = useAuth();
  // Label for uploads with no recorded creator ("You" = whoever is viewing).
  const meName = user?.name || user?.email || 'You';
  // A row with nobody recorded is UNASSIGNED, not you. This used to substitute
  // the signed-in person's own name, so the same document read as "Cze Yang
  // Goh" to one colleague and "Astrid Yang" to the next.
  const uploaderLabel = (d) => (d.user && d.user !== 'You' ? d.user : UNASSIGNED);

  // Every column the table can show, with how it renders. What's actually on
  // screen (and how tightly) comes from the gear menu — see tablePrefs.js.
  const CELLS = {
    status: {
      cell: (d) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={d.status} published={Boolean(d.xeroInvoiceId)} />
          {/* Billed to somebody who isn't this entity. On the ROW because a
              document nobody opens is exactly the one that gets published into
              the wrong client's ledger — and the badge is the only thing that
              would make anybody open it. The verdict comes from the server with
              the listing (server/src/entityCheck.ts). */}
          {d.entityCheck?.status === 'mismatch' && (
            <span
              title={`${d.entityCheck.reason} Open it to move it to the right entity, or to confirm it belongs here.`}
              className="inline-flex items-start gap-1 rounded border border-amber-600/50 bg-amber-500/15 px-1.5 py-0.5 text-left text-[11px] font-medium leading-tight text-amber-800"
            >
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" strokeWidth={2} /> Billed to{' '}
              {d.entityCheck.billedTo || 'another company'}
            </span>
          )}
          {isInInbox(d) && d.duplicateOfId && !d.duplicateDismissed && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDupIds([d.id]); }}
              title="Matches a document already submitted — compare them side by side"
              className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20"
            >
              <AlertTriangle className="h-3 w-3" strokeWidth={2} /> Possible duplicate
            </button>
          )}
          {/* What the reader could not decide, on the row that is waiting for
              it — a document sitting in To review with no reason shown is just
              a document you have to open to find out about. Suppressed on a
              blank read, where the badge below says it better.

              It WRAPS. "Needs: Supplier, Date, Category" is the longest thing
              in this column by far, and holding it on one line made Status the
              widest column on the page for the sake of a badge. */}
          {needsReview(d) && !statesNothing(docFacts(d)) && (
            <span
              title="The reader could not fill these in. Open the document and supply them — it moves to Ready by itself once they are there."
              className="inline-flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-left text-[11px] font-medium leading-tight text-amber-700"
            >
              Needs: {missingFields(d).join(', ')}
            </span>
          )}
          {/* Wherever the row appears, not only in the inbox: a document the
              reader got nothing off is now SET ASIDE rather than filed, and it
              is in Archived that somebody needs to be told why it is there.
              Still never while it is being read — blank is what a document
              looks like for the ten to thirty seconds before its answer
              lands. */}
          {d.status !== 'processing' && statesNothing(docFacts(d)) && (
            <span
              title="The reader got nothing off this document — no supplier, total, date or reference. Open it to read it again by hand, or merge it with the document it is a page of."
              className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-muted-foreground/30 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              <AlertTriangle className="h-3 w-3" strokeWidth={2} /> Nothing read
            </span>
          )}
          {mergeGroupFor.has(d.id) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const g = mergeGroupFor.get(d.id);
                setSelected(new Set(g.docs.map((x) => x.id)));
                setMergeNote(`${describeMergeGroup(g)} Review the combined result and confirm below.`);
                setMergeModalDocs(g.docs);
              }}
              title={`${describeMergeGroup(mergeGroupFor.get(d.id))} Open the merge review for all ${mergeGroupFor.get(d.id).docs.length}.`}
              className="inline-flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-left text-[11px] font-medium leading-tight text-amber-700 transition-colors hover:bg-amber-500/20"
            >
              <Layers className="mt-px h-3 w-3 shrink-0" strokeWidth={2} /> {mergeBadgeLabel(mergeGroupFor.get(d.id), d)}
            </button>
          )}
        </div>
      ),
    },
    user: { cellClass: 'whitespace-nowrap', cell: (d) => <span className={cn(d.unread && 'font-semibold')}>{uploaderLabel(d)}</span> },
    date: { cellClass: 'whitespace-nowrap tabular-nums text-muted-foreground', cell: (d) => formatDate(d.date) },
    supplier: { cell: (d) => <span className={cn(d.unread && 'font-semibold')}>{d.supplier}</span> },
    category: {
      interactive: true,
      cell: (d) => (
        <CategorySelect value={d.category || 'Uncategorised'} onChange={(v) => changeCategory(d, v)} options={categoryOptions} />
      ),
    },
    total: {
      align: 'right',
      cellClass: 'whitespace-nowrap tabular-nums',
      cell: (d) => (
        <>
          <span className="text-xs text-muted-foreground">{d.currency || 'SGD'} </span>
          <span className={cn(d.unread && 'font-semibold')}>{d.total}</span>
        </>
      ),
    },
    tax: { align: 'right', cellClass: 'tabular-nums text-muted-foreground', cell: (d) => d.tax },
    taxRate: {
      sortable: false,
      interactive: true,
      cell: (d) => (
        <ComboSelect
          size="xs"
          className="w-36"
          aria-label="Tax rate"
          value={(gstRegistered ? d.taxRate : noTaxName) || ''}
          // '' stays on the list so a rate can be cleared again, the way the
          // native select's empty option did.
          options={['', ...taxRateOptions]}
          onChange={(v) => changeTaxRate(d, v)}
          // "Not set" — NOT "No tax rate", which read as a near-twin of the real
          // Xero code "No Tax" and made an undecided document indistinguishable
          // from one deliberately coded zero-rated. They mean opposite things:
          // one is waiting on a person, the other is an answer.
          format={(t) => t || 'Not set'}
          emptyLabel="Not set"
        />
      ),
    },
    ref: { cellClass: 'whitespace-nowrap text-muted-foreground', cell: (d) => d.invoiceNumber || '—' },
    description: { cellClass: 'max-w-[260px] truncate text-muted-foreground', cell: (d) => d.description || '—' },
    itemId: { cellClass: 'whitespace-nowrap font-mono text-xs text-muted-foreground', cell: (d) => itemNumber(d) },
    type: { cellClass: 'whitespace-nowrap text-muted-foreground', cell: (d) => d.type || '—' },
    dueDate: { cellClass: 'whitespace-nowrap tabular-nums text-muted-foreground', cell: (d) => (d.dueDate ? formatDate(d.dueDate) : '—') },
    // Two different questions, two columns. `paid` is the capture flag the
    // reviewer sets (Dext's sense); `xeroPaid` is what the ledger reports back.
    paid: { sortable: false, cellClass: 'whitespace-nowrap text-muted-foreground', cell: (d) => (d.paid ? 'Paid' : 'Not paid') },
    xeroPaid: {
      sortable: false,
      cellClass: 'whitespace-nowrap',
      cell: (d) => {
        const status = xeroPaidStatus(d);
        // A dash, not "Not paid": nobody has asked Xero about this document —
        // it was never published, or nothing has happened to it since.
        if (!status) return <span className="text-muted-foreground">—</span>;
        const tone =
          status.tone === 'paid'
            ? 'text-green-700'
            : status.tone === 'void'
              ? 'text-muted-foreground line-through'
              : 'text-muted-foreground';
        return (
          <span className={tone} title={d.xeroPaidDate ? `Paid in Xero on ${formatDate(d.xeroPaidDate)}` : undefined}>
            {status.label}
          </span>
        );
      },
    },
    paidDate: {
      cellClass: 'whitespace-nowrap tabular-nums text-muted-foreground',
      cell: (d) => (d.xeroPaidDate ? formatDate(d.xeroPaidDate) : '—'),
    },
    paymentRef: { sortable: false, cellClass: 'max-w-[180px] truncate text-muted-foreground', cell: (d) => d.xeroPaymentRef || '—' },
    paymentMethod: { cellClass: 'whitespace-nowrap text-muted-foreground', cell: (d) => d.paymentMethod || '—' },
    customer: { cellClass: 'whitespace-nowrap text-muted-foreground', cell: (d) => d.customer || '—' },
    project: { cellClass: 'whitespace-nowrap text-muted-foreground', cell: (d) => d.project || '—' },
    cardLast4: { sortable: false, cellClass: 'whitespace-nowrap text-muted-foreground', cell: (d) => (d.cardLast4 ? `•••• ${d.cardLast4}` : '—') },
    note: { sortable: false, cellClass: 'max-w-[200px] truncate text-muted-foreground', cell: (d) => d.note || '—' },
    uploadDate: { cellClass: 'whitespace-nowrap tabular-nums text-muted-foreground', cell: (d) => (d.createdAt ? formatDate(d.createdAt.slice(0, 10)) : '—') },
    publishDate: { cellClass: 'whitespace-nowrap tabular-nums text-muted-foreground', cell: (d) => (d.xeroPostedAt ? formatDate(d.xeroPostedAt.slice(0, 10)) : '—') },
    xero: {
      sortable: false,
      interactive: true,
      cell: (d) =>
        d.xeroInvoiceId ? (
          <a href={xeroBillUrl(d.xeroInvoiceId, xeroShortCode)} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
            View
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  };
  const shownColumns = withProjectLabels(COST_COLUMNS, projectLabels)
    // A bridge entity has no tax position of its own — its claims post with No
    // Tax at the full amount — so a tax code can never reach the ledger from
    // here, and the column could only ever read "Not set".
    .filter((c) => !(bridge && c.key === 'taxRate'))
    .filter((c) => c.fixed || tablePrefs.columns[c.key])
    .map((c) => ({ ...c, ...CELLS[c.key] }))
    .filter((c) => typeof c.cell === 'function');
  // The tab, the scope and the narrowing all survive a trip to a document and
  // back — see listView.js. Reviewing is a loop of narrow, open, come back, and
  // landing on an unfiltered Unpublished each time meant redoing it per row.
  const [tab, setTab] = useListView('costs', 'tab', 'all');
  // Which half of the combined list the Costs tab is showing. Defaults to the
  // work still to do — see SCOPES.
  const [scope, setScope] = useListView('costs', 'scope', 'unpublished');
  const settings = useExtractionSettings();
  // What a publish posts as, this entity's own answer — the same one the
  // document page's dialog opens on, so pressing Publish in two places cannot
  // put two different statuses in one ledger.
  const publishStatus = settings.publishStatus || 'AUTHORISED';
  // Names the entity in every "View in Xero" link on the page, so one client's
  // bill can't open in another client's ledger.
  const xeroShortCode = useXeroShortCode();
  // Business settings → Extraction can hide the To review + Ready tabs (their
  // docs still live under Inbox with their status tag).
  const visibleTabs = TABS.filter(
    (t) => settings.showReviewReadyTabs || (t.key !== 'review' && t.key !== 'ready')
  );
  useEffect(() => {
    if (!settings.showReviewReadyTabs && (tab === 'review' || tab === 'ready')) setTab('all');
  }, [settings.showReviewReadyTabs, tab]);
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useListView('costs', 'query', '');
  const [claimOpen, setClaimOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [sort, setSort] = useState({ key: '', dir: 'asc' });
  const [filters, setFilters] = useListView('costs', 'filters', emptyFilters); // Filter popover: id -> chosen chip
  const [adv, setAdv] = useListView('costs', 'adv', emptyAdv); // Advanced search: amount / date / supplier / user
  const [mergeModalDocs, setMergeModalDocs] = useState(null); // docs under review in the merge modal
  const [mergeNote, setMergeNote] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  // Export all vs Actions → Export selected: the same dialog over a different
  // set of rows, so the button that opened it decides what goes in the file.
  const [exportSelectionOnly, setExportSelectionOnly] = useState(false);
  const [running, setRunning] = useState(''); // a long bulk action in flight

  // Combined document set (persisted bills + sample docs with local edits).
  const { allDocs, reload } = useCostsDocs();
  const flagAssignments = useFlagAssignments();
  const categoryOptions = useCategoryOptions();
  const taxRates = useVisibleTaxRates(); // shared managed list (Lists → Tax rates)
  const allTaxRates = useManagedTaxRates(); // …and the same list unfiltered
  // Not GST-registered → No Tax is the only code on offer, and the row shows it
  // even for a document coded before the profile said so (opening the document
  // rewrites the stored value).
  const gstRegistered = useGstRegistered();
  // The org's own currency, so "Foreign currency" means foreign to THIS entity.
  const baseCurrency = useBusinessProfile().baseCurrency;
  const readerName = useReaderName();
  const noTaxName = noTaxRateName(taxRates);
  const taxRateOptions = gstRegistered ? taxRates.map((t) => t.name) : [noTaxName].filter(Boolean);

  // Every tab's rows, so its badge count ties to what the tab actually shows.
  const rowsByTab = {
    processing: rowsFor(allDocs, 'processing'),
    // The working list under Unpublished: processing, to review and ready
    // together, which is what the three tabs after it count. Under All costs it
    // is the whole book bar the set-aside pile, which is a different question
    // being asked of the same tab — history rather than what is outstanding.
    all: rowsFor(allDocs, scope === 'all' ? 'costs-all' : 'costs'),
    review: rowsFor(allDocs, 'review'),
    ready: rowsFor(allDocs, 'ready'),
    // The settled work, seen through whichever scope is selected: under
    // Unpublished it is the documents archived by hand and never published;
    // under All costs it also holds the published, the claimed and the merged.
    archived: rowsFor(allDocs, scope).filter(isArchived),
  };
  // Both sides of the toggle, counting the tab it is actually drawn on: what
  // each scope reaches HERE, never the whole book. A count that answered for
  // the other tab would be a number the list beside it contradicts.
  const scopeCounts = tab === 'archived'
    ? {
        unpublished: rowsFor(allDocs, 'unpublished').filter(isArchived).length,
        all: rowsFor(allDocs, 'all').filter(isArchived).length,
      }
    : {
        unpublished: rowsFor(allDocs, 'costs').length,
        all: rowsFor(allDocs, 'costs-all').length,
      };
  const allRows = rowsByTab[tab] ?? [];
  // Everything flagged, whichever tab it's in — a flag raised on an inbox
  // document often points at one that's since been archived, and reviewing it
  // means seeing both. Only inbox documents carry a flag: a settled one's
  // verdict is spent, so a flag left on it from before is ignored here (and
  // cleared for good by the next scan).
  const docById = new Map(allDocs.map((d) => [d.id, d]));
  const userOptions = useMemo(() => ownersOf(allDocs), [allDocs]);
  const flaggedDocs = allDocs.filter(
    (d) => isInInbox(d) && d.duplicateOfId && !d.duplicateDismissed && docById.has(d.duplicateOfId)
  );

  // Merge detection, run over the whole inbox whenever the documents change —
  // the reviewer is TOLD which uploads are really one document rather than
  // having to suspect it and go looking. A suggestion is a badge on the row and
  // an entry in the toolbar; Off says not to look at all, since an entity that
  // never merges anything does not want a badge about it.
  const mergeMode = settings.mergeMode || 'Automatic';
  const mergeGroups = useMemo(
    () => (mergeMode === 'Off' ? [] : findMergeCandidates(rowsFor(allDocs, 'inbox'))),
    [allDocs, mergeMode]
  );
  // Automatic: the STRONGEST tier is combined without asking. A firm group is
  // tied by a shared fact — the same reference, the same total, or the same
  // supplier uploaded in one go — or was cut from one PDF by this app, which is
  // a record rather than a guess. The provisional pairs (nothing read off one
  // half, held together only by arriving together) and the receipt/card-slip
  // pairs stay suggestions: those are judgements, and a wrong one makes one
  // document out of two real costs.
  //
  // Nothing is announced — that is the point of Automatic — but nothing is lost
  // either: the combined document points at its sources (`mergedFrom`), they
  // survive hidden, and Unmerge puts them back.
  //
  // One at a time, and a group is attempted once: a failure leaves the
  // suggestion in the toolbar to be done by hand rather than being retried on
  // every render.
  const autoMerging = useRef(false);
  const autoMergeTried = useRef(new Set());
  useEffect(() => {
    if (mergeMode !== 'Automatic' || autoMerging.current) return;
    const keyOf = (g) => g.docs.map((d) => d.id).sort().join('|');
    const group = mergeGroups.find(
      (g) => g.confidence === 'firm' && g.kind === 'pages' && !autoMergeTried.current.has(keyOf(g))
    );
    if (!group) return;
    autoMerging.current = true;
    autoMergeTried.current.add(keyOf(group));
    (async () => {
      let merged = false;
      try {
        const preview = await buildMergePreview(group.docs);
        // A preview with something to say is not a silent merge. The loudest of
        // those is "these look like the same document": a duplicate is kept and
        // the copy archived, never combined, and getting that backwards turns
        // two real costs into one.
        if (preview?.sources?.length >= 2 && !preview.warnings.length) {
          const res = await commitMerge(preview.sources, preview.base64, preview.fields);
          merged = Boolean(res?.ok);
        }
      } catch {
        // Best-effort, like the automatic publish: the suggestion is still there.
      } finally {
        autoMerging.current = false;
      }
      if (merged) await reload();
    })();
  }, [mergeGroups, mergeMode]);

  // Row id -> the suggestion it belongs to, so a row can offer its own merge.
  const mergeGroupFor = useMemo(() => {
    const m = new Map();
    mergeGroups.forEach((g) => g.docs.forEach((d) => m.set(d.id, g)));
    return m;
  }, [mergeGroups]);
  // Ids → { duplicate, original } for the review panes; a pair whose other half
  // has since been deleted or cleared simply drops out.
  const dupPairs = (dupIds || [])
    .map((docId) => {
      const duplicate = docById.get(docId);
      const original = duplicate && docById.get(duplicate.duplicateOfId);
      return duplicate && original && !duplicate.duplicateDismissed ? { duplicate, original } : null;
    })
    .filter(Boolean);
  const q = query.trim().toLowerCase();
  const toNum = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const toTime = (v) => { const t = new Date(v).getTime(); return Number.isNaN(t) ? 0 : t; };

  // The quick search reads the document owner as well — by the name the User
  // column shows AND by the email behind it, so "yoav" and "yoav@…" both land.
  let rows = q
    ? allRows.filter((d) =>
        [d.supplier, d.user, d.ownerEmail, d.createdByEmail, d.category, d.date].some((v) =>
          String(v || '').toLowerCase().includes(q)
        )
      )
    : allRows;
  // Filter popover (flag, tax, category, publishing, …) + Advanced search
  // (amount / date / supplier). The popover's rules live in one list so a chip
  // can't be offered without being applied.
  rows = applyCostFilters(rows, filters, { flags: flagAssignments, baseCurrency });
  if (adv.min) rows = rows.filter((d) => toNum(d.total) >= toNum(adv.min));
  if (adv.max) rows = rows.filter((d) => toNum(d.total) <= toNum(adv.max));
  if (adv.from) rows = rows.filter((d) => toTime(d.date) >= toTime(adv.from));
  if (adv.to) rows = rows.filter((d) => toTime(d.date) <= toTime(adv.to));
  if (adv.supplier.trim()) {
    const s = adv.supplier.trim().toLowerCase();
    rows = rows.filter((d) => String(d.supplier || '').toLowerCase().includes(s));
  }
  if (adv.user.trim()) rows = rows.filter((d) => isOwnedBy(d, adv.user));
  if (sort.key) {
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Columns whose key isn't the field name they sort on.
    const FIELD = { ref: 'invoiceNumber', itemId: 'id', uploadDate: 'createdAt', publishDate: 'xeroPostedAt', paidDate: 'xeroPaidDate', paymentRef: 'xeroPaymentRef', xeroPaid: 'xeroStatus' };
    const DATES = new Set(['date', 'dueDate', 'uploadDate', 'publishDate', 'paidDate']);
    const field = FIELD[sort.key] || sort.key;
    rows = [...rows].sort((a, b) => {
      if (sort.key === 'total' || sort.key === 'tax') return (toNum(a[field]) - toNum(b[field])) * dir;
      if (DATES.has(sort.key)) return (toTime(a[field]) - toTime(b[field])) * dir;
      return String(a[field] || '').localeCompare(String(b[field] || '')) * dir;
    });
  }
  const hasSelection = selected.size > 0;

  // Change a row's category — persists for uploaded bills (server) and samples
  // (localStorage).
  const changeCategory = (d, value) => {
    if (d.persisted) updateBill(d.id, { category: value }).then(reload).catch(() => {});
    else setDocOverride(d.id, { category: value });
  };

  // Permanently delete a single document. For an uploaded bill this removes the
  // record AND its stored file from Cloudflare (reclaiming storage) — it cannot
  // be undone, so confirm first. (To just take a doc out of the inbox and keep
  // it, use Archive instead.) Sample/local docs have no server file.
  const deleteOne = (d) => {
    if (!window.confirm(`Permanently delete this document from ${d.supplier || 'Unknown supplier'}?\n\nThis removes it everywhere and deletes the file from storage — it can't be undone. To keep it out of the inbox but recoverable, use Archive.`)) return;
    if (d.persisted)
      deleteBill(d.id)
        .then(() => {
          notifyBillsChanged();
          reload();
        })
        .catch(() => {});
    else setDocOverride(d.id, { status: 'deleted' });
  };

  // Pick a GST/tax rate inline. Fills the tax amount from the rate (GST-inclusive)
  // and persists — replaces the old fixed "Extracted amount" placeholder.
  const changeTaxRate = (d, name) => {
    const r = Number(taxRates.find((t) => t.name === name)?.rate ?? 0);
    const total = toNum(d.total);
    const tax = r > 0 && total > 0 ? (total * r) / (100 + r) : 0;
    // Choosing the blank option is a decision, and it is recorded as one:
    // an empty tax rate on its own is also what a reader leaves behind when it
    // has no code to offer, and the two must not look alike — otherwise the
    // listing's backfill either overrules this person or never repairs those.
    const patch = {
      taxRate: name,
      tax: tax ? tax.toFixed(2) : '0.00',
      taxRateCleared: !name,
      // …and a code they PICKED is a decision too, held against a later re-read
      // the same way the blank is held against the backfill.
      taxRateEdited: Boolean(name),
    };
    if (d.persisted) updateBill(d.id, patch).then(reload).catch(() => {});
    else setDocOverride(d.id, patch);
  };

  // Move every selected document to a workflow status (the pipeline step) —
  // persisted bills via the server, sample docs via localStorage overrides.
  const moveSelected = async (status, ids = null) => {
    const byId = new Map(allRows.map((r) => [r.id, r]));
    await Promise.all(
      (ids ?? [...selected]).map((id) => {
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

  // Permanently delete every selected document — removes each record AND its
  // stored file from Cloudflare. Destructive and irreversible (use Archive to
  // keep them); confirm first.
  const deleteSelected = async () => {
    if (!selected.size) return;
    if (!window.confirm(`Permanently delete ${selected.size} item(s)?\n\nThis removes them everywhere and deletes their files from storage — it can't be undone. To keep them but out of the inbox, use Archive.`)) return;
    const byId = new Map(allRows.map((r) => [r.id, r]));
    await Promise.all(
      [...selected].map((id) => {
        const d = byId.get(id);
        if (!d) return null;
        if (d.persisted) return deleteBill(d.id).catch(() => {});
        setDocOverride(d.id, { status: 'deleted' });
        return null;
      })
    );
    notifyBillsChanged();
    setSelected(new Set());
    reload();
  };

  // Add the selected docs to a chosen expense claim, then mark them accordingly.
  // A document already published to Xero is left out: that cost is in the ledger
  // as a bill, and claiming it as well would pay for it twice. The server
  // refuses those outright, so filter here and say which ones were skipped
  // rather than let the whole batch fail on one of them.
  const addSelectedToClaim = async (targetId) => {
    const actor = user?.name || user?.email || 'You';
    const byId = new Map(allRows.map((r) => [r.id, r]));
    const picked = [...selected].map((id) => byId.get(id)).filter(Boolean);
    const published = picked.filter((d) => d.xeroInvoiceId);
    const claimable = picked.filter((d) => !d.xeroInvoiceId);
    if (!claimable.length) {
      setMergeNote(
        published.length === 1
          ? 'That document is already published to Xero, so it can’t also go on an expense claim.'
          : 'Those documents are already published to Xero, so they can’t also go on an expense claim.'
      );
      return;
    }
    try {
      for (const d of claimable) {
        // eslint-disable-next-line no-await-in-loop
        await addItemToClaim(targetId, docToClaimTxn(d, d, actor));
      }
    } catch (err) {
      setMergeNote(
        err?.code === 'claim_locked'
          ? 'That claim is already approved, so items can’t be added to it.'
          : 'Could not add every item to the claim — please try again.'
      );
      notifyBillsChanged();
      return;
    }
    setMergeNote(
      published.length
        ? `Added ${claimable.length} item(s). ${published.length} already published to Xero — those can’t also go on a claim.`
        : ''
    );
    moveSelected('expenseclaim', claimable.map((d) => d.id));
  };

  // Merge: open the Dext-style review screen for the selected documents (page 1 +
  // page 2, an invoice + its backup, a re-upload). Nothing is combined until the
  // reviewer confirms in the modal.
  const mergeSelected = () => {
    const byId = new Map(allRows.map((r) => [r.id, r]));
    const docs = [...selected].map((id) => byId.get(id)).filter(Boolean);
    const withFiles = docs.filter((d) => d.persisted && d.hasFile);
    if (withFiles.length < 2) {
      setMergeNote('Select at least 2 uploaded documents (each with a file) to merge into one.');
      return;
    }
    setMergeNote('');
    setMergeModalDocs(docs);
  };

  // Open the review modal on the next outstanding suggestion. Detection itself
  // runs continuously over the inbox (see `mergeGroups`) — this is the way in
  // when you would rather work through them from the toolbar than click a badge.
  const openNextMergeSuggestion = () => {
    if (!mergeGroups.length) {
      const blanks = rowsFor(allDocs, 'inbox').filter((d) => statesNothing(docFacts(d))).length;
      setMergeNote(
        blanks > 1
          ? `Nothing could be paired up. ${blanks} documents in the inbox read as blank, so there is no way to tell which of them is a page of what — open one to read it again, or select it with its other half and press Merge.`
          : 'Nothing in the inbox looks like two halves of one document, or a receipt with its card slip. To combine documents anyway, select them and press Merge.',
      );
      return;
    }
    const g = mergeGroups[0];
    setSelected(new Set(g.docs.map((d) => d.id)));
    setMergeNote(`${describeMergeGroup(g)} Review the combined result and confirm below.`);
    setMergeModalDocs(g.docs);
  };

  // Confirm from the modal: create the combined cost and move the originals to
  // 'merged'. Readiness of the new doc derives itself from its fields.
  const confirmMerge = async (sources, base64, fields) => {
    try {
      const res = await commitMerge(sources, base64, fields);
      if (res.ok) {
        setMergeModalDocs(null);
        setSelected(new Set());
        await reload();
        setMergeNote(
          `Merged ${res.count} documents into one — the combined document is the cost now, and the originals have left the list. Open it and press Unmerge to put them back.`
        );
      } else {
        setMergeNote('Could not merge those documents. Please try again.');
      }
    } catch {
      setMergeNote('Merge failed. Please try again.');
    }
  };

  // Which of the ticked rows each of the two moves can act on. Unarchive is
  // deliberately narrower than the Archive tab's old button: a document on a
  // live expense claim, or one MERGED away into another, is not "archived" —
  // pulling either back into the inbox would make a second copy of money that
  // is already accounted for somewhere.
  const archivableIds = allRows.filter((d) => selected.has(d.id) && isInInbox(d)).map((d) => d.id);
  const unarchivableIds = allRows
    .filter((d) => selected.has(d.id) && d.status === 'archived')
    .map((d) => d.id);

  // The selected documents, in the order the table shows them.
  const selectedDocs = () => {
    const byId = new Map(allRows.map((r) => [r.id, r]));
    return [...selected].map((id) => byId.get(id)).filter(Boolean);
  };

  // Write one patch across every selected document (Bulk edit, Mark as paid).
  // A document already published to Xero is left alone: its figures are in the
  // ledger, and editing the copy here would only make the two disagree — say so
  // rather than quietly changing some of the selection.
  const patchSelected = async (patch, what) => {
    const picked = selectedDocs();
    const published = picked.filter((d) => d.xeroInvoiceId);
    const targets = picked.filter((d) => !d.xeroInvoiceId);
    if (!targets.length) {
      setMergeNote(
        published.length
          ? 'Every selected document is already published to Xero — those can’t be edited here.'
          : 'Nothing selected.'
      );
      return;
    }
    await Promise.all(
      targets.map((d) => {
        const p = { ...patch };
        // A tax rate carries the tax amount it implies — worked out per
        // document from that document's own total, exactly as the inline Tax
        // rate cell does.
        if ('taxRate' in p) {
          const r = Number(taxRates.find((t) => t.name === p.taxRate)?.rate ?? 0);
          const total = toNum(d.total);
          const tax = r > 0 && total > 0 ? (total * r) / (100 + r) : 0;
          p.tax = tax ? tax.toFixed(2) : '0.00';
        }
        if (d.persisted) return updateBill(d.id, p).catch(() => null);
        setDocOverride(d.id, p);
        return null;
      })
    );
    notifyBillsChanged();
    await reload();
    setSelected(new Set());
    setMergeNote(
      `${what} on ${targets.length} document${targets.length === 1 ? '' : 's'}.` +
        (published.length
          ? ` ${published.length} already published to Xero ${published.length === 1 ? 'was' : 'were'} left alone.`
          : '')
    );
  };

  const applyBulkEdit = async (patch) => {
    setBulkOpen(false);
    // Coding a selection is as much a person's decision as coding one document,
    // so it is recorded as one — otherwise a later re-read would put its own
    // answer back over forty of them at once.
    if ('taxRate' in patch) {
      patch.taxRateEdited = Boolean(patch.taxRate);
      patch.taxRateCleared = !patch.taxRate;
    }
    const names = Object.keys(patch).length;
    await patchSelected(patch, `Updated ${names} field${names === 1 ? '' : 's'}`);
  };

  // Rerun processing: read the selected documents again. The first read can come
  // back with nothing — a dark photo, a PDF that is really a scan — and the
  // document then sits in the inbox as "Unknown supplier / 0.00" with no way
  // forward but typing it in by hand. This is that way forward, and it's also
  // how a supplier rule written AFTER the upload reaches the documents it was
  // written for. One document at a time: each read is a model call billed to
  // this client entity, and firing forty at once is how you rate-limit yourself.
  const reReadSelected = async () => {
    const picked = selectedDocs().filter((d) => d.persisted && d.hasFile);
    if (!picked.length) {
      setMergeNote('Select uploaded documents (each with a file) to rerun processing on.');
      return;
    }
    setRunning('reread');
    const ctx = {
      accounts: await getExtractionAccounts().catch(() => []),
      gstRegistered,
      taxRates,
      allTaxRates,
      defaultTaxRateCosts: settings.defaultTaxRateCosts,
    };
    const tally = { ok: 0, blank: 0, nofile: 0, failed: 0 };
    for (let i = 0; i < picked.length; i += 1) {
      setMergeNote(`Rerunning ${i + 1} of ${picked.length} through ${readerName}…`);
      tally[await reReadDocument(picked[i], ctx)] += 1;
    }
    notifyBillsChanged();
    await reload();
    setRunning('');
    setSelected(new Set());
    setMergeNote(
      `Reran ${tally.ok + tally.blank} document${tally.ok + tally.blank === 1 ? '' : 's'} through ${readerName}` +
        (tally.ok ? `, reading ${tally.ok} of them.` : '.') +
        // A second blank read is the file's fault, not the reader's — say so
        // rather than leaving someone to press the button a third time.
        (tally.blank
          ? ` ${tally.blank} came back with no supplier or total — open ${tally.blank === 1 ? 'it' : 'them'} and check the file is a legible receipt, or fill the fields in by hand.`
          : '') +
        (tally.failed ? ` ${tally.failed} could not be read at all.` : '') +
        (tally.nofile ? ` ${tally.nofile} had no file to read.` : '')
    );
  };

  // Publish the selected documents to Xero as supplier bills, using the same
  // account + tax code the document was already categorised into. Deliberately
  // conservative, the same way the automatic publish is: it skips rather than
  // guesses — already published, on an expense claim, incomplete, or a category
  // that isn't in this org's chart. Publishing finishes a document (it archives,
  // and can no longer go on a claim), so it asks first.
  const publishSelected = async () => {
    const picked = selectedDocs();
    const skipped = {
      published: picked.filter((d) => d.xeroInvoiceId).length,
      claimed: picked.filter((d) => !d.xeroInvoiceId && d.status === 'expenseclaim').length,
    };
    const targets = picked.filter((d) => !d.xeroInvoiceId && d.status !== 'expenseclaim' && isComplete(d));
    const incomplete = picked.length - targets.length - skipped.published - skipped.claimed;
    if (!targets.length) {
      setMergeNote(
        'Nothing to publish — a document must have a supplier, a date, a real category and a total above 0, ' +
          'and not already be published or on an expense claim.'
      );
      return;
    }
    // Named in the confirmation rather than skipped: a document billed to
    // another company is often perfectly correct (an intercompany recharge, a
    // trading name, a group company paying for a subsidiary), so it is not ours
    // to refuse — but publishing it here claims THIS client's input tax on
    // somebody else's supply, and nothing else in this dialog would say so.
    const misfiled = targets.filter((d) => d.entityCheck?.status === 'mismatch');
    if (
      !window.confirm(
        `Publish ${targets.length} document(s) to Xero as ${publishStatusLabel(publishStatus).toLowerCase()} bills?\n\n` +
          'This writes to the live ledger and finishes each document — it archives, and can no longer go on an expense claim.' +
          (misfiled.length
            ? `\n\n${misfiled.length} of them ${misfiled.length === 1 ? 'is' : 'are'} billed to another company` +
              ` (${misfiled.slice(0, 3).map((d) => d.entityCheck.billedTo).join(', ')}).` +
              ` Open ${misfiled.length === 1 ? 'it' : 'them'} first if` +
              ` ${misfiled.length === 1 ? 'it belongs' : 'they belong'} to a different client.`
            : '')
      )
    )
      return;
    setRunning('publish');
    setMergeNote(`Publishing ${targets.length} document(s) to Xero…`);
    const orgId = await resolveCategorisationOrgId().catch(() => '');
    if (!orgId) {
      setRunning('');
      setMergeNote('No Xero organisation is linked, so there is nowhere to publish to.');
      return;
    }
    const [accounts, rates] = await Promise.all([
      fetchXeroAccounts(orgId).catch(() => []),
      fetchXeroTaxRates(orgId).catch(() => []),
    ]);
    let done = 0;
    const failed = [];
    for (const d of targets) {
      const accountCode = accountCodeFromCategory(d.category);
      const account = accounts.find((a) => a.code === accountCode);
      const taxType = rates.find((t) => t.name === d.taxRate)?.taxType || account?.taxType || '';
      if (!account || !taxType) {
        failed.push(d.supplier || 'Unknown supplier');
        continue;
      }
      try {
        await publishBillToXero(orgId, { billId: d.id, accountCode, taxType, status: publishStatus });
        done += 1;
      } catch {
        failed.push(d.supplier || 'Unknown supplier');
      }
    }
    notifyBillsChanged();
    await reload();
    setRunning('');
    setSelected(new Set());
    setMergeNote(
      `Published ${done} document${done === 1 ? '' : 's'} to Xero as draft bills.` +
        (failed.length ? ` ${failed.length} could not be published (${failed.slice(0, 3).join(', ')}).` : '') +
        (skipped.published ? ` ${skipped.published} already published.` : '') +
        (skipped.claimed ? ` ${skipped.claimed} on an expense claim.` : '') +
        (incomplete > 0 ? ` ${incomplete} still missing a supplier, date, category or total.` : '')
    );
  };

  const actions = {
    move: moveSelected,
    del: deleteSelected,
    addClaim: () => hasSelection && setClaimOpen(true),
    exportCsv: () => { setExportSelectionOnly(false); setExportOpen(true); },
    exportSelected: () => { setExportSelectionOnly(true); setExportOpen(true); },
    bulkEdit: () => hasSelection && setBulkOpen(true),
    reRead: reReadSelected,
    publish: publishSelected,
    canReRead: visionEnabled,
    readerName,
    busy: Boolean(running),
    merge: mergeSelected,
    scanMerges: openNextMergeSuggestion,
    mergeCount: mergeGroups.length,
    reviewDuplicates: () => setDupIds(flaggedDocs.map((d) => d.id)),
    dupCount: flaggedDocs.length,
    // Archiving and its undo now sit in one row over one list, so each acts on
    // the half of the selection it MEANS and leaves the rest alone. Written
    // across the whole selection they would each do real damage: Archive would
    // strip 'expenseclaim' off a document sitting on a live claim, and
    // Unarchive would knock a Ready inbox document back to New.
    archive: () => moveSelected('archived', archivableIds),
    unarchive: () => moveSelected('new', unarchivableIds),
    canArchive: archivableIds.length > 0,
    canUnarchive: unarchivableIds.length > 0,
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
        {visibleTabs.map((t) => {
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
        {/* How the tabs fill themselves. This was a banner above the table —
            explanatory, not essential, and it cost every visit a row of the
            screen to say the same sentence. The sentence now waits on the
            glyph for whoever wants it. */}
        <span
          className="flex shrink-0 cursor-help items-center pb-3 pt-1 text-muted-foreground"
          title="A document moves to Ready automatically once it has a Supplier, Date, Category, and a Total above 0. While any of those is missing — an account code the reader could not decide, most often — it waits in To review for you to supply it. Both tabs fill themselves; there is nothing to move by hand."
        >
          <Info className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span className="sr-only">
            A document moves to Ready automatically once it has a Supplier, Date, Category, and a Total above 0.
            While any of those is missing it waits in To review for you to supply it. Both tabs fill themselves;
            there is nothing to move by hand.
          </span>
        </span>
      </div>

      {/* Drawn on the two tabs that hold more than one kind of document: Costs,
          where All costs adds the published history a supplier is filtered
          across, and Archived, where it says how far back the set-aside pile
          reaches. Not on Processing / To review / Ready — each of those is one
          kind of working document, so the toggle would have nothing to say. */}
      {(tab === 'all' || tab === 'archived') && (
        <ScopeToggle
          scope={scope}
          setScope={(next) => {
            setScope(next);
            // Narrowing the list would otherwise leave rows ticked that are no
            // longer on screen, and the next bulk action would act on them.
            setSelected(new Set());
          }}
          counts={scopeCounts}
        />
      )}

      {tab === 'processing' ? (
        <CostProcessingView
          rows={rowsByTab.processing}
          onMoveOne={(id) => moveToInbox([id])}
          onMoveAll={() => moveToInbox()}
          meName={meName}
        />
      ) : (
        <>
          {/* Toolbar */}
          {/* Phone: one row that scrolls sideways. Wrapping fourteen buttons
              stacked them four deep and ate half the screen before any document
              appeared. Every button is still here — just in a line. */}
          <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-x-visible md:pb-0">
            <ToolbarActions tab={tab} hasSelection={hasSelection} canMerge={selected.size >= 2} a={actions} />
            <CostsToolbar
              query={query}
              setQuery={setQuery}
              filters={filters}
              setFilters={setFilters}
              adv={adv}
              setAdv={setAdv}
              userOptions={userOptions}
            />
          </div>

          {mergeNote && (
            <div className="mb-3 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
              <span>{mergeNote}</span>
              <button type="button" onClick={() => setMergeNote('')} className="ml-auto text-muted-foreground hover:text-foreground">Dismiss</button>
            </div>
          )}

          {/* Phone: cards. The table below is a thousand pixels wide, which on a
              390px screen pushed the page sideways and left Supplier, Category
              and Total off the edge — you could see the three columns that tell
              you least. Same rows, same selection, same actions. */}
          <div className="md:hidden">
            <DocCardList
              rows={rows}
              selected={selected}
              onToggle={toggle}
              onOpen={(d) => navigate(costPath(d))}
              action={{ icon: Trash2, label: 'Delete', title: 'Delete document', onClick: deleteOne }}
              badge={(d) => CELLS.status.cell(d)}
              emptyLabel={query || hasSelection ? 'No documents match.' : 'No documents in this tab.'}
            />
          </div>

          {/* Table (md and up) */}
          <div className="hidden overflow-x-auto rounded-lg border md:block">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr className="text-muted-foreground">
                  {/* Sticky: with the optional columns on, the table scrolls
                      sideways — the checkboxes have to stay reachable. */}
                  <th className="sticky left-0 z-10 w-24 bg-muted/40 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selected.size === rows.length}
                      onChange={toggleAll}
                      className="h-4 w-4 accent-black"
                    />
                  </th>
                  {/* The header row is where the widths are set — in an
                      auto-layout table the browser sizes each column from its
                      widest cell, and the <th> is the one cell every column
                      has. See COST_COLUMNS. */}
                  {shownColumns.map((c) =>
                    c.sortable === false ? (
                      <th key={c.key} className={cn('whitespace-nowrap px-3 py-2.5 font-medium', c.width, c.align === 'right' && 'text-right')}>{c.label}</th>
                    ) : (
                      <SortTh key={c.key} label={c.label} sortKey={c.key} sort={sort} setSort={setSort} align={c.align || 'left'} className={c.width} />
                    ),
                  )}
                  <th className="w-10 px-2 py-2.5"><span className="sr-only">Delete</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => navigate(costPath(d))}
                    className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40"
                  >
                    <td className={cn('sticky left-0 z-10 bg-background', densityClass)} onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        <span className={cn('h-2 w-2 rounded-full', d.unread ? 'bg-foreground' : 'bg-transparent')} />
                        <input
                          type="checkbox"
                          checked={selected.has(d.id)}
                          onChange={() => toggle(d.id)}
                          className="h-4 w-4 accent-black"
                        />
                        <FlagMenu id={d.id} />
                        <ReceiptViewer itemIds={d.id} />
                      </div>
                    </td>
                    {shownColumns.map((c) => (
                      <td
                        key={c.key}
                        onClick={c.interactive ? (e) => e.stopPropagation() : undefined}
                        className={cn(densityClass, c.cellClass, c.align === 'right' && 'text-right')}
                      >
                        {c.cell(d)}
                      </td>
                    ))}
                    <td className={cn(densityClass, 'px-2 text-center')} onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => deleteOne(d)}
                        title="Delete document"
                        aria-label="Delete document"
                        className="text-muted-foreground transition-colors hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={shownColumns.length + 2} className="px-4 py-16 text-center text-sm text-muted-foreground">
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
        onAdd={async ({ claimId, newClaim }) => {
          setClaimOpen(false);
          const targetId = newClaim ? (await createClaim(newClaim)).id : claimId;
          if (targetId) await addSelectedToClaim(targetId);
        }}
      />

      <DocsExportModal
        open={exportOpen}
        kind="costs"
        rows={exportSelectionOnly ? rows.filter((d) => selected.has(d.id)) : rows}
        onClose={() => setExportOpen(false)}
      />

      <BulkEditModal
        open={bulkOpen}
        count={selected.size}
        publishedCount={selectedDocs().filter((d) => d.xeroInvoiceId).length}
        categoryOptions={categoryOptions}
        taxRateOptions={taxRateOptions}
        onClose={() => setBulkOpen(false)}
        onApply={applyBulkEdit}
      />

      <DuplicateReviewModal
        open={dupPairs.length > 0}
        pairs={dupPairs}
        onClose={() => setDupIds(null)}
        onResolved={reload}
        onMerge={(docs) => { setDupIds(null); setMergeModalDocs(docs); }}
      />

      <MergeModal
        open={Boolean(mergeModalDocs)}
        docs={mergeModalDocs || []}
        categoryOptions={categoryOptions}
        onClose={() => setMergeModalDocs(null)}
        onConfirm={confirmMerge}
      />
    </AppShell>
  );
}
