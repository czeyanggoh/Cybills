import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Search,
  Plus,
  FileText,
  X,
  Lock,
  Info,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import ClaimExportModal from '@/components/ClaimExportModal';
import ClaimEmailModal from '@/components/ClaimEmailModal';
import ClaimApprovalModal from '@/components/ClaimApprovalModal';
import FlagMenu from '@/components/FlagMenu';
import ReceiptViewer from '@/components/ReceiptViewer';
import AddDocumentsDrawer from '@/components/AddDocumentsDrawer';
import TableSettingsMenu from '@/components/TableSettingsMenu';
import {
  useClaimsState,
  whereIsClaim,
  submitForApproval,
  approveClaim,
  rejectClaim,
  createClaim,
  removeItemsFromClaim,
  addItemToClaim,
  docToClaimTxn,
  updateClaimItems,
  moveItemsToClaim,
  notifyClaimsChanged,
  updateClaim,
  archiveClaims,
  deleteClaims,
  formatClaimDate,
  formatClaimStamp,
  toIsoClaimDate,
} from '@/lib/claimStore';
import { costPath, billToDoc, updateBill, notifyBillsChanged } from '@/lib/bills';
import { useUsers, canManageUsers } from '@/lib/userStore';
import { useAuth } from '@/lib/auth';
import { useOrganisations, getActiveOrganisationId, switchOrganisationTo, publishClaimToXero } from '@/lib/organisations';
import { useExtractionSettings, publishStatusLabel } from '@/lib/extractionSettings';
import { xeroBillUrl } from '@/lib/autoPublish';
import { CATEGORIES } from '@/data/categories';
import { generateClaimPdf, buildClaimPdfBase64 } from '@/lib/claimPdf';
import { claimDateFor } from '@/lib/claimReference';
import { claimExportName, claimRef } from '@/lib/exportFormat';
import { useCategoryDisplayMode, useCategorySortMode, sortCategories, formatCategory } from '@/lib/categoryDisplay';
import { CLAIM_COLUMNS, DENSITY_CLASS, useTablePrefs } from '@/lib/tablePrefs';
import DocCardList from '@/components/DocCardList';
import SearchSelect from '@/components/SearchSelect';
import { useClaimantNames } from '@/lib/userStore';
import { missingFields } from '@/lib/readiness';
import { cn } from '@/lib/utils';
import { xeroPaidStatus } from '@/lib/xeroPaidStatus';
import ComboSelect from '@/components/ComboSelect';
import SortTh, { sortRows } from '@/components/SortTh';

function TopButton({ children, onClick = () => {}, subtle = false, danger = false, dropdown = false, disabled = false, title = '' }) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-3 text-sm transition-colors',
        disabled ? 'cursor-not-allowed text-muted-foreground/60' : 'hover:bg-muted',
        subtle && 'border-transparent',
        danger && !disabled && 'border-transparent text-destructive hover:bg-destructive/10'
      )}
    >
      {children}
      {dropdown && <ChevronDown className="h-3.5 w-3.5" />}
    </button>
  );
}

function DetailField({ label, children }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="w-32 shrink-0 pt-2 text-sm text-muted-foreground">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// A field that either saves what is typed or says it can't be typed in.
//
// It used to render an UNCONTROLLED input with no onChange for anything not
// marked read-only — so Claim for, Claim name and the description accepted
// typing, kept it on screen, and threw it away on the next refresh. A field
// that looks editable and isn't is worse than a disabled one: it invites the
// edit and then loses it silently.
//
// `onCommit` fires on blur and on Enter rather than per keystroke: each save is
// a request, and this is a text field, not a toggle.
function Input({ value, readOnly = false, disabled = false, title = '', onCommit }) {
  const common = cn(
    'h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
    readOnly || disabled ? 'bg-muted text-muted-foreground' : 'bg-background',
    disabled && 'cursor-not-allowed'
  );
  if (readOnly || disabled || !onCommit) {
    return <input value={value ?? ''} readOnly disabled={disabled} title={title} className={common} />;
  }
  const commit = (e) => {
    const next = e.target.value;
    if (next !== (value ?? '')) onCommit(next);
  };
  return (
    <input
      key={value}
      defaultValue={value ?? ''}
      title={title}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className={common}
    />
  );
}

function CategorySelect({ value, onChange }) {
  const mode = useCategoryDisplayMode();
  const sort = useCategorySortMode();
  // 'Uncategorised' pinned first; the rest follow the chosen order.
  const options = ['Uncategorised', ...sortCategories(CATEGORIES.filter((c) => c !== 'Uncategorised'), sort)];
  return (
    <ComboSelect
      size="xs"
      className="w-40"
      aria-label="Category"
      value={value}
      options={options}
      onChange={onChange}
      format={(c) => formatCategory(c, mode)}
    />
  );
}

export default function ExpenseClaimDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, membership, googleEnabled } = useAuth();
  const { claims, loaded } = useClaimsState();
  const claim = claims.find((c) => String(c.id) === String(id)) || null;
  // Where a claim lives when it isn't in this entity's list: null = not asked
  // yet, false = there is no such claim (for this person), else the entity.
  const [elsewhere, setElsewhere] = useState(null);
  useEffect(() => {
    if (!loaded || claim) { setElsewhere(null); return; }
    let alive = true;
    whereIsClaim(id).then((r) => { if (alive) setElsewhere(r || false); });
    return () => { alive = false; };
  }, [loaded, claim, id]);
  const [tab, setTab] = useState('details');
  const [catOverrides, setCatOverrides] = useState({});
  const [selected, setSelected] = useState(() => new Set());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [bulkCatOpen, setBulkCatOpen] = useState(false);
  const [bulkCat, setBulkCat] = useState('');
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState('');
  const [moveNewName, setMoveNewName] = useState('');
  const [query, setQuery] = useState('');
  // Which column the items table is ordered by, and which way. Above the early
  // return below, because a hook has to run on every render.
  const [sort, setSort] = useState({ key: '', dir: 'asc' });
  const [exportMenu, setExportMenu] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const users = useUsers();
  const { data: organisations = [] } = useOrganisations();
  // The same people the New-claim dialog offers: an entity's own staff, plus the
  // practice's own team when this IS the practice's entity.
  const activeOrgForClaim = organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0];
  const claimantOptions = useClaimantNames({ ownEntity: Boolean(activeOrgForClaim?.isPrimary) });
  const [payNote, setPayNote] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Which columns this table shows and how tightly it packs them — the gear
  // beside the search box, the same preference store as the Costs table.
  // Declared up here with the other hooks: it has to run before the
  // "claim not found" early return below.
  const tablePrefs = useTablePrefs('claimItems');
  const densityClass = DENSITY_CLASS[tablePrefs.density] ?? DENSITY_CLASS.Medium;

  // Keep the selection in sync with what actually exists: when items are removed
  // (here or in another tab) drop their ids so the count never counts phantoms.
  const txnKey = (claim?.transactions || []).map((t) => String(t.itemId)).join(',');
  useEffect(() => {
    const valid = new Set((claim?.transactions || []).map((t) => String(t.itemId)));
    setSelected((prev) => {
      const next = new Set([...prev].filter((itemId) => valid.has(String(itemId))));
      return next.size === prev.size ? prev : next;
    });
  }, [txnKey]);

  // Post the approved claim to Xero as an ACCPAY bill payable to the employee,
  // at whatever status this entity publishes at (Business settings → Extraction
  // → Publishing). Approved by default: a claim reaching here has already been
  // approved HERE, and a bill has to be approved in Xero before it can be paid.
  const publishStatus = useExtractionSettings().publishStatus || 'AUTHORISED';
  const publishXero = async () => {
    setPayNote('');
    const active = getActiveOrganisationId();
    const orgId = organisations.find((o) => o.id === active)?.id || organisations[0]?.id || '';
    if (!orgId) {
      setPayNote('No Xero organisation is linked. Connect one in the organisation switcher first.');
      return;
    }
    setPublishing(true);
    try {
      // Render the claim PDF and send it along so it's attached to the Xero bill.
      const pdfBase64 = await buildClaimPdfBase64(claim);
      const r = await publishClaimToXero(orgId, {
        claimId: claim.id,
        status: publishStatus,
        pdfBase64,
        pdfName: claimExportName(claim, 'pdf'),
      });
      notifyClaimsChanged(); // refresh so the button flips to "Published to Xero"
      const attachNote = r.attachment && r.attachment.ok === false ? ' (PDF attachment couldn’t be sent — see Xero)' : '';
      setPayNote(`Posted to ${r.claim?.xeroTenantName || 'Xero'} as a ${publishStatusLabel(publishStatus).toLowerCase()} bill${r.invoice?.invoiceNumber ? ` (${r.invoice.invoiceNumber})` : ''}.${attachNote}`);
    } catch (err) {
      setPayNote(err?.message || 'Could not publish the claim to Xero.');
    } finally {
      setPublishing(false);
    }
  };

  const index = claims.findIndex((c) => String(c.id) === String(id));
  const go = (delta) => {
    const next = claims[index + delta];
    if (next) navigate(`/expense-claims/${next.id}`);
  };

  if (!claim) {
    // Claims are scoped to one client entity, and a claim's URL is exactly the
    // kind of link that gets emailed for approval or bookmarked — so arriving
    // here from the wrong entity is ordinary, and "not found" was both wrong
    // and a dead end. Say where it is and offer to go there.
    return (
      <AppShell subnav={<CostsSubnav />}>
        {!loaded || elsewhere === null ? (
          <p className="text-sm text-muted-foreground">Loading expense claim…</p>
        ) : elsewhere ? (
          <div className="max-w-lg rounded-lg border p-5">
            <h1 className="text-base font-semibold tracking-tight">
              This claim belongs to {elsewhere.orgName || 'another client entity'}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {elsewhere.claimFor ? `${elsewhere.claimFor}’s ` : ''}
              {elsewhere.name || 'expense claim'} is in a different entity&rsquo;s book, so it isn&rsquo;t in the
              list you are looking at. Switch to open it.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                // Reload into the new entity rather than re-render: the header,
                // the subnav counts and every request in flight are scoped to
                // the entity being left behind.
                onClick={() => switchOrganisationTo(elsewhere.orgId, `/expense-claims/${id}`)}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Switch to {elsewhere.orgName || 'that entity'}
              </button>
              <button
                type="button"
                onClick={() => navigate('/expense-claims')}
                className="inline-flex h-9 items-center rounded-md border px-4 text-sm transition-colors hover:bg-muted"
              >
                Back to expense claims
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Expense claim not found.</p>
        )}
      </AppShell>
    );
  }

  // Only an APPROVED claim is locked from item edits — its total must not drift
  // once it has been approved and is on its way to being paid. A claim merely
  // awaiting approval stays editable: that's exactly when a wrongly-added
  // receipt gets spotted, and taking it back out beats deleting the whole claim.
  // The approver is told the total changed and re-reviews.
  const locked = claim.approvalStatus === 'approved';
  const submitted = claim.approvalStatus === 'awaiting_approval';

  // Publish to Xero, in every state. An unapproved claim can't post — a claim
  // is a bill payable to an employee, and approval is the thing that says the
  // company owes it, so the server refuses one outright. Rather than hide the
  // button until then (which reads as the feature being missing), it is shown
  // disabled and says what it is waiting for.
  // Once it is in Xero, "Published" stops being the interesting fact. What the
  // claimant wants to know is whether the money has left — so the chip carries
  // Xero's own answer as soon as there is one, and falls back to "Published to
  // Xero" while the ledger has said nothing yet.
  const claimPaid = xeroPaidStatus(claim);
  // Once it is in Xero the chip states a fact about a bill that EXISTS, and the
  // next thing anybody wants is that bill — the cost page has carried "Open in
  // Xero" all along, while the claim's twin was a dead label somebody had to go
  // and find the bill for by hand. Same chip, same wording, now a link: the
  // status stays the label because "Reimbursed 25 Aug" is what the claimant is
  // waiting to read, and the arrow says it opens elsewhere.
  const publishBtn = claim.xeroInvoiceId ? (
    <a
      href={xeroBillUrl(claim.xeroInvoiceId)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
        claimPaid?.tone === 'paid'
          ? 'border-green-600/40 bg-green-600/10 text-green-700 hover:bg-green-600/20'
          : 'border-foreground/40 text-foreground hover:bg-muted'
      )}
      title={
        claimPaid?.tone === 'paid'
          ? `Paid in ${claim.xeroTenantName || 'Xero'}${claim.xeroPaidDate ? ` on ${formatClaimDate(claim.xeroPaidDate)}` : ''}${claim.xeroPaymentRef ? ` · ${claim.xeroPaymentRef}` : ''} — open the bill`
          : `Open this claim's bill in ${claim.xeroTenantName || 'Xero'}`
      }
    >
      <CheckCircle2 className="h-4 w-4" />
      {claimPaid?.tone === 'paid'
        ? `Reimbursed${claim.xeroPaidDate ? ` ${formatClaimDate(claim.xeroPaidDate)}` : ''}`
        : claimPaid && claimPaid.tone !== 'awaiting'
          ? claimPaid.label
          : 'Published to Xero'}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  ) : (
    <TopButton
      disabled={!locked || publishing}
      title={
        locked
          ? 'Post this claim to Xero as a draft bill payable to the employee'
          : submitted
            ? 'Waiting on the approver — an approved claim can be published to Xero'
            : 'Submit this claim for approval first — only an approved claim can be published to Xero'
      }
      onClick={publishXero}
    >
      {publishing ? 'Publishing…' : 'Publish to Xero'}
    </TopButton>
  );

  // Apply any in-session category tweaks on top of the stored line items, then
  // filter by the search box (supplier / category / date / description / id).
  const q = query.trim().toLowerCase();
  const rows = claim.transactions
    .map((t) => (catOverrides[t.itemId] ? { ...t, category: catOverrides[t.itemId] } : t))
    .filter(
      (t) =>
        !q ||
        [t.supplier, t.category, t.date, t.description, t.displayId, t.itemId].some((v) =>
          String(v || '').toLowerCase().includes(q)
        )
    );
  // Show the most recently added item on top (transactions are stored in add
  // order). Only the on-screen table is reversed; the PDF stays chronological.
  // Newest first by default — transactions are stored in add order, and the
  // line somebody just added is the one they are looking for. A chosen sort
  // replaces that; the PDF stays chronological either way.
  const displayRows = sort.key
    ? sortRows(rows, sort, {
        fields: { itemId: 'displayId' },
        numeric: ['net', 'tax', 'total'],
        dates: ['date'],
      })
    : [...rows].reverse();
  const setRowCategory = (itemId, category) => {
    if (locked) return;
    setCatOverrides((o) => ({ ...o, [itemId]: category })); // optimistic
    updateClaimItems(claim.id, [itemId], { category }).catch(() => {}); // persist
  };

  // Take one item off the claim. The document isn't deleted — it goes back to
  // the Costs inbox (removeItemsFromClaim resets its status), so it can be
  // re-filed, put on another claim, or published on its own.
  const removeItem = (t) => {
    if (!window.confirm(`Remove this item from the claim?\n\n${t.supplier || 'The document'} goes to your Archive — it isn't deleted.`)) return;
    removeItemsFromClaim(claim.id, [t.itemId]).catch(() => {});
    setSelected((sel) => {
      const n = new Set(sel);
      n.delete(t.itemId);
      return n;
    });
  };

  // How each toggleable column renders. `stopClick` keeps a cell's own controls
  // from opening the document; the amounts are right-aligned as in the PDF.
  const money = 'whitespace-nowrap text-right tabular-nums';
  const CELLS = {
    supplier: { cellClass: 'whitespace-nowrap', cell: (t) => t.supplier },
    date: { cellClass: 'whitespace-nowrap tabular-nums text-muted-foreground', cell: (t) => t.date },
    category: {
      stopClick: true,
      cell: (t) =>
        locked ? (
          <span className="text-muted-foreground">{t.category}</span>
        ) : (
          <CategorySelect value={t.category} onChange={(v) => setRowCategory(t.itemId, v)} />
        ),
    },
    description: {
      cellClass: 'max-w-[16rem] truncate text-muted-foreground',
      title: (t) => t.description || '',
      cell: (t) => t.description || '—',
    },
    net: { head: `Net (${claim.currency})`, headClass: 'text-right', cellClass: money, cell: (t) => t.net },
    tax: { head: `Tax (${claim.currency})`, headClass: 'text-right', cellClass: money, cell: (t) => t.tax },
    total: { head: `Total (${claim.currency})`, headClass: 'text-right', cellClass: cn(money, 'font-medium'), cell: (t) => t.total },
    itemId: { cellClass: 'whitespace-nowrap tabular-nums text-muted-foreground', cell: (t) => t.displayId || t.itemId },
    user: { cellClass: 'whitespace-nowrap text-muted-foreground', cell: (t) => t.addedBy || '—' },
    project: { cellClass: 'whitespace-nowrap text-muted-foreground', cell: (t) => t.project || '—' },
  };
  const shownColumns = CLAIM_COLUMNS.filter((c) => !c.fixed && tablePrefs.columns[c.key] && CELLS[c.key]);

  // ── Item selection + bulk actions (Dext-style) ──────────────────────────────
  const toggleItem = (itemId) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(itemId)) n.delete(itemId);
      else n.add(itemId);
      return n;
    });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.itemId));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.itemId)));

  const doRemove = async () => {
    if (!selected.size) return;
    if (!window.confirm(`Remove ${selected.size} item${selected.size === 1 ? '' : 's'} from this claim?\n\nThey go to your Archive — they aren't deleted.`)) return;
    setActionsOpen(false);
    await removeItemsFromClaim(claim.id, [...selected]).catch(() => {});
    setSelected(new Set());
  };

  const doBulkCategory = async () => {
    if (!bulkCat || !selected.size) return;
    await updateClaimItems(claim.id, [...selected], { category: bulkCat }).catch(() => {});
    setBulkCatOpen(false);
    setBulkCat('');
    setSelected(new Set());
  };

  const doMove = async () => {
    const txns = rows.filter((r) => selected.has(r.itemId));
    if (!txns.length) return;
    let targetId = moveTarget;
    if (moveTarget === 'new') {
      const created = await createClaim({ claimFor: claim.claimFor, name: moveNewName.trim() || 'Expense claim', endDate: claim.endDate });
      targetId = created?.id;
    }
    if (!targetId || targetId === claim.id) return;
    await moveItemsToClaim(claim.id, targetId, txns).catch(() => {});
    setMoveOpen(false);
    setMoveTarget('');
    setMoveNewName('');
    setSelected(new Set());
  };

  const otherClaims = claims.filter((c) => c.id !== claim.id && !c.archived && !c.deleted);

  // Only the assigned approver may approve/reject (enforced server-side too).
  // When no specific approver is set, the decision falls to a Business/User
  // Admin — but never the claimant approving their own claim (mirrors the
  // server's ensureApprover rule).
  const meEmail = (user?.email || '').toLowerCase();
  const meName = (user?.name || '').toLowerCase();
  const iAmClaimant = Boolean(meName && claim.claimFor && claim.claimFor.toLowerCase() === meName);
  const iAmAdmin = canManageUsers(membership, googleEnabled);
  const iAmApprover =
    (claim.approverEmail && meEmail && claim.approverEmail.toLowerCase() === meEmail) ||
    (claim.approver && meName && claim.approver.toLowerCase() === meName) ||
    (!claim.approverEmail && !claim.approver && iAmAdmin && !iAmClaimant);
  const decide = async (fn) => {
    setPayNote('');
    try {
      await fn(claim.id);
    } catch (e) {
      setPayNote(
        e.code === 'not_approver'
          ? `Only ${claim.approver || 'the assigned approver'} can approve this claim.`
          : 'Could not update the claim.'
      );
    }
  };

  // A document uploaded from this page goes onto THIS claim rather than into the
  // Costs inbox for somebody to find and add — which is what "Add items" used to
  // mean, and the round trip was the whole of the complaint. The drawer hands
  // each document over the moment its read finishes, so the rows appear one by
  // one while the rest are still being read.
  //
  // Two writes, in this order: the claim line first, the document's status
  // second. The other way round, a failure would leave a document marked as
  // claimed with no claim carrying it — invisible in the inbox, invisible here,
  // which is the exact state removing an item from a claim used to leave behind.
  const addUploadedToClaim = async (bill) => {
    if (!bill?.id || !claim?.id) return;
    const doc = billToDoc(bill);
    try {
      await addItemToClaim(claim.id, docToClaimTxn(doc, doc, user?.name || user?.email || 'You'));
    } catch (err) {
      setPayNote(
        err?.code === 'claim_locked'
          ? 'That claim is already approved, so the document was left in the Costs inbox.'
          : `Could not add ${doc.supplier || 'the document'} to this claim — it is in the Costs inbox.`
      );
      return;
    }
    await updateBill(bill.id, { status: 'expenseclaim' }).catch(() => {});
    notifyBillsChanged();
  };

  return (
    <AppShell subnav={<CostsSubnav />}>
      {payNote && (
        <div className="mb-3 flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-sm text-foreground">
          {payNote}
          <button type="button" onClick={() => setPayNote('')} className="ml-auto text-muted-foreground hover:text-foreground">Dismiss</button>
        </div>
      )}
      {claim.approvalStatus === 'rejected' && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          This claim was rejected{claim.decidedBy ? ` by ${claim.decidedBy}` : ''}.
          {claim.decisionReason ? <> <span className="font-medium">Reason:</span> {claim.decisionReason}</> : ' No reason was given.'}
          {' '}Edit the items and re-submit for approval.
        </div>
      )}
      {/* Publishing a claim posts a bill payable to the employee, so it waits for
          the approval — the server refuses an unapproved claim outright. It is
          shown in every state anyway, disabled and saying why: a button that
          simply isn't there reads as a missing feature, which is exactly how it
          was reported. */}
      {/* Action bar */}
      {/* One scrolling row on a phone rather than four wrapped ones. */}
      <div className="mb-4 flex items-center gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-x-visible md:pb-0">
        <TopButton subtle onClick={() => navigate('/expense-claims')}>
          <ChevronLeft className="h-4 w-4" /> Back
        </TopButton>
        <span className="mx-1"><FlagMenu id={claim.id} size="lg" /></span>
        {claim.approvalStatus === 'awaiting_approval' ? (
          <>
            <span className="inline-flex h-8 items-center rounded-md border border-dashed border-foreground px-3 text-sm">
              Awaiting approval{claim.approver ? ` · ${claim.approver}` : ''}
            </span>
            {iAmApprover ? (
              <>
                <TopButton onClick={() => decide(approveClaim)}>Approve</TopButton>
                <TopButton danger onClick={() => { setRejectReason(''); setRejectOpen(true); }}>Reject</TopButton>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">Only {claim.approver || 'the approver'} can approve</span>
            )}
          </>
        ) : claim.approvalStatus === 'approved' ? (
          <>
            <span className="inline-flex h-8 items-center gap-1 rounded-md bg-foreground px-3 text-sm font-medium text-background">
              Approved{claim.decidedBy ? ` by ${claim.decidedBy}` : ''}
            </span>
          </>
        ) : claim.approvalStatus === 'rejected' ? (
          <>
            <span
              className="inline-flex h-8 items-center rounded-md border border-destructive px-3 text-sm text-destructive"
              title={claim.decisionReason ? `Reason: ${claim.decisionReason}` : undefined}
            >
              Rejected{claim.decidedBy ? ` by ${claim.decidedBy}` : ''}
            </span>
            <TopButton onClick={() => setApprovalOpen(true)}>Re-submit for approval</TopButton>
          </>
        ) : (
          <TopButton onClick={() => setApprovalOpen(true)}>Submit for approval</TopButton>
        )}
        {publishBtn}
        <TopButton onClick={async () => { await archiveClaims([claim.id], true).catch(() => {}); navigate('/expense-claims'); }}>Archive</TopButton>
        <div className="relative">
          <TopButton onClick={() => setExportMenu((o) => !o)} dropdown>Export</TopButton>
          {exportMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setExportMenu(false)} aria-hidden="true" />
              <div className="absolute left-0 z-20 mt-1 w-44 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
                <button
                  type="button"
                  onClick={() => { setExportMenu(false); setExportOpen(true); }}
                  className="flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                >
                  Export
                </button>
                <button
                  type="button"
                  onClick={() => { setExportMenu(false); setEmailOpen(true); }}
                  className="flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                >
                  Send by email
                </button>
              </div>
            </>
          )}
        </div>
        <TopButton danger onClick={async () => {
          // Says what it destroys. This deletes the RECEIPTS as well as the
          // claim — and their stored files — so the count is spelled out rather
          // than left as "its items".
          const n = (claim.transactions || []).length;
          if (
            !window.confirm(
              `Delete this expense claim?\n\nThe ${n} receipt${n === 1 ? '' : 's'} on it will be permanently deleted, including the stored file${n === 1 ? '' : 's'}. This cannot be undone.\n\nTo keep a receipt, remove it from the claim first — that sends it to Archive.`
            )
          )
            return;
          await deleteClaims([claim.id]).catch(() => {});
          navigate('/expense-claims');
        }}>Delete claim</TopButton>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={index <= 0}
            className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="tabular-nums text-muted-foreground">
            {index >= 0 ? index + 1 : '–'} / {claims.length}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={index >= claims.length - 1}
            className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        {/* Left: claim + line items */}
        <div className="min-w-0 rounded-lg border p-4 sm:p-5">
          {/* The title and the PDF button shared a row, which on a phone squeezed
              "Sefi Krishberg's Expense Claim" into three lines beside a button.
              They stack until there is room for both. */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight sm:text-xl">{claim.claimFor}&rsquo;s Expense Claim</h1>
              {/* Label above value on a phone: run inline, "Expense total SGD
                  412.40 ( Incl. Tax: 31.60 )" wrapped across three lines with
                  the label stranded on the first. */}
              <dl className="mt-3 space-y-2 text-sm sm:space-y-1">
                {[
                  ['Claim name', claim.name],
                  // Derived, not stored: a claim with no date of its own reads
                  // as the latest date among its items, which is the date the
                  // bill will carry when it publishes.
                  ['Claim date', formatClaimDate(claimDateFor(claim))],
                  ['Expense total', `${claim.currency} ${claim.total} ( Incl. Tax: ${claim.tax} )`],
                ].map(([label, value]) => (
                  <div key={label} className="sm:flex sm:items-baseline sm:gap-2">
                    <dt className="text-xs text-muted-foreground sm:text-sm">{label}</dt>
                    <dd className="break-words font-medium">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <button
              type="button"
              onClick={() => { void generateClaimPdf({ ...claim, transactions: rows }, { detailLevel: 'summary' }); }}
              className="inline-flex h-9 shrink-0 items-center justify-center gap-2 self-start rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              <FileText className="h-4 w-4" strokeWidth={1.75} />
              PDF preview
            </button>
          </div>

          {/* Line-item toolbar */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {locked && (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-3 text-xs text-muted-foreground">
                <Lock className="h-3.5 w-3.5" />
                Approved — items are locked
              </span>
            )}
            {submitted && (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-3 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5" />
                Awaiting approval — a change sends it back to {claim.approver || 'the approver'} to re-review
              </span>
            )}
            {!locked && (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              title="Upload receipts straight onto this claim"
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" /> Add items
            </button>
            )}
            {!locked && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setActionsOpen((o) => !o)}
                className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors hover:bg-muted"
              >
                Actions
                {selected.size > 0 && (
                  <span className="ml-0.5 rounded bg-foreground px-1.5 text-xs text-background">{selected.size}</span>
                )}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {actionsOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setActionsOpen(false)} aria-hidden="true" />
                  <div className="absolute left-0 z-20 mt-1 w-52 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
                    {selected.size === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">Tick one or more items on the left, then choose an action.</p>
                    ) : (
                      <>
                        <p className="px-3 py-1.5 text-xs text-muted-foreground">{selected.size} item{selected.size === 1 ? '' : 's'} selected</p>
                        <button type="button" onClick={() => { setActionsOpen(false); setBulkCat(''); setBulkCatOpen(true); }} className="flex w-full px-3 py-2 text-left text-sm hover:bg-muted">Bulk edit</button>
                        <button type="button" onClick={() => { setActionsOpen(false); setMoveTarget(''); setMoveOpen(true); }} className="flex w-full px-3 py-2 text-left text-sm hover:bg-muted">Move</button>
                        <button type="button" onClick={doRemove} className="flex w-full px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10">Remove</button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            )}
            <div className="relative ml-auto hidden sm:block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-8 w-44 rounded-md border bg-background pl-8 pr-16 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
              <button type="button" className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
                Advanced <ChevronDown className="h-3 w-3" />
              </button>
            </div>
            <TableSettingsMenu table="claimItems" columns={CLAIM_COLUMNS} />
          </div>

          {/* Line items */}
          {/* Phone: cards, same as the Costs inbox. A claim's line items are cost
              documents, so they read the same way — supplier and amount first,
              date and account under them. */}
          <div className="md:hidden">
            <DocCardList
              rows={displayRows.map((t) => ({
                // The card keys off `id`; a claim line calls it `itemId`.
                id: t.itemId,
                supplier: t.supplier,
                date: t.date,
                category: t.category,
                total: t.total,
                tax: t.tax,
                currency: claim.currency,
              }))}
              selected={selected}
              onToggle={locked ? () => {} : toggleItem}
              onOpen={(d) => navigate(costPath(d.id))}
              action={
                locked
                  ? null
                  : {
                      icon: X,
                      label: 'Remove from claim',
                      title: 'Remove from this claim — the document goes back to your Costs inbox',
                      onClick: (d) => removeItem(displayRows.find((t) => t.itemId === d.id)),
                    }
              }
              emptyLabel={q ? 'No items match your search.' : 'No items in this claim yet.'}
            />
            {displayRows.length > 0 && (
              <div className="mt-2 flex items-center justify-end gap-4 rounded-lg border bg-muted/20 px-3 py-3 text-sm">
                <span className="font-medium">Expense total</span>
                <span className="font-semibold tabular-nums">{claim.currency} {claim.total}</span>
              </div>
            )}
          </div>

          <div className="hidden overflow-x-auto rounded-lg border md:block">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr className="text-muted-foreground">
                  <th className="w-28 px-3 py-2.5">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={locked} className="h-4 w-4 accent-black disabled:opacity-40" aria-label="Select all" />
                  </th>
                  {shownColumns.map((c) => (
                    <SortTh
                      key={c.key}
                      label={CELLS[c.key].head ?? c.label}
                      sortKey={c.key}
                      sort={sort}
                      setSort={setSort}
                      align={CELLS[c.key].headClass?.includes('text-right') ? 'right' : 'left'}
                      className={CELLS[c.key].headClass}
                    />
                  ))}
                  <th className="w-10 px-2 py-2.5"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((t) => (
                  <tr
                    key={t.itemId}
                    onClick={() => navigate(costPath(t.itemId))}
                    className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40"
                  >
                    <td className={densityClass} onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        <input type="checkbox" checked={selected.has(t.itemId)} onChange={() => toggleItem(t.itemId)} disabled={locked} className="h-4 w-4 accent-black disabled:opacity-40" />
                        <FlagMenu id={t.itemId} />
                        <ReceiptViewer itemIds={t.itemId} />
                        {/* Derived, not decorative. This badge was the literal
                            word "Ready" on every row whatever the document
                            said — so an item with no date sat under a green
                            light while the approver decided. Same rule the
                            inbox uses, so the two can't disagree. */}
                        {missingFields(t).length ? (
                          <span
                            title={`Needs: ${missingFields(t).join(', ')}`}
                            className="rounded border border-amber-600/40 bg-amber-50 px-2 py-0.5 text-xs text-amber-800"
                          >
                            Needs: {missingFields(t).join(', ')}
                          </span>
                        ) : (
                          <span className="rounded bg-foreground px-2 py-0.5 text-xs text-background">Ready</span>
                        )}
                      </div>
                    </td>
                    {shownColumns.map((c) => {
                      const cell = CELLS[c.key];
                      return (
                        <td
                          key={c.key}
                          className={cn(densityClass, cell.cellClass)}
                          title={cell.title?.(t) || undefined}
                          onClick={cell.stopClick ? (e) => e.stopPropagation() : undefined}
                        >
                          {cell.cell(t)}
                        </td>
                      );
                    })}
                    <td className="px-2 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                      {!locked && (
                        <button
                          type="button"
                          onClick={() => removeItem(t)}
                          title="Remove from this claim — the document goes back to your Costs inbox"
                          aria-label="Remove from claim"
                          className="text-muted-foreground transition-colors hover:text-destructive"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={shownColumns.length + 2} className="px-4 py-12 text-center text-sm text-muted-foreground">
                      {q ? 'No items match your search.' : 'No items in this claim yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                {/* One spanning cell rather than a per-column layout: the total
                    stays put however many columns the gear leaves showing. */}
                <tr className="border-t bg-muted/20">
                  <td colSpan={shownColumns.length + 2} className="px-3 py-3 text-sm">
                    <div className="flex items-center justify-end gap-6">
                      <span className="font-medium">Expense total</span>
                      <span className="font-semibold tabular-nums">{claim.currency} {claim.total}</span>
                    </div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Showing {rows.length} of {claim.transactions.length} items
          </p>
        </div>

        {/* Right: claim details / history */}
        <div>
          <div className="mb-4 flex gap-6 border-b">
            {[
              { key: 'details', label: 'Claim details' },
              { key: 'history', label: 'History' },
            ].map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  '-mb-px border-b-2 pb-3 pt-1 text-sm transition-colors',
                  tab === t.key
                    ? 'border-foreground font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'details' ? (
            <div>
              <DetailField label="Claim ID"><Input value={claimRef(claim)} readOnly /></DetailField>
              {/* A PICKER, not free text. The claimant's name is not a label —
                  it is matched to a person to find the approver this claim
                  routes to, and to notify them of the decision. "cze yang"
                  typed by hand matches nobody, so the claim would simply stop
                  being submittable with nothing saying why.
                  Locked once it is out for approval: changing who is being paid
                  after somebody has been asked to approve it reroutes the claim
                  underneath them. */}
              <DetailField label="Claim for">
                {locked || submitted ? (
                  <Input
                    value={claim.claimFor}
                    disabled
                    title={locked ? 'Approved — the claimant can no longer be changed.' : 'Out for approval — recall or reject it first to change the claimant.'}
                  />
                ) : (
                  <SearchSelect
                    value={claim.claimFor || ''}
                    options={claimantOptions}
                    placeholder="Select a person"
                    onChange={(v) => updateClaim(claim.id, { claimFor: v }).catch(() => {})}
                  />
                )}
              </DetailField>
              <DetailField label="Claim name">
                <Input
                  value={claim.name}
                  disabled={locked}
                  title={locked ? 'Approved — the claim can no longer be renamed.' : ''}
                  onCommit={(v) => updateClaim(claim.id, { name: v }).catch(() => {})}
                />
              </DetailField>
              <DetailField label="End date">
                <input
                  type="date"
                  value={toIsoClaimDate(claim.endDate)}
                  disabled={claim.approvalStatus === 'approved'}
                  onChange={(e) => updateClaim(claim.id, { endDate: e.target.value }).catch(() => {})}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                />
              </DetailField>
              <DetailField label="Currency"><Input value={`${claim.currency} — Singapore, Dollars`} readOnly /></DetailField>
              <DetailField label="Claim description">
                <textarea
                  rows={2}
                  key={claim.description || ''}
                  defaultValue={claim.description || ''}
                  disabled={locked}
                  onBlur={(e) => {
                    if (e.target.value !== (claim.description || '')) {
                      updateClaim(claim.id, { description: e.target.value }).catch(() => {});
                    }
                  }}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                />
              </DetailField>
              <DetailField label="Paid">
                <div className="flex items-center gap-2 pt-1">
                  <span className="flex h-5 w-9 items-center rounded-full border p-0.5">
                    <span className="h-4 w-4 rounded-full bg-muted-foreground/50" />
                  </span>
                  <span className="text-sm text-muted-foreground">No</span>
                </div>
              </DetailField>
              <DetailField label="Payment method">
                <div className="relative">
                  <select className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <option value="">—</option>
                    <option>Cash</option>
                    <option>Company card</option>
                    <option>Bank transfer</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </DetailField>
              <DetailField label="Internal note">
                <textarea rows={2} className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              </DetailField>
            </div>
          ) : (
            <div>
              <p className="mb-3 text-sm font-medium">Recent activity</p>
              <ol className="space-y-5">
                {(claim.history || []).map((e, i) => (
                  <li key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className="mt-1 h-2.5 w-2.5 rounded-full bg-foreground" />
                      {i < claim.history.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
                    </div>
                    <div>
                      <p className="text-sm">
                        <span className="font-medium">{e.text}</span>{' '}
                        <span className="text-muted-foreground">by {e.by}</span>
                      </p>
                      {/* The server stamps an event with a raw ISO instant.
                          Shown as one it is unreadable; shown as a bare date it
                          loses the hour, which is half of what an activity
                          trail is for. */}
                      <p className="mt-0.5 text-xs text-muted-foreground">{formatClaimStamp(e.at)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>

      <ClaimExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        claim={{ ...claim, transactions: rows }}
        onExported={() => navigate('/expense-claims')}
      />
      <ClaimEmailModal
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        defaultName={user?.name || user?.email || ''}
        claim={{ ...claim, transactions: rows }}
      />
      <ClaimApprovalModal
        open={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        claims={[claim]}
        onSubmit={async (ids) => {
          setApprovalOpen(false);
          if (!ids.length) return;
          // Routes to the claimant's direct manager, resolved server-side. If the
          // claimant has no direct manager set, there's no one to approve — surface
          // that instead of silently doing nothing.
          setPayNote('');
          try {
            await submitForApproval(claim.id);
            setTab('history');
          } catch (e) {
            setPayNote(
              e.code === 'no_manager'
                ? `No direct manager set for ${e.claimant || claim.claimFor || 'this claimant'}. Assign one in Users before submitting for approval.`
                : 'Could not submit this claim for approval.'
            );
          }
        }}
      />

      {/* Reject with an optional reason (shown to the claimant + emailed). */}
      {rejectOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-foreground/20" onClick={() => setRejectOpen(false)} aria-hidden="true" />
          <div className="relative w-full max-w-md rounded-lg bg-background p-6 shadow-xl">
            <h2 className="text-base font-semibold tracking-tight">Reject this claim?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Add a reason so {claim.claimFor || 'the claimant'} knows what to fix. They&rsquo;ll be notified and can re-submit.
            </p>
            <textarea
              rows={3}
              autoFocus
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (optional)…"
              className="mt-3 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setRejectOpen(false)} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
              <button
                type="button"
                onClick={() => { setRejectOpen(false); decide(() => rejectClaim(claim.id, rejectReason)); }}
                className="inline-flex h-9 items-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition-opacity hover:opacity-90"
              >
                Reject claim
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk edit — set a category on the selected items */}
      {bulkCatOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setBulkCatOpen(false)}>
          <div className="w-full max-w-sm rounded-xl border bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-sm font-semibold">Bulk edit {selected.size} item{selected.size === 1 ? '' : 's'}</h2>
            <label className="mb-4 block text-sm">
              <span className="mb-1 block text-muted-foreground">Category</span>
              <ComboSelect
                aria-label="Category"
                value={bulkCat}
                options={CATEGORIES}
                onChange={setBulkCat}
                emptyLabel="Select a category…"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setBulkCatOpen(false)} className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-muted">Cancel</button>
              <button type="button" disabled={!bulkCat} onClick={doBulkCategory} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* Move — move the selected items to another (existing or new) claim */}
      {moveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setMoveOpen(false)}>
          <div className="w-full max-w-sm rounded-xl border bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-sm font-semibold">Move {selected.size} item{selected.size === 1 ? '' : 's'} to a claim</h2>
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-muted-foreground">Destination claim</span>
              <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <option value="">Select a claim…</option>
                <option value="new">+ New claim</option>
                {otherClaims.map((c) => (
                  <option key={c.id} value={c.id}>{c.claimFor} — {c.name || 'Expense claim'}</option>
                ))}
              </select>
            </label>
            {moveTarget === 'new' && (
              <label className="mb-3 block text-sm">
                <span className="mb-1 block text-muted-foreground">New claim name</span>
                <input value={moveNewName} onChange={(e) => setMoveNewName(e.target.value)} placeholder="Expense claim" className="h-9 w-full rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setMoveOpen(false)} className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-muted">Cancel</button>
              <button type="button" disabled={!moveTarget} onClick={doMove} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Move</button>
            </div>
          </div>
        </div>
      )}

      {/* The Costs drawer, pointed at this claim: same uploader, same reader,
          but every document it finishes lands on the claim instead of in the
          inbox. */}
      <AddDocumentsDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        claim={claim}
        onAdded={addUploadedToClaim}
      />
    </AppShell>
  );
}
