import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  Sparkles,
  Upload,
  ChevronDown,
  FileText,
  CheckCircle2,
  AlertCircle,
  Info,
  ExternalLink,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import SplitItemModal from '@/components/SplitItemModal';
import AddToClaimModal from '@/components/AddToClaimModal';
import PublishToXeroModal from '@/components/PublishToXeroModal';
import DuplicateReviewModal from '@/components/DuplicateReviewModal';
import { addItemToClaim, createClaim, docToClaimTxn, useClaims } from '@/lib/claimStore';
import { claimRef } from '@/lib/exportFormat';
import { useAuth } from '@/lib/auth';
import { useReaderName } from '@/lib/readerProvider';
import { DOCS, getDoc } from '@/data/docs';
import { attachBillFileToXero, resolveCategorisationOrgId, getExtractionAccounts, useCategoryOptions, useXeroPaymentMethods, useXeroCustomers, useVisibleTaxRates, useXeroProjectOptions } from '@/lib/organisations';
import { useCategoryDisplayMode, formatCategory } from '@/lib/categoryDisplay';
import { useProjectOptions } from '@/lib/listsStore';
import { useUsers } from '@/lib/userStore';
import AddPaymentMethodModal from '@/components/AddPaymentMethodModal';
import { fetchBills, fetchBillById, billToDoc, billFileUrl, updateBill, uploadBillFile, notifyBillsChanged, addBill, fetchExtract, fetchExtractLines, displayItemId, costPath, isItemKey, lineItemRows, markNotDuplicate, clearXeroPublish, DUPLICATE_REASON } from '@/lib/bills';
import { unmergeCost } from '@/lib/mergeDocs';
import SupplierRulesModal from '@/components/SupplierRulesModal';
import { LineItemsActions, LineItemsEditor, LineItemsGrid } from '@/components/LineItemsGrid';
import {
  matchSupplierRule,
  supplierRuleCategoryReason,
  supplierRuleCount,
  supplierRulePatch,
  supplierRuleProjectReason,
  useSupplierRules,
} from '@/lib/supplierRules';
import TeachRule from '@/components/TeachRule';
import { useCostsDocs, rowsFor, isInInbox } from '@/lib/costsData';
import { useExtractionSettings, noTaxRateName } from '@/lib/extractionSettings';
import { readDecisions } from '@/lib/reRead';
import { useGstRegistered } from '@/lib/businessProfile';
import { useAutoSave } from '@/lib/useAutoSave';
import { startExtraction, useExtractionJob } from '@/lib/extractionJobs';
import { xeroBillUrl } from '@/lib/autoPublish';
import SaveStatus from '@/components/SaveStatus';
import { getDocOverrides, setDocOverride } from '@/lib/docOverrides';
import { prepareUpload } from '@/lib/image';
import { cn } from '@/lib/utils';
import ComboSelect from '@/components/ComboSelect';

function TopButton({ children, onClick = () => {}, subtle = false, disabled = false, title = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title || undefined}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors',
        disabled ? 'cursor-not-allowed text-muted-foreground/50' : 'hover:bg-muted',
        subtle && 'border-transparent'
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div className="flex items-start gap-4 py-2">
      <div className="w-40 shrink-0 pt-2 text-sm text-muted-foreground">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Input({ value, onChange = null, readOnly = false }) {
  return (
    <input
      value={value}
      readOnly={readOnly || !onChange}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      className={cn(
        'h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        readOnly || !onChange ? 'bg-muted text-muted-foreground' : 'bg-background'
      )}
    />
  );
}


function SectionHeading({ children }) {
  return (
    <h3 className="mb-1 mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

// Left panel: the uploaded file once one exists, else a monochrome stand-in.
function ReceiptPreview({ doc, imageUrl, previewType }) {
  if (imageUrl) {
    return (
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="border-b px-4 py-3 text-sm font-medium">Uploaded receipt</div>
        {previewType === 'pdf' ? (
          <iframe src={imageUrl} title="Uploaded document" className="h-[560px] w-full" />
        ) : (
          <img src={imageUrl} alt="Uploaded receipt" className="max-h-[560px] w-full object-contain" />
        )}
      </div>
    );
  }
  // No stored file yet — neutral placeholder for every document (no seeded
  // "Grab receipt" mock). Use "Upload receipt" to attach the original.
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="border-b px-4 py-3 text-sm">
        <span className="font-medium">{doc.supplier || 'Document'}</span>
        {doc.date && doc.date !== '—' && <span className="ml-2 text-muted-foreground">· {doc.date}</span>}
      </div>
      <div className="flex h-80 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <FileText className="h-8 w-8" strokeWidth={1.5} />
        <p className="text-sm">No file preview for this document.</p>
        <p className="text-xs">Use “Upload receipt” to attach the original.</p>
      </div>
    </div>
  );
}

// Document types offered in the Type dropdown (mirrors Dext's list).
const DOC_TYPES = [
  'Receipt',
  'Invoice',
  'Credit note/refund',
  'Statement/remittance advice',
  'Expense statement',
  'Delivery note',
  'ATM withdrawal',
  'Mileage',
  'Other',
];

function initialData(doc) {
  return {
    user: doc.user,
    type: doc.type,
    date: doc.date,
    supplier: doc.supplier,
    ref: doc.ref ?? doc.invoiceNumber ?? '',
    category: doc.category,
    categoryReason: doc.categoryReason ?? '',
    currency: doc.currency,
    total: doc.total,
    tax: doc.tax,
    taxRate: doc.taxRate ?? '',
    taxRateReason: doc.taxRateReason ?? '',
    description: doc.description ?? '',
    paymentMethod: doc.paymentMethod ?? '',
    paid: Boolean(doc.paid),
    cardLast4: doc.cardLast4 ?? '',
    customer: doc.customer ?? '',
    project: doc.project ?? '',
    projectReason: doc.projectReason ?? '',
    note: doc.note ?? '',
    dueDate: doc.dueDate ?? '',
    lineItems: Array.isArray(doc.lineItems) ? doc.lineItems : [],
  };
}

export default function CostDetail() {
  // The URL carries the document's ITEM ID — the number shown on the page and in
  // the list (/costs/260822123051). An internal id still resolves, so older
  // links and links built from a claim line item keep working; once the document
  // loads, `id` below is always the internal id the API is addressed by.
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const { visionEnabled, user } = useAuth();
  const readerName = useReaderName();
  const teamUsers = useUsers();
  const ownerOptions = Array.from(
    new Set([user?.name || user?.email, ...teamUsers.map((u) => u.name || u.email)].filter(Boolean))
  );
  const categoryOptions = useCategoryOptions();
  const catMode = useCategoryDisplayMode();
  // Projects come from the active org's live Xero tracking category (managed in
  // Lists → Projects); fall back to the bundled seed only when Xero isn't linked.
  const xeroProjects = useXeroProjectOptions();
  const seedProjects = useProjectOptions();
  const projectOptions = xeroProjects.length ? xeroProjects : seedProjects;
  // Per-line tracking, one column per Xero tracking category the linked org
  // actually has (Xero allows two; the second is its "Projects 2"). Deliberately
  // NOT the seeded project list the document-level field falls back to: a
  // per-line project only means something on publish, and publish can only tag a
  // real Xero category. No Xero tracking, no columns — the grid is cramped
  // enough without two dropdowns that could never reach the ledger.
  const project2Options = useXeroProjectOptions(1);
  const lineProjects = xeroProjects;
  // Customers come from the active org's (CYBM) live Xero customer contacts.
  const customerOptions = useXeroCustomers();
  const paymentMethods = useXeroPaymentMethods();
  // GST/tax rates for purchases (Costs) — one managed list shared with Business
  // settings → Lists → Tax rates: the live Xero rates (seed fallback), showing
  // only the rates left Visible there. `rateFor` gives the % for the tax math.
  const taxRateSource = useVisibleTaxRates();
  // Not GST-registered → every document codes to No Tax and no GST is split out,
  // and the picker offers nothing else.
  const gstRegistered = useGstRegistered();
  const noTaxName = noTaxRateName(taxRateSource);
  const taxRateOptions = gstRegistered
    ? taxRateSource.map((t) => t.name)
    : [noTaxName].filter(Boolean);
  const rateFor = (name) => Number(taxRateSource.find((t) => t.name === name)?.rate ?? 0);
  const extractionSettings = useExtractionSettings();
  useSupplierRules(); // the Supplier field's rules link tracks whether a rule exists
  const [pmModalOpen, setPmModalOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [linesOpen, setLinesOpen] = useState(false); // full-screen line-item editor
  const fileInputRef = useRef(null);

  // Sample docs carry any local (localStorage) edits applied on top.
  const rawMock = getDoc(routeId);
  const mockDoc = rawMock ? { ...rawMock, ...(getDocOverrides()[routeId] || {}) } : null;
  const [tab, setTab] = useState('details');
  const [persisted, setPersisted] = useState(null);
  const [loading, setLoading] = useState(!mockDoc);
  const [data, setData] = useState(() => initialData(mockDoc ?? {}));
  const [imageUrl, setImageUrl] = useState('');
  const [previewType, setPreviewType] = useState('image');

  const [fieldSave, setFieldSave] = useState('idle'); // auto-save status for the document's fields
  const [aiError, setAiError] = useState('');
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitNote, setSplitNote] = useState('');
  const [claimOpen, setClaimOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [readyError, setReadyError] = useState([]); // required fields missing when trying to move to Ready
  const [gstOpen, setGstOpen] = useState(false); // GST-split panel open
  const [gstWith, setGstWith] = useState(''); // the GST-inclusive amount that carries GST
  const [claimAdded, setClaimAdded] = useState(null); // { id, name } after Add to expense claim
  const [compareOpen, setCompareOpen] = useState(false); // side-by-side duplicate review
  const [xeroBusy, setXeroBusy] = useState(''); // '' | 'attach' | 'clear'
  const [xeroNote, setXeroNote] = useState('');
  const [teach, setTeach] = useState(null); // { field, value } after a manual correction

  const doc = mockDoc ?? persisted;
  // The key everything server-side is addressed by. Falls back to the URL's key
  // while the document is still loading.
  const id = doc?.id ?? routeId;
  // The read running for THIS document, if any — including one started before
  // this page was mounted, or before the reviewer moved away and came back.
  const job = useExtractionJob(id);
  // Refs, because the handler below outlives the render it was created in: the
  // read it waits on can finish long after this page last re-rendered.
  const persistedIdRef = useRef(null);
  persistedIdRef.current = persisted?.id ?? null;
  const handledJob = useRef(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const extracting = job?.kind === 'read';
  const extractingLines = job?.kind === 'lines';
  // If this document is a line item inside an expense claim, keep the page in
  // that context: a note links back to the claim, and Back returns to it.
  const claims = useClaims();
  const { allDocs: inboxAllDocs } = useCostsDocs();
  const claimForItem = claims.find((c) => (c.transactions || []).some((t) => isItemKey(t.itemId, id)));
  const index = DOCS.findIndex((d) => String(d.id) === String(id));

  // Reset the form when navigating between documents. Sample docs resolve from
  // the in-memory mock; uploaded bills are fetched by id from the store.
  useEffect(() => {
    setImageUrl('');
    setAiError('');
    const raw = getDoc(routeId);
    if (raw) {
      setData(initialData({ ...raw, ...(getDocOverrides()[routeId] || {}) }));
      setPersisted(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    // Prefer the active org's list (drives prev/next); fall back to a global
    // by-id fetch so a claim's line item resolves even if its document sits in
    // another org's book.
    fetchBills()
      .then(async (bills) => {
        const match = bills.find((b) => isItemKey(b.id, routeId));
        return match || (await fetchBillById(routeId));
      })
      .then((match) => {
        if (!alive) return;
        const pd = match ? billToDoc(match) : null;
        setPersisted(pd);
        if (pd) {
          // Opened by internal id (an old bookmark, or a claim line item): swap
          // the address bar for the item-id form without adding a history entry.
          if (String(routeId) !== displayItemId(pd.id)) navigate(costPath(pd.id), { replace: true });
          setData(initialData(pd));
          if (pd.hasFile) {
            setImageUrl(billFileUrl(pd.id));
            setPreviewType(pd.contentType.includes('pdf') ? 'pdf' : 'image');
          }
        }
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [routeId, navigate]);

  // A read that finished while this page was elsewhere (or unmounted) wrote its
  // answer to the server, not to this form. So when the job for this document
  // settles, take the document back from the server rather than trusting what
  // is on screen — otherwise the fields shown are the pre-read ones, and the
  // next keystroke saves them back over the answer.
  useEffect(() => {
    // Attached once per job, and NOT torn down when the job clears — the job
    // clearing is precisely the moment this has to run. Only unmounting stops
    // it, and a later mount re-reads the document from the server anyway.
    if (!job || handledJob.current === job) return;
    handledJob.current = job;
    const kind = job.kind;
    job.promise.then(async (outcome) => {
      if (!mounted.current) return;
      if (!outcome.ok && outcome.error) setAiError(outcome.error);
      const docId = persistedIdRef.current; // read now: it may have loaded since
      if (!docId) return; // sample docs have nothing on the server to take back
      const fresh = await fetchBillById(docId).catch(() => null);
      if (!mounted.current || !fresh) return;
      const pd = billToDoc(fresh);
      setPersisted(pd);
      // A line-items read only touched the rows; leave the rest of the form
      // alone in case something else was being typed while it ran.
      if (kind === 'lines') setData((d) => ({ ...d, lineItems: pd.lineItems }));
      else setData(initialData(pd));
    });
  }, [job]);

  // Not GST-registered: force the document onto No Tax with no GST split out,
  // and persist it. The picker offers nothing else, but a document coded before
  // the profile changed (or before it was answered) still carries the old rate —
  // this is what actually corrects it, rather than just warning about it.
  useEffect(() => {
    if (gstRegistered || !doc || !noTaxName) return;
    const staleRate = data.taxRate !== noTaxName;
    const staleTax = (Number(String(data.tax ?? '').replace(/[^0-9.-]/g, '')) || 0) !== 0;
    if (!staleRate && !staleTax) return;
    setData((d) => ({ ...d, taxRate: noTaxName, tax: '0.00', taxRateReason: '' }));
    if (doc.persisted) {
      updateBill(doc.id, { taxRate: noTaxName, tax: '0.00', taxRateReason: '' })
        .then((r) => {
          if (r?.bill) {
            setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
            notifyBillsChanged();
          }
        })
        .catch(() => {});
    } else {
      setDocOverride(doc.id, { taxRate: noTaxName, tax: '0.00' });
    }
  }, [gstRegistered, noTaxName, doc, data.taxRate, data.tax]);

  // The Note tab saves itself too, on a pause rather than per keystroke — it's
  // free text, so a PATCH per character would be a write storm.
  const noteSave = useAutoSave(
    data.note,
    async (note) => {
      if (doc?.persisted) {
        const r = await updateBill(doc.id, { note });
        if (r?.bill) {
          setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
          notifyBillsChanged();
        }
      } else {
        setDocOverride(id, { note });
      }
    },
    { delay: 900, enabled: Boolean(doc) },
  );

  if (!doc) {
    return (
      <AppShell subnav={<CostsSubnav />}>
        <p className="text-sm text-muted-foreground">
          {loading ? 'Loading document…' : 'Document not found.'}
        </p>
      </AppShell>
    );
  }

  // Detail field key → the server bill field it maps to. Editing one of these on
  // a persisted cost auto-saves it so the server can re-derive ready vs inbox
  // (readiness is automatic now — no manual "Move to ready" needed).
  const SERVER_FIELDS = {
    supplier: 'supplier', date: 'date', category: 'category', categoryReason: 'categoryReason',
    currency: 'currency', total: 'total', tax: 'tax', ref: 'invoiceNumber', type: 'documentType',
    taxRate: 'taxRate', taxRateReason: 'taxRateReason', description: 'description', user: 'createdBy',
    paymentMethod: 'paymentMethod', paid: 'paid', lineItems: 'lineItems',
    customer: 'customer', project: 'project', projectReason: 'projectReason', cardLast4: 'cardLast4',
    dueDate: 'dueDate',
  };
  const set = (key, value) => {
    // Overruling the reader on an allocation is the one moment both halves of a
    // rule are known — what it got wrong and what's right. Offer to keep it.
    if ((key === 'category' || key === 'project') && doc?.persisted && value && value !== data[key]) {
      setTeach({ field: key, value });
    }
    setData((d) => ({ ...d, [key]: value }));
    if (readyError.length) setReadyError([]); // fixing a field clears the "not ready" banner
    const sf = SERVER_FIELDS[key];
    if (doc?.persisted && sf) {
      // Persist + adopt the returned status so the action bar flips to "In Ready"
      // the moment the last required field is filled (and back if one is cleared).
      setFieldSave('saving');
      updateBill(doc.id, { [sf]: value })
        .then((r) => {
          setFieldSave('saved');
          if (r?.bill) {
            setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
            notifyBillsChanged();
          }
        })
        .catch(() => setFieldSave('error'));
    }
  };

  // Several fields at once (applying a supplier rule) — one state update and
  // one PATCH rather than a burst of single-field saves racing each other.
  const setMany = (patch) => {
    const entries = Object.entries(patch).filter(([k]) => k in data);
    if (!entries.length) return;
    setData((d) => ({ ...d, ...Object.fromEntries(entries) }));
    if (readyError.length) setReadyError([]);
    if (!doc?.persisted) return;
    const server = {};
    for (const [k, v] of entries) {
      const sf = SERVER_FIELDS[k];
      if (sf) server[sf] = v;
    }
    if (!Object.keys(server).length) return;
    setFieldSave('saving');
    updateBill(doc.id, server)
      .then((r) => {
        setFieldSave('saved');
        if (r?.bill) {
          setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
          notifyBillsChanged();
        }
      })
      .catch(() => setFieldSave('error'));
  };

  // A rule saved from the Supplier field lands on this document straight away —
  // that's the point of writing it here rather than on the Suppliers list.
  const applySupplierRuleToForm = (rule) => {
    const patch = supplierRulePatch(rule, { invoiceDate: data.date, gstRegistered });
    const categoryReason = supplierRuleCategoryReason(rule, data.supplier);
    const projectReason = supplierRuleProjectReason(rule, data.supplier);
    if (categoryReason) patch.categoryReason = categoryReason;
    if (projectReason) patch.projectReason = projectReason;
    setMany(patch);
  };

  const go = (delta) => {
    const next = DOCS[index + delta];
    if (next) navigate(costPath(next.id));
  };

  // After an action that finishes with this document (Add to expense claim,
  // Publish to Xero), jump to the next item still in the Costs inbox so the
  // reviewer can keep working without going Back each time. Falls back to the
  // previous item, then to the inbox list when nothing else is left.
  const goToNextInbox = () => {
    const ids = rowsFor(inboxAllDocs, 'inbox').map((d) => String(d.id));
    const i = ids.indexOf(String(id));
    const nextId = i !== -1 ? (ids[i + 1] ?? ids[i - 1]) : ids[0];
    navigate(nextId && nextId !== String(id) ? costPath(nextId) : '/costs');
  };

  // Activity timeline for the History tab — a vertical, dotted feed (newest
  // first) built from the document's real events, mirroring the expense-claim
  // approval-history layout.
  const fmtStamp = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('en-SG', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
    });
  };
  const docHistoryEvents = (() => {
    if (!doc) return [];
    const created = doc.createdAt || '';
    const owner = doc.user || 'a user';
    const events = [
      { text: 'This document was uploaded', by: owner, at: fmtStamp(created), origin: true },
      { text: 'Data was extracted by CYBills AI', by: 'CYBills AI', at: fmtStamp(created) },
    ];
    if (doc.xeroPostedAt) {
      events.push({
        text: `This document was published to Xero${doc.xeroTenantName ? ` (${doc.xeroTenantName})` : ''}`,
        by: owner,
        at: fmtStamp(doc.xeroPostedAt),
      });
    }
    if (doc.status === 'expenseclaim') {
      events.push({ text: 'This document was added to an expense claim', by: owner, at: '' });
    }
    events.push({ text: 'This document was viewed', by: user?.name || user?.email || 'you', at: '' });
    return events.reverse(); // newest first
  })();

  // The document this one matched, for the side-by-side review. Resolved from
  // the loaded Costs set; if it's since been deleted there's nothing to compare
  // and the review stays shut.
  const duplicateOf = doc?.duplicateOfId
    ? inboxAllDocs.find((d) => String(d.id) === String(doc.duplicateOfId)) || null
    : null;

  // "These are different documents" — clears the flag for good, so later
  // re-checks don't keep raising it.
  const dismissDuplicate = async () => {
    const r = await markNotDuplicate(doc.id).catch(() => null);
    if (r?.bill) {
      setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
      notifyBillsChanged();
    }
  };

  // billToDoc shows an empty date as the placeholder '—'; never persist that
  // literal back — coerce anything that isn't a real ISO date to blank.
  const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');

  // Persist the current edits + set a workflow status. Uploaded bills save
  // server-side; sample docs save to localStorage.
  const persistStatus = async (status) => {
    if (doc.persisted) {
      try {
        await updateBill(doc.id, {
          status,
          supplier: data.supplier,
          date: isoDate(data.date),
          documentType: data.type,
          category: data.category,
          categoryReason: data.categoryReason,
          currency: data.currency,
          total: data.total,
          tax: data.tax,
          invoiceNumber: data.ref,
          taxRate: data.taxRate,
          taxRateReason: data.taxRateReason,
          description: data.description,
          paymentMethod: data.paymentMethod,
          paid: data.paid,
          customer: data.customer,
          project: data.project,
          projectReason: data.projectReason,
          lineItems: data.lineItems,
        });
        notifyBillsChanged();
      } catch {
        // best-effort; still navigate back
      }
    } else {
      setDocOverride(id, {
        status,
        user: data.user,
        type: data.type,
        date: isoDate(data.date),
        supplier: data.supplier,
        ref: data.ref,
        category: data.category,
        currency: data.currency,
        total: data.total,
        tax: data.tax,
        description: data.description,
      });
    }
  };

  // Save + set status, then return to the inbox (default) or a given route.
  const saveWithStatus = async (status, to = '/costs') => {
    await persistStatus(status);
    navigate(to);
  };

  // "Ready" means a document is complete enough to export / publish, so it must
  // carry the fields the rest of the workflow depends on. Instead of silently
  // advancing a half-filled doc, Move to ready validates these and tells you
  // exactly what's missing (answers "what does Move to Ready do?").
  const isBlank = (v) => !v || String(v).trim() === '' || String(v).trim() === '—';
  const amountOk = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) > 0;
  const READY_REQUIRED = [
    ['supplier', 'Supplier'],
    ['date', 'Date'],
    ['category', 'Category'],
    ['total', 'Total amount'],
  ];
  const missingForReady = () =>
    READY_REQUIRED.filter(([k]) => {
      if (k === 'total') return !amountOk(data.total);
      if (k === 'category')
        return isBlank(data.category) || String(data.category).trim().toLowerCase() === 'uncategorised';
      return isBlank(data[k]);
    }).map(([, label]) => label);

  // Validate before advancing — only a complete document moves to Ready.
  const moveToReady = () => {
    const missing = missingForReady();
    if (missing.length) {
      setReadyError(missing);
      return;
    }
    setReadyError([]);
    saveWithStatus('ready');
  };

  // "Move to" another workspace — takes the item out of the Costs inbox and
  // lands on that workspace. Persist an archived status so it leaves the list.
  const MOVE_DESTS = [
    { label: 'Sales', to: '/sales' },
    { label: 'Supplier statements', to: '/supplier-statements' },
  ];
  const moveTo = (dest) => {
    setMoveOpen(false);
    saveWithStatus('archived', dest.to);
  };

  // Unmerge: split a merged document back into its original items (they return
  // to the inbox) and remove the combined document. Dext parity.
  const doUnmerge = async () => {
    if (!window.confirm('Unmerge this document back into its original items? They return to the inbox and this combined document is removed.')) return;
    await unmergeCost(doc);
    navigate('/costs');
  };

  const deleteDoc = () => {
    if (!window.confirm('Delete this document? This removes it from your Costs inbox.')) return;
    saveWithStatus('archived');
  };

  // Publish to Xero (persisted bills only — the server posts the SAVED bill,
  // so flush any on-screen edits first, keeping the current workflow status).
  const openPublish = async () => {
    await persistStatus(persisted?.status ?? 'new');
    setPublishOpen(true);
  };
  // Put the stored file on the Xero bill. For documents published before
  // attachments were sent, or when that upload failed at publish time.
  const sendFileToXero = async () => {
    setXeroBusy('attach');
    setXeroNote('');
    try {
      const orgId = await resolveCategorisationOrgId();
      if (!orgId) throw new Error('No Xero organisation is linked.');
      await attachBillFileToXero(orgId, doc.id);
      // Name mid-sentence: a tenant name ending in "Ltd." would otherwise give
      // the line two full stops.
      setXeroNote(`File attached to the bill in ${doc.xeroTenantName || 'Xero'} — it shows there under Related Files.`);
    } catch (err) {
      setXeroNote(err?.message || 'Could not attach the file to Xero.');
    } finally {
      setXeroBusy('');
    }
  };

  // "This bill no longer exists in Xero" — clear the provenance so the document
  // comes back out of Archive and can be published again. Nothing is deleted in
  // Xero from here, so say so before doing it.
  const clearXeroLink = async () => {
    if (!window.confirm(`Clear this document's Xero link?\n\nIt goes back to your Costs inbox and can be published again. Nothing is deleted in ${doc.xeroTenantName || 'Xero'} — if the bill is still there, delete or void it in Xero first, or you'll end up with two.`)) return;
    setXeroBusy('clear');
    setXeroNote('');
    try {
      const r = await clearXeroPublish(doc.id);
      if (r?.bill) setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
      notifyBillsChanged();
      setXeroNote('Xero link cleared — this document is back in your inbox.');
    } catch {
      setXeroNote('Could not clear the Xero link — please try again.');
    } finally {
      setXeroBusy('');
    }
  };

  const onPublished = ({ bill }) => {
    if (bill) setPersisted(billToDoc({ ...bill, hasFile: Boolean(bill.storageKey) }));
    notifyBillsChanged();
    // Move on to the next inbox item once the publish dialog reports success.
    goToNextInbox();
  };

  // Grab the current receipt's bytes (so the split's new item shares the image).
  const receiptToUpload = async () => {
    if (!imageUrl) return null;
    try {
      const resp = await fetch(imageUrl);
      const blob = await resp.blob();
      const type = blob.type || (previewType === 'pdf' ? 'application/pdf' : 'image/jpeg');
      const file = new File([blob], doc.fileName || 'receipt', { type });
      return await prepareUpload(file);
    } catch {
      return null;
    }
  };

  // Split: keep the current item (updated amounts/category) and create a second
  // line item from the SAME receipt with the new item's amounts/category.
  const doSplit = async ({ current, next }) => {
    setSplitOpen(false);
    // 1) apply the "current item" values to this document.
    const curPatch = { category: current.category, total: current.total, tax: current.tax };
    setData((d) => ({ ...d, ...curPatch }));
    if (doc.persisted) await updateBill(doc.id, curPatch).catch(() => {});
    else setDocOverride(doc.id, curPatch);

    // 2) create the new line item as a persisted cost, sharing the receipt image.
    const rec = await receiptToUpload();
    /** @type {any} */
    const payload = {
      fileHash: `split_${doc.id}_${Date.now()}`,
      fileName: doc.fileName || `${data.supplier || 'receipt'}`,
      supplier: data.supplier,
      invoiceNumber: data.invoiceNumber || '',
      documentType: data.type || 'Receipt',
      date: isoDate(data.date),
      currency: 'SGD',
      category: next.category,
      total: next.total,
      tax: next.tax,
      kind: 'cost',
    };
    if (rec) { payload.fileBase64 = rec.base64; payload.mediaType = rec.mediaType; }
    try {
      const result = await addBill(payload, { force: true });
      // Put the split item in the same pipeline tab as the current one.
      const status = doc.persisted ? doc.status : (getDocOverrides()[doc.id]?.status || doc.status);
      if (result?.bill?.id && status && status !== 'new') {
        await updateBill(result.bill.id, { status }).catch(() => {});
      }
      notifyBillsChanged();
      setSplitNote(`Split done — a new item for ${data.supplier || 'this receipt'} was created.`);
    } catch {
      setSplitNote('Could not create the split item. Please try again.');
    }
  };

  const num = (v) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;

  // Pick a specific GST/tax rate (replaces the "Extracted amount" placeholder).
  // A rate with a % also fills the tax amount from the GST-inclusive total.
  const setTaxRate = (name) => {
    set('taxRate', name);
    const r = rateFor(name);
    const total = num(data.total);
    const tax = r > 0 && total > 0 ? (total * r) / (100 + r) : 0;
    set('tax', tax ? tax.toFixed(2) : '0.00');
  };

  // Split an invoice that mixes GST and non-GST costs into two lines: the
  // GST-inclusive portion (carrying the tax) and the remainder (no tax). Uses the
  // selected rate, or SG's 9% default.
  // Open the GST-split panel. Pre-fill the GST-inclusive amount: if a tax amount
  // is already set, derive the taxed portion from it; otherwise start at the full
  // total so the user just types how much of it has GST.
  const openGstSplit = () => {
    const total = num(data.total);
    const r = rateFor(data.taxRate) || 9;
    const tax = num(data.tax);
    const preset = tax > 0 && r > 0 ? (tax * (100 + r)) / r : total;
    setGstWith(Math.min(preset, total).toFixed(2));
    setGstOpen(true);
  };

  // Split into a GST line (the entered amount, carrying its GST) + a no-tax line
  // for the remainder. Matches the Support Desk ask for invoices that mix GST and
  // non-GST costs.
  const runGstSplit = () => {
    const total = num(data.total);
    const withGst = num(gstWith);
    const withoutGst = total - withGst;
    const r = rateFor(data.taxRate) || 9;
    if (withGst <= 0 || withGst > total + 0.005) {
      window.alert('Enter a “with GST” amount between 0 and the total.');
      return;
    }
    if (withoutGst <= 0.005) {
      window.alert('Nothing to split — the whole total has GST, so leave it as one line.');
      return;
    }
    const gstTax = (withGst * r) / (100 + r); // GST inside the GST-inclusive amount
    setGstOpen(false);
    doSplit({
      current: { category: data.category, total: withGst.toFixed(2), tax: gstTax.toFixed(2) },
      next: { category: data.category, total: withoutGst.toFixed(2), tax: '0.00' },
    });
  };

  // Run extraction on the given bytes (with the org's Review instructions + live
  // chart), then apply + persist the results. Shared by upload and re-read.
  // Runs as a JOB (extractionJobs.js), so leaving this page for the next
  // document doesn't abandon the read: it keeps going, saves what it finds, and
  // the page picks it back up whenever it returns. Everything inside here must
  // therefore stand on its own — the setState calls are a courtesy to whoever
  // is still watching, the updateBill is what actually makes it count.
  const extractAndApply = (imageBase64, mediaType) =>
    startExtraction(doc.id, 'read', async () => {
    setAiError('');
    try {
      const accounts = await getExtractionAccounts();
      const ex = await fetchExtract(imageBase64, mediaType, accounts);
      if (!ex) { setAiError('Extraction failed — please try again.'); return; }
      // Which value wins — the supplier rule, the document's own paper, this
      // read, or what the document already carried — is decided in one place
      // (readDecisions), so this page and the inbox's bulk re-read agree.
      const {
        patch, rule, descr, inferredRate, rateReason, supplierName, categoryReason, projectReason, ruleLines,
      } = readDecisions(data, ex, {
        gstRegistered,
        taxRates: taxRateSource,
        defaultTaxRateCosts: extractionSettings.defaultTaxRateCosts,
        accounts,
      });
      setData((d) => ({
        ...d,
        supplier: ex.supplier || d.supplier,
        date: ex.date || d.date,
        type: ex.documentType || d.type,
        ref: ex.invoiceNumber || d.ref,
        currency: rule.currency || ex.currency || d.currency,
        category: rule.category || ex.category || d.category,
        categoryReason: categoryReason || d.categoryReason,
        customer: rule.customer || d.customer,
        total: ex.total != null ? String(ex.total) : d.total,
        tax: !gstRegistered ? '0.00' : ex.tax != null ? String(ex.tax) : d.tax,
        taxRate: rule.taxRate || d.taxRate || inferredRate,
        taxRateReason: rule.taxRate
          ? `Standing rule: documents from ${supplierName} are coded ${rule.taxRate}.`
          : d.taxRate
            ? d.taxRateReason
            : ex.taxRateReason || rateReason || d.taxRateReason,
        description: rule.description || descr || d.description,
        paymentMethod: rule.paymentMethod || d.paymentMethod,
        paid: 'paid' in rule ? rule.paid : d.paid,
        cardLast4: ex.cardLast4 || d.cardLast4,
        // A re-read is the way a rule written AFTER the upload reaches a
        // document — writing a rule and pressing this is the whole point — so
        // an allocation it returns wins. Returning nothing leaves what's there.
        // A supplier rule outranks both: it's a standing instruction.
        project: rule.project || ex.project || d.project,
        projectReason: projectReason || d.projectReason,
        // The due date printed on the document is the supplier's own answer, so
        // the rule's payment terms only fill a gap it leaves.
        dueDate: ex.dueDate || rule.dueDate || d.dueDate,
        // "Extract line items" on the rule pulls the printed lines in with the
        // read — but never over rows already on the document, which may have
        // been edited by hand.
        lineItems: ruleLines.length && !d.lineItems?.length ? ruleLines : d.lineItems,
      }));
      if (doc?.persisted) {
        const r = await updateBill(doc.id, patch).catch(() => null);
        if (r?.bill) {
          setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
          notifyBillsChanged();
          return r.bill;
        }
      }
      return null;
    } catch {
      setAiError('Could not read that file.');
      throw new Error('Could not read that file.');
    }
  });

  // --- Line items (Dext-style per-line breakdown) --------------------------
  // The Supplier field's rules link labels itself from the rule this supplier
  // already carries.
  const supplierNamed = String(data.supplier || '').trim();
  const supplierRuleN = supplierRuleCount(matchSupplierRule(data.supplier));

  const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
  const setLineItems = (rows) => set('lineItems', rows);
  const updateLineItem = (i, patch) =>
    setLineItems(lineItems.map((li, idx) => (idx === i ? { ...li, ...patch } : li)));
  const addLineItem = () =>
    setLineItems([
      ...lineItems,
      { description: '', category: data.category || 'Uncategorised', project: data.project || '', project2: '', net: '', tax: '', total: '' },
    ]);
  const removeLineItem = (i) => setLineItems(lineItems.filter((_, idx) => idx !== i));
  // One set of props for the grid, so the panel and the full-screen editor are
  // rendering the same thing over the same state.
  const lineGrid = {
    rows: lineItems,
    total: data.total,
    onUpdate: updateLineItem,
    onRemove: removeLineItem,
    categoryOptions,
    catMode,
    lineProjects,
    project2Options,
    docProject: data.project || '',
  };

  // Read the attached receipt and turn its printed lines into editable rows.
  // Its own pass (see server/src/extract.ts): the rows come back already checked
  // against the document's own grand total, so anything that doesn't add up is
  // said out loud here rather than left for the "Out by" row to be noticed.
  const extractLineItems = async () => {
    setAiError('');
    const rec = await receiptToUpload();
    if (!rec) { setAiError('Attach a receipt first, then extract line items.'); return; }
    // A job, like the whole-document read: long enough that nobody watches it,
    // so it has to survive the reviewer moving on to the next document.
    startExtraction(doc.id, 'lines', async () => {
    try {
      const accounts = await getExtractionAccounts();
      const ex = await fetchExtractLines(rec.base64, rec.mediaType, accounts);
      const rows = Array.isArray(ex?.lines) ? ex.lines : [];
      if (!rows.length) { setAiError('No itemised charges found on this document.'); return null; }
      // Saved here rather than through `set`, whose write is fire-and-forget:
      // the job must not resolve before the rows are actually stored, or the
      // page could re-sync itself from the server a moment too early.
      const built = lineItemRows(rows, data.category);
      setData((d) => ({ ...d, lineItems: built }));
      if (doc?.persisted) {
        const r = await updateBill(doc.id, { lineItems: built }).catch(() => null);
        if (r?.bill) {
          setPersisted(billToDoc({ ...r.bill, hasFile: Boolean(r.bill.storageKey) }));
          notifyBillsChanged();
        }
      }
      const money = (n) => Number(n || 0).toFixed(2);
      if (!ex.reconciled) {
        setAiError(
          `Read ${rows.length} line${rows.length === 1 ? '' : 's'} totalling ${money(ex.linesTotal)}, but the ` +
            `document's total reads as ${money(ex.grandTotal)}. ` +
            (ex.note || 'Check for a row that was missed, or one that is really a subtotal.')
        );
      } else if (Math.abs(num(data.total) - Number(ex.grandTotal || 0)) > 0.005) {
        // The lines agree with the document; it's this bill's total that doesn't.
        setAiError(
          `The lines add up to ${money(ex.linesTotal)}, which is the document's own total — but this bill ` +
            `says ${money(data.total)}. Check the Total amount field.`
        );
      }
      return built;
    } catch {
      setAiError('Could not extract line items.');
      throw new Error('Could not extract line items.');
    }
    });
  };

  const onUploadClick = () => {
    setAiError('');
    fileInputRef.current?.click();
  };

  // Re-read the EXISTING receipt with the configured reader (no file replacement) — for fixing
  // a wrong field the AI read (date, category, description…) without re-uploading.
  const reReadExisting = async () => {
    setAiError('');
    const rec = await receiptToUpload();
    if (!rec) { setAiError('No receipt attached to re-read. Upload one first.'); return; }
    await extractAndApply(rec.base64, rec.mediaType);
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAiError('');
    // Downscale large photos so the base64 payload stays under the server body
    // limit (a raw phone photo can exceed it once encoded, which silently failed
    // the attach and lost the image on reload).
    const { base64: imageBase64, mediaType, previewUrl } = await prepareUpload(file);
    // Always attach + show the uploaded image, regardless of AI availability.
    setPreviewType(mediaType.includes('pdf') ? 'pdf' : 'image');
    setImageUrl(previewUrl);
    // Persist the file onto a real bill so it survives reload (fixes docs that
    // were uploaded before file storage worked).
    if (doc.persisted) {
      try {
        await uploadBillFile(doc.id, imageBase64, mediaType);
        notifyBillsChanged();
      } catch {
        // Surface it — a swallowed failure here is exactly why the image used to
        // vanish on reload.
        setAiError('Could not save the receipt to this document. Please try uploading again.');
      }
    }
    // Only run auto-fill when a reader is configured; otherwise the user
    // fills the (editable) fields manually.
    if (!visionEnabled) return;
    await extractAndApply(imageBase64, mediaType);
  };

  const readyMissing = missingForReady();

  return (
    <AppShell subnav={<CostsSubnav />}>
      {claimForItem && (
        <div className="mb-3 flex items-start gap-2 rounded-md border bg-muted px-3 py-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This item belongs to expense claim{' '}
            <button
              type="button"
              onClick={() => navigate(`/expense-claims/${claimForItem.id}`)}
              className="font-medium text-foreground underline underline-offset-2 hover:opacity-80"
            >
              {claimRef(claimForItem)}
            </button>{' '}
            called <span className="font-medium text-foreground">{claimForItem.claimFor}</span>
            {claimForItem.endDate ? ` (${claimForItem.endDate})` : ''}.
          </span>
        </div>
      )}
      {splitNote && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> {splitNote}
          <button type="button" onClick={() => setSplitNote('')} className="ml-auto text-emerald-700/70 hover:text-emerald-700">Dismiss</button>
        </div>
      )}
      {readyError.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Not ready yet — this document still needs {readyError.join(', ')}. Fill{' '}
            {readyError.length === 1 ? 'it' : 'them'} in, then Move to ready.
          </span>
          <button type="button" onClick={() => setReadyError([])} className="ml-auto text-destructive/70 hover:text-destructive">Dismiss</button>
        </div>
      )}
      {isInInbox(doc) && doc.duplicateOfId && !doc.duplicateDismissed && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {DUPLICATE_REASON[doc.duplicateType] || 'This looks like a document already submitted.'}{' '}
            <button
              type="button"
              onClick={() => setCompareOpen(true)}
              className="font-medium underline underline-offset-2"
            >
              Compare side by side
            </button>
            {' · '}
            <button
              type="button"
              onClick={() => navigate(costPath(doc.duplicateOfId))}
              className="underline underline-offset-2"
            >
              Open the one it matches
            </button>
          </span>
          <button
            type="button"
            onClick={dismissDuplicate}
            className="ml-auto whitespace-nowrap text-destructive/70 hover:text-destructive"
          >
            Not a duplicate
          </button>
        </div>
      )}

      {/* Action bar */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <TopButton subtle onClick={() => navigate(claimForItem ? `/expense-claims/${claimForItem.id}` : '/costs')}>
          <ChevronLeft className="h-4 w-4" /> Back
        </TopButton>
        <Flag className="mx-1 h-4 w-4 text-muted-foreground" />
        {doc.status === 'ready' ? (
          <span className="inline-flex h-8 items-center gap-1 rounded-md border border-foreground/40 px-3 text-sm text-foreground">
            <CheckCircle2 className="h-4 w-4" /> In Ready
          </span>
        ) : doc.persisted ? (
          // Readiness is auto-derived from the fields — show status, no manual button.
          <span
            title={readyMissing.length ? `Missing: ${readyMissing.join(', ')}` : 'All required fields present'}
            className={cn(
              'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs',
              readyMissing.length ? 'text-muted-foreground' : 'border-foreground/40 text-foreground'
            )}
          >
            {readyMissing.length ? (
              `Missing: ${readyMissing.join(', ')}`
            ) : (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> Ready
              </>
            )}
          </span>
        ) : (
          // Sample/demo docs have no server to auto-derive — keep the manual move.
          <>
            <TopButton onClick={moveToReady}>Move to ready</TopButton>
            <span
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs',
                readyMissing.length ? 'text-muted-foreground' : 'border-foreground/40 text-foreground'
              )}
            >
              {readyMissing.length ? (
                `Missing ${readyMissing.length} field${readyMissing.length === 1 ? '' : 's'}`
              ) : (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" /> All fields complete
                </>
              )}
            </span>
          </>
        )}
        {doc.persisted &&
          (doc.xeroInvoiceId ? (
            <a
              href={xeroBillUrl(doc.xeroInvoiceId)}
              target="_blank"
              rel="noreferrer"
              title={`Open this bill in ${doc.xeroTenantName || 'Xero'}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-green-600/30 bg-green-600/10 px-3 text-sm text-green-700 transition-colors hover:bg-green-600/20"
            >
              View in {doc.xeroTenantName || 'Xero'}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : (
            // On a claim, this cost reaches Xero as a line of the claim's own
            // bill — publishing it separately would post it twice.
            <TopButton
              onClick={openPublish}
              disabled={Boolean(claimForItem)}
              title={claimForItem ? 'On an expense claim — the claim posts this cost to Xero. Remove it from the claim to publish it on its own.' : ''}
            >
              Publish to Xero
            </TopButton>
          ))}
        {doc.persisted && doc.xeroInvoiceId && doc.hasFile && (
          <TopButton onClick={sendFileToXero} disabled={xeroBusy} title="Upload this document's file to the Xero bill as an attachment">
            {xeroBusy === 'attach' ? 'Sending…' : 'Send file to Xero'}
          </TopButton>
        )}
        {doc.persisted && doc.xeroInvoiceId && (
          <TopButton onClick={clearXeroLink} disabled={xeroBusy} title="Forget that this was published — does not delete anything in Xero">
            {xeroBusy === 'clear' ? 'Clearing…' : 'Clear Xero link'}
          </TopButton>
        )}
        <TopButton
          onClick={() => setClaimOpen(true)}
          disabled={Boolean(doc.xeroInvoiceId)}
          title={doc.xeroInvoiceId ? `Already published to ${doc.xeroTenantName || 'Xero'} — it can’t also go on an expense claim.` : ''}
        >
          Add to expense claim
        </TopButton>
        <TopButton onClick={() => setSplitOpen(true)}>Split</TopButton>
        {doc.mergedFrom?.length > 0 && <TopButton onClick={doUnmerge}>Unmerge</TopButton>}
        <TopButton onClick={() => saveWithStatus('archived')}>Archive</TopButton>
        <div className="relative">
          <TopButton onClick={() => setMoveOpen((o) => !o)}>
            Move to <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', moveOpen && 'rotate-180')} />
          </TopButton>
          {moveOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMoveOpen(false)} aria-hidden="true" />
              <div className="absolute left-0 z-20 mt-1 w-48 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
                {MOVE_DESTS.map((dest) => (
                  <button
                    key={dest.label}
                    type="button"
                    onClick={() => moveTo(dest)}
                    className="flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                  >
                    {dest.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
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
            {index >= 0 ? index + 1 : '–'} / {DOCS.length}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={index >= DOCS.length - 1}
            className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      {xeroNote && (
        <div className="mb-3 flex items-start gap-2 rounded-md border bg-muted px-3 py-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{xeroNote}</span>
          <button type="button" onClick={() => setXeroNote('')} className="ml-auto text-muted-foreground hover:text-foreground">Dismiss</button>
        </div>
      )}
      <div className="mb-4">
        <button
          type="button"
          onClick={deleteDoc}
          className="inline-flex h-8 items-center rounded-md border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Delete
        </button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: preview */}
        <ReceiptPreview doc={doc} imageUrl={imageUrl} previewType={previewType} />

        {/* Right: extracted fields */}
        <div>
          <div className="mb-4 flex items-center justify-between border-b">
            <div className="flex gap-6">
              {['details', 'note', 'history'].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    '-mb-px border-b-2 pb-3 pt-1 text-sm capitalize transition-colors',
                    tab === t
                      ? 'border-foreground font-medium text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <span className="mb-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">Viewed</span>
          </div>

          {tab === 'details' && (
            <div>
              {/* Upload a receipt image (always) + AI auto-fill (when a reader is on) */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                className="hidden"
                onChange={onFile}
              />
              <button
                type="button"
                onClick={imageUrl && visionEnabled ? reReadExisting : onUploadClick}
                disabled={Boolean(job)}
                className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {visionEnabled ? <Sparkles className="h-4 w-4" strokeWidth={2} /> : <Upload className="h-4 w-4" strokeWidth={2} />}
                {extracting
                  ? 'Reading receipt…'
                  : imageUrl
                    ? visionEnabled ? `Re-read with ${readerName}` : 'Replace file'
                    : visionEnabled ? `Upload receipt & auto-fill with ${readerName}` : 'Upload receipt'}
              </button>
              {imageUrl && visionEnabled ? (
                <p className="mb-2 text-center text-xs text-muted-foreground">
                  Re-reads the attached receipt to fix a wrong field —{' '}
                  <button type="button" onClick={onUploadClick} disabled={Boolean(job)} className="font-medium text-emerald-600 hover:underline disabled:opacity-60">
                    replace the file
                  </button>{' '}
                  instead if the photo is unclear.
                </p>
              ) : (
                <p className="mb-2 text-center text-xs text-muted-foreground">
                  {imageUrl
                    ? 'Replaces the file on this same document — it won’t create a new one.'
                    : 'Attaches the receipt to this document — it won’t create a new one.'}
                </p>
              )}
              {aiError && (
                <p className="mb-2 rounded-md border border-foreground/20 bg-muted px-3 py-2 text-center text-xs text-foreground">
                  {aiError}
                </p>
              )}
              {imageUrl && !visionEnabled && (
                <p className="mb-2 rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
                  Receipt attached. AI auto-fill is off — fill in the fields below manually.
                </p>
              )}

              <SectionHeading>Item details</SectionHeading>
              <Field label="Item ID"><Input value={displayItemId(doc.id)} readOnly /></Field>
              <Field label="Document owner"><ComboSelect value={data.user} options={ownerOptions} onChange={(v) => set('user', v)} /></Field>
              <Field label="Type"><ComboSelect value={data.type} options={DOC_TYPES} onChange={(v) => set('type', v)} /></Field>
              <Field label="Date">
                <input
                  type="date"
                  value={/^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : ''}
                  onChange={(e) => set('date', e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>
              <Field label="Supplier">
                <Input value={data.supplier} onChange={(v) => set('supplier', v)} />
                <button
                  type="button"
                  onClick={() => setRulesOpen(true)}
                  disabled={!supplierNamed}
                  title={supplierNamed ? '' : 'Fill in the supplier first'}
                  className={cn(
                    'mt-1 text-xs font-medium',
                    supplierNamed ? 'text-emerald-600 hover:underline' : 'cursor-not-allowed text-muted-foreground/60'
                  )}
                >
                  {supplierRuleN > 0 ? `Edit supplier rules (${supplierRuleN})` : 'Set supplier rules'}
                </button>
              </Field>
              <Field label="Document reference"><Input value={data.ref} onChange={(v) => set('ref', v)} /></Field>
              <Field label="Category">
                <ComboSelect value={data.category} options={categoryOptions} onChange={(v) => set('category', v)} format={(c) => formatCategory(c, catMode)} />
                {teach?.field === 'category' && (
                  <TeachRule field="category" value={teach.value} supplier={data.supplier} onClose={() => setTeach(null)} />
                )}
              </Field>
              <Field label="Reason">
                <textarea
                  rows={2}
                  value={data.categoryReason}
                  onChange={(e) => set('categoryReason', e.target.value)}
                  placeholder={extracting ? 'Reading…' : 'Why this category — filled in by the AI, editable'}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>

              <SectionHeading>Allocation</SectionHeading>
              <Field label="Customer"><ComboSelect value={data.customer || ''} options={customerOptions} onChange={(v) => set('customer', v)} /></Field>
              <Field label="Project">
                <ComboSelect value={data.project || ''} options={projectOptions} onChange={(v) => set('project', v)} />
                {teach?.field === 'project' && (
                  <TeachRule field="project" value={teach.value} supplier={data.supplier} onClose={() => setTeach(null)} />
                )}
              </Field>
              <Field label="Reason">
                <textarea
                  rows={2}
                  value={data.projectReason || ''}
                  onChange={(e) => set('projectReason', e.target.value)}
                  placeholder="Why this project — filled in by the AI, editable"
                  className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>
              <Field label="Description">
                <textarea
                  rows={2}
                  value={data.description}
                  onChange={(e) => set('description', e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>

              <SectionHeading>Amount</SectionHeading>
              <Field label="Currency"><Input value={data.currency} onChange={(v) => set('currency', v)} /></Field>
              <Field label="Total amount"><Input value={data.total} onChange={(v) => set('total', v)} /></Field>
              <Field label="Tax rate">
                <ComboSelect value={data.taxRate} options={taxRateOptions} onChange={setTaxRate} />
                {!gstRegistered && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Fixed to No Tax — this company isn’t GST-registered. Change that under Business
                    settings → Business profile.
                  </p>
                )}
                {gstRegistered && data.taxRateReason && (
                  <p className="mt-1.5 text-xs text-muted-foreground">{data.taxRateReason}</p>
                )}
              </Field>
              <Field label="Tax amount"><Input value={data.tax} onChange={(v) => set('tax', v)} /></Field>
              <Field label="Net amount"><Input value={(num(data.total) - num(data.tax)).toFixed(2)} readOnly /></Field>
              {num(data.total) > 0 && (
                <div className="flex items-start gap-4 py-2">
                  <div className="w-40 shrink-0" />
                  <div className="flex-1">
                    {!gstOpen ? (
                      <>
                        <button
                          type="button"
                          onClick={openGstSplit}
                          className="inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors hover:bg-muted"
                        >
                          Split GST / non-GST
                        </button>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Invoice mixes GST and non-GST costs? Split it into a line with GST and a line without.
                        </p>
                      </>
                    ) : (
                      <div className="space-y-2 rounded-md border p-3">
                        <p className="text-xs font-medium">Split into a GST line + a non-GST line</p>
                        <label className="flex items-center gap-2 text-xs">
                          <span className="w-32 shrink-0 text-muted-foreground">Amount with GST</span>
                          <input
                            value={gstWith}
                            onChange={(e) => setGstWith(e.target.value)}
                            className="h-8 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        </label>
                        <label className="flex items-center gap-2 text-xs">
                          <span className="w-32 shrink-0 text-muted-foreground">Amount without GST</span>
                          <span className="flex-1 tabular-nums">{(num(data.total) - num(gstWith)).toFixed(2)}</span>
                        </label>
                        <p className="text-[11px] text-muted-foreground">
                          GST rate: {data.taxRate || 'Standard-Rated Purchases (9%)'}. The GST line carries the tax; the other line has none.
                        </p>
                        <div className="flex gap-2 pt-1">
                          <button
                            type="button"
                            onClick={runGstSplit}
                            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
                          >
                            Create 2 lines
                          </button>
                          <button
                            type="button"
                            onClick={() => setGstOpen(false)}
                            className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <SectionHeading>Payment</SectionHeading>
              <Field label="Paid">
                <button type="button" onClick={() => set('paid', !data.paid)} className="flex items-center gap-2 pt-1">
                  <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', data.paid ? 'justify-end bg-foreground' : 'justify-start border')}>
                    <span className={cn('h-4 w-4 rounded-full', data.paid ? 'bg-background' : 'bg-muted-foreground/50')} />
                  </span>
                  <span className="text-sm text-muted-foreground">{data.paid ? 'Yes' : 'No'}</span>
                </button>
              </Field>
              <Field label="Payment method">
                <ComboSelect
                  value={data.paymentMethod || ''}
                  options={paymentMethods.map((p) => p.label)}
                  onChange={(v) => set('paymentMethod', v)}
                />
                <button
                  type="button"
                  onClick={() => setPmModalOpen(true)}
                  className="mt-1 text-xs font-medium text-emerald-600 hover:underline"
                >
                  Add payment method
                </button>
              </Field>

              <SectionHeading>Line items</SectionHeading>
              <LineItemsGrid {...lineGrid} />
              <LineItemsActions
                onExtract={extractLineItems}
                onAdd={addLineItem}
                onExpand={() => setLinesOpen(true)}
                extracting={extractingLines}
                busy={Boolean(job)}
                visionEnabled={visionEnabled}
                canExpand={lineItems.length > 0}
              />

              <div className="mt-6 flex flex-wrap gap-2 border-t pt-4">
                {doc.status === 'ready' ? (
                  <span className="inline-flex h-9 items-center gap-1 rounded-md border border-foreground/40 px-3 text-sm font-medium text-foreground">
                    <CheckCircle2 className="h-4 w-4" /> In Ready
                  </span>
                ) : doc.persisted ? (
                  <span className="inline-flex h-9 items-center gap-1 rounded-md border px-3 text-sm text-muted-foreground">
                    {readyMissing.length ? `Missing: ${readyMissing.join(', ')}` : 'Ready'}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={moveToReady}
                    className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                  >
                    Move to ready
                  </button>
                )}
                {doc.persisted && <SaveStatus status={fieldSave} className="px-1" />}
                <TopButton
                  onClick={() => setClaimOpen(true)}
                  disabled={Boolean(doc.xeroInvoiceId)}
                  title={doc.xeroInvoiceId ? `Already published to ${doc.xeroTenantName || 'Xero'} — it can’t also go on an expense claim.` : ''}
                >
                  Add to expense claim
                </TopButton>
                <TopButton onClick={() => saveWithStatus('archived')}>Archive</TopButton>
                <TopButton onClick={() => setSplitOpen(true)}>Split</TopButton>
              </div>
            </div>
          )}

          {tab === 'note' && (
            <div className="space-y-3">
              <textarea
                rows={6}
                value={data.note}
                onChange={(e) => set('note', e.target.value)}
                placeholder="Add a note about this document…"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="flex items-center gap-3">
                <SaveStatus status={noteSave} />
              </div>
            </div>
          )}

          {tab === 'history' && (
            <ol className="relative space-y-6 text-sm">
              {docHistoryEvents.map((e, i) => (
                <li key={i} className="relative flex gap-4">
                  <div className="flex flex-col items-center">
                    <span
                      className={
                        e.origin
                          ? 'mt-1 h-3 w-3 rounded-full bg-foreground ring-4 ring-muted'
                          : 'mt-1 h-3 w-3 rounded-full border-2 border-foreground bg-background'
                      }
                    />
                    {i < docHistoryEvents.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
                  </div>
                  <div className="pb-1">
                    <p className="text-sm">
                      <span className="font-medium">{e.text}</span>
                      {e.by && <span className="text-muted-foreground"> by {e.by}</span>}
                    </p>
                    {e.at && <p className="mt-0.5 text-xs text-muted-foreground">{e.at}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <SplitItemModal
        open={splitOpen}
        onClose={() => setSplitOpen(false)}
        onSplit={doSplit}
        imageUrl={imageUrl}
        previewType={previewType}
        current={{ category: data.category, total: data.total, tax: data.tax }}
      />
      <AddToClaimModal
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        onAdd={async ({ claimId, newClaim }) => {
          setClaimOpen(false);
          setAiError('');
          // Link this cost to the chosen (or newly created) claim so it shows
          // up as a line item there, then mark it as in an expense claim.
          try {
            const targetId = newClaim ? (await createClaim(newClaim)).id : claimId;
            const actor = user?.name || user?.email || 'You';
            if (targetId) await addItemToClaim(targetId, docToClaimTxn(doc, data, actor));
            await persistStatus('expenseclaim');
            notifyBillsChanged();
            // Confirm before moving on: let the user jump to the claim they just
            // added to, or close to advance to the next inbox item.
            const name = newClaim ? (newClaim.name || 'Expense claim') : (claims.find((c) => c.id === targetId)?.name || 'Expense claim');
            setClaimAdded({ id: targetId, name });
          } catch (err) {
            setAiError(
              err?.code === 'claim_locked'
                ? 'That claim is already approved, so items can’t be added to it.'
                : err?.code === 'published_to_xero'
                  ? 'This document is already published to Xero, so it can’t also go on an expense claim.'
                  : 'Could not add this item to the claim — please try again.'
            );
          }
        }}
      />
      <DuplicateReviewModal
        open={compareOpen && Boolean(duplicateOf)}
        pairs={duplicateOf ? [{ duplicate: doc, original: duplicateOf }] : []}
        onClose={() => setCompareOpen(false)}
        onResolved={() => { setCompareOpen(false); goToNextInbox(); }}
      />

      <PublishToXeroModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        bill={{ id: doc.id, supplier: data.supplier, total: data.total, tax: data.tax, currency: data.currency, date: data.date, dueDate: data.dueDate, category: data.category, taxRate: data.taxRate, lineItems: data.lineItems }}
        onPublished={onPublished}
      />

      {claimAdded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-foreground/20" onClick={() => { setClaimAdded(null); goToNextInbox(); }} aria-hidden="true" />
          <div className="relative w-full max-w-sm overflow-hidden rounded-lg bg-background shadow-xl">
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-600" />
              <p className="text-sm">
                Item added to expense claim <span className="font-medium">{claimAdded.name}</span>.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 border-t px-6 py-4">
              <button
                type="button"
                onClick={() => { const id = claimAdded.id; setClaimAdded(null); navigate(`/expense-claims/${id}`); }}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Go to expense claim
              </button>
              <button
                type="button"
                onClick={() => { setClaimAdded(null); goToNextInbox(); }}
                className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <LineItemsEditor
        open={linesOpen}
        onClose={() => setLinesOpen(false)}
        title={data.supplier}
        preview={<ReceiptPreview doc={doc} imageUrl={imageUrl} previewType={previewType} />}
        actions={
          <LineItemsActions
            onExtract={extractLineItems}
            onAdd={addLineItem}
            extracting={extractingLines}
            busy={Boolean(job)}
            visionEnabled={visionEnabled}
          />
        }
        {...lineGrid}
      />

      <SupplierRulesModal
        open={rulesOpen}
        supplier={data.supplier}
        categoryOptions={categoryOptions}
        customerOptions={customerOptions}
        projectOptions={projectOptions}
        taxRateOptions={taxRateOptions}
        paymentMethodOptions={paymentMethods.map((p) => p.label)}
        gstRegistered={gstRegistered}
        onClose={() => setRulesOpen(false)}
        onApply={applySupplierRuleToForm}
      />

      <AddPaymentMethodModal
        open={pmModalOpen}
        onClose={() => setPmModalOpen(false)}
        onAdded={(pm) => set('paymentMethod', pm.label)}
      />
    </AppShell>
  );
}
