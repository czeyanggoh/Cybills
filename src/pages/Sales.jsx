// The Sales inbox: the documents this business ISSUED, worked through exactly
// the way the Costs tab is worked through.
//
// It used to be a list of its own invention — an Inbox/Processing/To review/
// Ready/Archive tab strip over a status field only its own toolbar could write,
// with no scope toggle, no derived readiness, no bulk edit and nowhere to
// publish to. So a complete sales invoice sat in the inbox wearing "New" for
// ever, and the workspace ended in a CSV.
//
// It now mirrors Costs, because it is the same act on the other side of the
// ledger: the same four fields decide Ready (readiness.js, with the
// counterparty called Customer), the same scopes divide what is outstanding
// from the history (rowsFor), the same list view is remembered between visits
// (useListView), and Publish posts the document into the same live Xero — as an
// ACCREC sales invoice rather than an ACCPAY bill, which is the one thing about
// it that differs, and it is decided server-side from the document's own
// workspace.
//
// What it deliberately does NOT mirror is the cost-only machinery: merge
// detection, duplicate review, expense claims, bank matching, payment proofs
// and prepayments are each about money going OUT, and none of them is a
// question you can ask of an invoice you sent.
import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, Search, Filter, ExternalLink } from 'lucide-react';
import AppShell, { AddDocumentsButton } from '@/components/AppShell';
import SalesSubnav from '@/components/SalesSubnav';
import ExtractionProgress, { SALES_FIELDS } from '@/components/ExtractionProgress';
import DocsExportModal from '@/components/DocsExportModal';
import BulkEditModal from '@/components/BulkEditModal';
import DocCardList from '@/components/DocCardList';
import ComboSelect from '@/components/ComboSelect';
import SortTh from '@/components/SortTh';
import ScopeToggle from '@/components/ScopeToggle';
import {
  useCategoryOptions,
  useVisibleTaxRates,
  getExtractionAccounts,
  resolveCategorisationOrgId,
  fetchXeroAccounts,
  fetchXeroTaxRates,
  publishBillToXero,
  useXeroShortCode,
} from '@/lib/organisations';
import { useGstRegistered } from '@/lib/businessProfile';
import { useExtractionSettings, noTaxRateName, publishStatusLabel } from '@/lib/extractionSettings';
import { useReaderName } from '@/lib/readerProvider';
import { reReadDocument } from '@/lib/reRead';
import { accountCodeFromCategory } from '@/data/xeroAccounts';
import { useAuth } from '@/lib/auth';
import { canPublishToXero } from '@/lib/userStore';
import { updateBill, deleteBill, notifyBillsChanged, itemNumber, salesPath } from '@/lib/bills';
import { useSalesDocs, rowsFor, isArchived, needsReview, missingFields } from '@/lib/costsData';
import { isComplete, isPublished, isSetAside } from '@/lib/readiness';
import { docFacts, statesNothing } from '@/lib/mergeDetect';
import { useCategoryDisplayMode, formatCategory } from '@/lib/categoryDisplay';
import { formatDate } from '@/lib/date';
import { xeroBillUrl } from '@/lib/autoPublish';
import { xeroPaidStatus } from '@/lib/xeroPaidStatus';
import { useListView, rememberWalk } from '@/lib/listView';
import { cn } from '@/lib/utils';

// The five tabs the Costs page has, in its order and with its meanings: the
// working list first (processing + inbox, which is exactly the three tabs after
// it added together), then the halves of the inbox, then the settled work.
const TABS = [
  { key: 'all', label: 'Sales' },
  { key: 'processing', label: 'Processing' },
  { key: 'review', label: 'To review' },
  { key: 'ready', label: 'Ready' },
  { key: 'archived', label: 'Archived' },
];

// What a row is sorted by. The article the Sales inbox was specified from says
// "you can sort items by selecting any column heading", and so does the Costs
// table — so every column that holds a comparable value carries one.
const AMOUNT = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
const SORTERS = {
  date: (d) => String(d.date ?? ''),
  user: (d) => String(d.user ?? '').toLowerCase(),
  customer: (d) => String(d.supplier ?? '').toLowerCase(),
  category: (d) => String(d.category ?? '').toLowerCase(),
  ref: (d) => String(d.invoiceNumber ?? itemNumber(d) ?? ''),
  total: (d) => AMOUNT(d.total),
  tax: (d) => AMOUNT(d.tax),
  taxRate: (d) => String(d.taxRate ?? '').toLowerCase(),
};

function sortRows(rows, sort) {
  const read = SORTERS[sort.key];
  if (!read) return rows;
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = read(a);
    const y = read(b);
    if (x < y) return -dir;
    if (x > y) return dir;
    return 0;
  });
}

function ToolbarButton({ children, disabled = false, danger = false, onClick = () => {} }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-3 text-sm transition-colors',
        disabled
          ? 'cursor-not-allowed text-muted-foreground/50'
          : danger
            ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
            : 'hover:bg-muted'
      )}
    >
      {children}
    </button>
  );
}

export default function Sales() {
  const navigate = useNavigate();
  const { allDocs, reload } = useSalesDocs();
  const settings = useExtractionSettings();
  const categoryOptions = useCategoryOptions();
  const taxRates = useVisibleTaxRates();
  const gstRegistered = useGstRegistered();
  const readerName = useReaderName();
  const shortCode = useXeroShortCode();
  const categoryMode = useCategoryDisplayMode();
  const { membership, googleEnabled } = useAuth();
  const mayPublish = canPublishToXero(membership, googleEnabled);
  const noTaxName = noTaxRateName(taxRates);
  const taxRateOptions = gstRegistered ? taxRates.map((t) => t.name) : [noTaxName].filter(Boolean);
  const publishStatus = settings.publishStatus || 'AUTHORISED';

  // Where the reviewer was when they last left. Sales is worked the way Costs
  // is — narrow the list, open what you found, come back for the next — so the
  // tab, the scope, the search and the sort are remembered for the session
  // rather than reset on every "Back".
  const [tab, setTab] = useListView('sales', 'tab', 'all');
  const [scope, setScope] = useListView('sales', 'scope', 'unpublished');
  const [query, setQuery] = useListView('sales', 'query', '');
  const [sort, setSort] = useListView('sales', 'sort', { key: 'date', dir: 'desc' });
  const [selected, setSelected] = useState(() => new Set());
  const [note, setNote] = useState('');
  const [running, setRunning] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // Every tab's rows, so each badge ties to the list behind it — the rule the
  // Costs tab had to be taught after its first badge said 15 over three tabs
  // adding up to 8.
  const rowsByTab = {
    processing: rowsFor(allDocs, 'processing'),
    all: rowsFor(allDocs, scope === 'all' ? 'costs-all' : 'costs'),
    review: rowsFor(allDocs, 'review'),
    ready: rowsFor(allDocs, 'ready'),
    archived: rowsFor(allDocs, scope).filter(isArchived),
  };
  // Each scope counted on the tab it is drawn on, never across the whole book:
  // a count that answered for the other tab is a number the list beside it
  // contradicts.
  const scopeCounts =
    tab === 'archived'
      ? {
          unpublished: rowsFor(allDocs, 'unpublished').filter(isArchived).length,
          all: rowsFor(allDocs, 'all').filter(isArchived).length,
        }
      : {
          unpublished: rowsFor(allDocs, 'costs').length,
          all: rowsFor(allDocs, 'costs-all').length,
        };

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const base = (rowsByTab[tab] ?? []).filter(
      (d) =>
        !q ||
        [d.user, d.supplier, d.category, d.invoiceNumber, itemNumber(d), d.date, d.total].some((v) =>
          String(v ?? '').toLowerCase().includes(q)
        )
    );
    return sortRows(base, sort);
  }, [rowsByTab, tab, q, sort]);

  // Previous / Next on the document page walks the list as it is on screen —
  // filtered, sorted and all — rather than an unfiltered inbox.
  useEffect(() => {
    rememberWalk('sales', rows.map((d) => d.id));
  }, [rows]);

  const byId = new Map(allDocs.map((d) => [d.id, d]));
  const selectedDocs = () => [...selected].map((id) => byId.get(id)).filter(Boolean);
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

  const after = async (message) => {
    notifyBillsChanged();
    await reload();
    setSelected(new Set());
    setRunning('');
    setNote(message);
  };

  // A published document is left alone by every bulk action here, the way the
  // Costs toolbar leaves one alone: its figures are in the ledger, and editing
  // the copy here would only make the two disagree.
  const unpublished = (docs) => docs.filter((d) => !isPublished(d));

  // Archive and Unarchive each move only their own half of the selection, so
  // neither can undo something the other did. Unarchive is deliberately narrow:
  // only a document somebody set aside by hand, never a published one.
  const archiveSelected = async () => {
    const targets = unpublished(selectedDocs()).filter((d) => !isArchived(d));
    if (!targets.length) return;
    setRunning('archive');
    await Promise.all(targets.map((d) => updateBill(d.id, { status: 'archived' }).catch(() => {})));
    await after(`Archived ${targets.length} document${targets.length === 1 ? '' : 's'}.`);
  };
  const unarchiveSelected = async () => {
    const targets = selectedDocs().filter(isSetAside);
    if (!targets.length) return;
    setRunning('unarchive');
    // 'new' rather than 'ready': readiness is derived, so a complete document
    // lands back in Ready by itself and an incomplete one in To review.
    await Promise.all(targets.map((d) => updateBill(d.id, { status: 'new' }).catch(() => {})));
    await after(`Returned ${targets.length} document${targets.length === 1 ? '' : 's'} to the inbox.`);
  };

  const deleteSelected = async () => {
    const targets = selectedDocs();
    if (!targets.length) return;
    if (
      !window.confirm(
        `Delete ${targets.length} document${targets.length === 1 ? '' : 's'}?\n\n` +
          'The stored file goes with them. This cannot be undone.'
      )
    )
      return;
    setRunning('delete');
    await Promise.all(targets.map((d) => deleteBill(d.id).catch(() => {})));
    await after(`Deleted ${targets.length} document${targets.length === 1 ? '' : 's'}.`);
  };

  // Bulk edit: an untouched field is not sent, so "code these forty invoices to
  // Sales" cannot also blank forty customers. Same modal the Costs toolbar
  // opens, same rule.
  const applyBulkEdit = async (patch) => {
    const targets = unpublished(selectedDocs());
    setBulkOpen(false);
    if (!targets.length || !Object.keys(patch).length) return;
    setRunning('bulk');
    await Promise.all(targets.map((d) => updateBill(d.id, patch).catch(() => {})));
    const skipped = selected.size - targets.length;
    await after(
      `Updated ${targets.length} document${targets.length === 1 ? '' : 's'}.` +
        (skipped ? ` ${skipped} already published and left alone.` : '')
    );
  };

  // Read them again. The same precedence a single re-read applies (readDecisions
  // in reRead.js), so the toolbar and the document page cannot drift — and a
  // sales document is re-read AS a sales document, or it would come back naming
  // this business as its own customer.
  const rerunSelected = async () => {
    const targets = unpublished(selectedDocs()).filter((d) => d.hasFile);
    if (!targets.length) {
      setNote('Nothing to read again — a document needs a stored file, and a published one is left alone.');
      return;
    }
    if (!window.confirm(`Read ${targets.length} document${targets.length === 1 ? '' : 's'} again with ${readerName}?`))
      return;
    setRunning('rerun');
    const ctx = {
      accounts: await getExtractionAccounts().catch(() => []),
      taxRates,
      gstRegistered,
      settings,
    };
    let ok = 0;
    let blank = 0;
    for (const d of targets) {
      const outcome = await reReadDocument(d, ctx);
      if (outcome === 'ok') ok += 1;
      else if (outcome === 'blank') blank += 1;
    }
    await after(
      `Read ${ok} document${ok === 1 ? '' : 's'} again.` +
        (blank ? ` ${blank} came back with nothing — that is the file, not the reader.` : '')
    );
  };

  // The whole point of the workspace: the document goes into the live ledger as
  // a SALES INVOICE. Conservative in the same way bulk publish is on Costs — it
  // skips rather than guesses, and the server enforces every gate again.
  const publishSelected = async () => {
    const picked = selectedDocs();
    const already = picked.filter(isPublished).length;
    const targets = picked.filter((d) => !isPublished(d) && isComplete(d));
    const incomplete = picked.length - targets.length - already;
    if (!targets.length) {
      setNote(
        'Nothing to publish — a sales document needs a customer, a date, a revenue category and a total above 0, ' +
          'and must not already be in Xero.'
      );
      return;
    }
    if (
      !window.confirm(
        `Publish ${targets.length} document${targets.length === 1 ? '' : 's'} to Xero as ` +
          `${publishStatusLabel(publishStatus).toLowerCase()} sales invoices?\n\n` +
          'This writes to the live ledger and finishes each document.'
      )
    )
      return;
    setRunning('publish');
    setNote(`Publishing ${targets.length} document${targets.length === 1 ? '' : 's'} to Xero…`);
    const orgId = await resolveCategorisationOrgId().catch(() => '');
    if (!orgId) {
      setRunning('');
      setNote('No Xero organisation is linked, so there is nowhere to publish to.');
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
        failed.push(d.supplier || 'Unknown customer');
        continue;
      }
      try {
        await publishBillToXero(orgId, { billId: d.id, accountCode, taxType, status: publishStatus });
        done += 1;
      } catch {
        failed.push(d.supplier || 'Unknown customer');
      }
    }
    await after(
      `Published ${done} document${done === 1 ? '' : 's'} to Xero as ` +
        `${publishStatusLabel(publishStatus).toLowerCase()} sales invoices.` +
        (failed.length ? ` ${failed.length} could not be published (${failed.slice(0, 3).join(', ')}).` : '') +
        (already ? ` ${already} already published.` : '') +
        (incomplete ? ` ${incomplete} still incomplete.` : '')
    );
  };

  const setCategory = (doc, category) => {
    updateBill(doc.id, { category }).then(notifyBillsChanged).catch(() => {});
  };
  const setTaxRate = (doc, taxRate) => {
    // A code chosen by hand is a person's answer, and the sweeps that run by
    // themselves must not revisit it. Same two markers the Costs cell writes.
    updateBill(doc.id, taxRate
      ? { taxRate, taxRateEdited: true, taxRateCleared: false, taxRateReason: 'Chosen by hand.' }
      : { taxRate: '', taxRateCleared: true, taxRateEdited: false, taxRateReason: 'Left blank by hand.' }
    ).then(notifyBillsChanged).catch(() => {});
  };

  // What a row's state is, in one place, so the phone cards and the table
  // cannot say different things about one document.
  const badgeFor = (d) => {
    if (isPublished(d)) {
      const paid = xeroPaidStatus(d);
      return (
        <span className="inline-flex whitespace-nowrap rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          Published{paid ? ` · ${paid.label}` : ''}
        </span>
      );
    }
    if (d.status === 'processing') {
      return <span className="inline-flex rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Processing</span>;
    }
    if (statesNothing(docFacts(d))) {
      return (
        <span
          title="The reader got nothing off this document. Open it to read it again, or type it in."
          className="inline-flex whitespace-nowrap rounded border border-muted-foreground/30 bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          Nothing read
        </span>
      );
    }
    if (needsReview(d)) {
      return (
        <span
          title="The reader could not fill these in. Open the document and supply them — it moves to Ready by itself once they are there."
          className="inline-flex items-start gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-left text-[11px] font-medium leading-tight text-amber-700"
        >
          Needs: {missingFields(d).join(', ')}
        </span>
      );
    }
    if (isArchived(d)) {
      return <span className="inline-flex rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Archived</span>;
    }
    return (
      <span className="inline-flex rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">Ready</span>
    );
  };

  // The Action column: the next thing that can happen to this document, which
  // on a linked entity is Publish and on an unlinked one is nothing.
  const actionFor = (d) => {
    if (isPublished(d)) {
      const href = xeroBillUrl(d.xeroInvoiceId, shortCode, d.xeroDocType);
      return href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Open in Xero <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      );
    }
    if (!mayPublish) return <span className="text-xs text-muted-foreground">—</span>;
    if (!isComplete(d)) return <span className="text-xs text-muted-foreground">No action</span>;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setSelected(new Set([d.id]));
        }}
        className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
      >
        Publish
      </button>
    );
  };

  return (
    <AppShell subnav={<SalesSubnav />}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Sales</h1>
        <AddDocumentsButton />
      </div>

      <div className="mb-4 flex items-center gap-6 overflow-x-auto border-b">
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
                '-mb-px flex shrink-0 items-center gap-2 border-b-2 pb-3 pt-1 text-sm transition-colors',
                active
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t.label}
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs',
                  active ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'
                )}
              >
                {(rowsByTab[t.key] ?? []).length}
              </span>
            </button>
          );
        })}
      </div>

      {/* Drawn on the two tabs that hold more than one kind of document, as on
          Costs: Sales, where All sales adds the published history a customer is
          filtered across, and Archived, where it says how far the set-aside pile
          reaches. */}
      {(tab === 'all' || tab === 'archived') && (
        <ScopeToggle
          scope={scope}
          setScope={(next) => {
            setScope(next);
            setSelected(new Set());
          }}
          counts={scopeCounts}
          allLabel="All sales"
          label="Which sales documents to show"
        />
      )}

      {tab === 'processing' ? (
        <ProcessingView rows={rowsByTab.processing} />
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-x-visible md:pb-0">
            <ToolbarButton disabled={!hasSelection || running === 'archive'} onClick={archiveSelected}>
              Archive
            </ToolbarButton>
            <ToolbarButton
              disabled={!selectedDocs().some(isSetAside) || running === 'unarchive'}
              onClick={unarchiveSelected}
            >
              Unarchive
            </ToolbarButton>
            <ToolbarButton disabled={!hasSelection} onClick={() => setBulkOpen(true)}>
              Bulk edit
            </ToolbarButton>
            <ToolbarButton disabled={!hasSelection || running === 'rerun'} onClick={rerunSelected}>
              Rerun processing
            </ToolbarButton>
            {mayPublish && (
              <ToolbarButton disabled={!hasSelection || running === 'publish'} onClick={publishSelected}>
                Publish to Xero
              </ToolbarButton>
            )}
            <ToolbarButton onClick={() => setExportOpen(true)}>Export</ToolbarButton>
            <ToolbarButton danger disabled={!hasSelection || running === 'delete'} onClick={deleteSelected}>
              Delete
            </ToolbarButton>
            <div className="relative ml-auto hidden sm:block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="h-8 w-52 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Filter"
            >
              <Filter className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>

          {note && (
            <div className="mb-3 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
              <span>{note}</span>
              <button
                type="button"
                onClick={() => setNote('')}
                className="ml-auto text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Phone: cards. The table below is a thousand pixels wide. */}
          <div className="md:hidden">
            <DocCardList
              rows={rows}
              selected={selected}
              onToggle={toggle}
              onOpen={(d) => navigate(salesPath(d))}
              action={{ icon: Trash2, label: 'Delete', title: 'Delete document', onClick: (d) => {
                setSelected(new Set([d.id]));
              } }}
              badge={badgeFor}
              emptyLabel={q ? 'No documents match.' : 'No documents in this tab.'}
            />
          </div>

          <div className="hidden overflow-x-auto rounded-lg border md:block">
            <table className="w-full min-w-[1080px] text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr className="text-muted-foreground">
                  <th className="sticky left-0 z-10 w-16 bg-muted/40 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selected.size === rows.length}
                      onChange={toggleAll}
                      className="h-4 w-4 accent-black"
                    />
                  </th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-medium">Status</th>
                  <SortTh label="User" sortKey="user" sort={sort} setSort={setSort} />
                  <SortTh label="Date" sortKey="date" sort={sort} setSort={setSort} />
                  <SortTh label="Customer" sortKey="customer" sort={sort} setSort={setSort} />
                  <SortTh label="Category" sortKey="category" sort={sort} setSort={setSort} />
                  <SortTh label="Document reference" sortKey="ref" sort={sort} setSort={setSort} />
                  <SortTh label="Total" sortKey="total" sort={sort} setSort={setSort} align="right" />
                  <SortTh label="Tax" sortKey="tax" sort={sort} setSort={setSort} align="right" />
                  <SortTh label="Tax rate" sortKey="taxRate" sort={sort} setSort={setSort} />
                  <th className="whitespace-nowrap px-3 py-2.5 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() => navigate(salesPath(d))}
                    className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40"
                  >
                    <td className="sticky left-0 z-10 bg-background px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(d.id)}
                        onChange={() => toggle(d.id)}
                        className="h-4 w-4 accent-black"
                      />
                    </td>
                    <td className="px-3 py-3">{badgeFor(d)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{d.user}</td>
                    <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{formatDate(d.date)}</td>
                    <td className="px-3 py-3">{d.supplier || <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      {isPublished(d) ? (
                        <span className="text-muted-foreground">{formatCategory(d.category, categoryMode)}</span>
                      ) : (
                        <ComboSelect
                          size="xs"
                          className="w-44"
                          aria-label="Category"
                          value={d.category}
                          options={categoryOptions}
                          onChange={(v) => setCategory(d, v)}
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-muted-foreground">
                      {d.invoiceNumber || itemNumber(d)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{d.total}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-muted-foreground">{d.tax}</td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      {isPublished(d) ? (
                        <span className="text-muted-foreground">{d.taxRate || '—'}</span>
                      ) : (
                        <ComboSelect
                          size="xs"
                          className="w-40"
                          aria-label="Tax rate"
                          value={d.taxRate}
                          options={taxRateOptions}
                          onChange={(v) => setTaxRate(d, v)}
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">{actionFor(d)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-4 py-16 text-center text-sm text-muted-foreground">
                      {q ? 'No documents match.' : `Nothing in ${TABS.find((t) => t.key === tab)?.label}.`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {rows.length > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing {rows.length} of {rows.length} items
            </p>
          )}
        </>
      )}

      <BulkEditModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onApply={applyBulkEdit}
        count={selected.size}
        publishedCount={selectedDocs().filter(isPublished).length}
        categoryOptions={categoryOptions}
        taxRateOptions={taxRateOptions}
      />
      <DocsExportModal
        open={exportOpen}
        kind="sales"
        rows={hasSelection ? selectedDocs() : rows}
        onClose={() => setExportOpen(false)}
      />
    </AppShell>
  );
}

// Freshly-uploaded documents still being read, with their extraction progress.
// No "Move to inbox" button: readiness is derived, so a document leaves this
// tab the moment its read lands — a button here could only ever agree with the
// server or be overruled by it a moment later.
function ProcessingView({ rows }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="border-b bg-muted/40 text-left">
          <tr className="text-muted-foreground">
            <th className="px-3 py-2.5 font-medium">Item ID</th>
            <th className="px-3 py-2.5 font-medium">User</th>
            <th className="px-3 py-2.5 font-medium">File name</th>
            <th className="px-3 py-2.5 font-medium">Submission method</th>
            <th className="px-3 py-2.5 font-medium">Extraction process</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="border-b last:border-0">
              <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-muted-foreground">{itemNumber(d)}</td>
              <td className="whitespace-nowrap px-3 py-3">{d.user}</td>
              <td className="px-3 py-3">{d.fileName || '—'}</td>
              <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">Via web</td>
              <td className="px-3 py-3">
                <ExtractionProgress doc={d} fieldSet={SALES_FIELDS} />
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-16 text-center text-sm text-muted-foreground">
                Nothing is processing.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
