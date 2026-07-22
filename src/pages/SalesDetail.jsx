import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronDown, Flag, Sparkles, Upload, FileText } from 'lucide-react';
import AppShell from '@/components/AppShell';
import SalesSubnav from '@/components/SalesSubnav';
import SplitItemModal from '@/components/SplitItemModal';
import { useAuth } from '@/lib/auth';
import { SALES, getSale } from '@/data/sales';
import { useCategoryOptions, getExtractionAccounts } from '@/lib/organisations';
import { fetchBills, billToDoc, billFileUrl, displayItemId } from '@/lib/bills';
import { prepareUpload } from '@/lib/image';
import { cn } from '@/lib/utils';

// Map a persisted sales upload (billToDoc shape) into the sale record this page
// renders — the same fields getSale() returns for a sample row.
function billDocToSale(d) {
  return {
    id: d.id,
    persisted: true,
    itemId: displayItemId(d.id),
    user: d.user,
    type: d.type,
    date: d.date,
    customer: d.supplier,
    ref: d.invoiceNumber || displayItemId(d.id),
    dueDate: '',
    category: d.category,
    project: '',
    currency: d.currency,
    total: d.total,
    tax: d.tax,
    hasFile: d.hasFile,
    contentType: d.contentType,
  };
}

function TopButton({ children, onClick = () => {}, subtle = false, danger = false, dropdown = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors hover:bg-muted',
        subtle && 'border-transparent',
        danger && 'border-transparent text-destructive hover:bg-destructive/10'
      )}
    >
      {children}
      {dropdown && <ChevronDown className="h-3.5 w-3.5" />}
    </button>
  );
}

function Field({ label, hint = '', children }) {
  return (
    <div className="flex items-start gap-4 py-2">
      <div className="w-40 shrink-0 pt-2 text-sm text-muted-foreground">{label}</div>
      <div className="flex-1">
        {children}
        {hint && <p className="mt-1 text-xs font-medium text-emerald-600">{hint}</p>}
      </div>
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

function EditableSelect({ value, options, onChange }) {
  const known = options.includes(value);
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!known && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function SectionHeading({ children }) {
  return (
    <h3 className="mb-1 mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

// Left panel: the uploaded invoice/receipt once one exists, else a neutral
// placeholder prompting an upload.
function ReceiptPreview({ sale, imageUrl, previewType }) {
  if (imageUrl) {
    return (
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="border-b px-4 py-3 text-sm font-medium">Uploaded document</div>
        {previewType === 'pdf' ? (
          <iframe src={imageUrl} title="Uploaded document" className="h-[560px] w-full" />
        ) : (
          <img src={imageUrl} alt="Uploaded document" className="max-h-[560px] w-full object-contain" />
        )}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="border-b px-4 py-3 text-sm">
        <span className="font-medium">{sale.customer || 'Sales invoice'}</span>
        {sale.date && <span className="ml-2 text-muted-foreground">· {sale.date}</span>}
      </div>
      <div className="flex h-80 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <FileText className="h-8 w-8" strokeWidth={1.5} />
        <p className="text-sm">No file preview for this document.</p>
        <p className="text-xs">Use “Upload document” to attach the original.</p>
      </div>
    </div>
  );
}

const EXTRACT_ERRORS = {
  vision_not_configured: 'Vision extraction isn’t configured on the server yet.',
  invalid_image: 'That file type isn’t supported — use a PNG, JPG, WebP or PDF.',
  refused: 'Claude declined to read that document.',
  no_data: 'Couldn’t read fields from that document — try a clearer file.',
};

function initialData(s) {
  return {
    user: s.user,
    type: s.type,
    date: s.date,
    customer: s.customer,
    ref: s.ref,
    dueDate: s.dueDate,
    category: s.category,
    project: s.project,
    description: '',
    currency: `${s.currency} — Singapore, Dollars`,
    total: s.total,
    tax: s.tax,
    paymentMethod: '',
  };
}

export default function SalesDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { visionEnabled } = useAuth();
  const categoryOptions = useCategoryOptions();
  const fileInputRef = useRef(null);
  const mockSale = getSale(id);
  const [persistedSale, setPersistedSale] = useState(null);
  // Only sample rows resolve synchronously; persisted uploads are fetched.
  const [resolving, setResolving] = useState(!mockSale);
  const [tab, setTab] = useState('details');
  const [moveOpen, setMoveOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [paid, setPaid] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [previewType, setPreviewType] = useState('image');
  const [extracting, setExtracting] = useState(false);
  const [aiError, setAiError] = useState('');
  const [data, setData] = useState(() => initialData(mockSale ?? {}));

  const sale = mockSale ?? persistedSale;

  // Resolve a persisted sales upload by id, prefill its fields, and show its
  // stored file. Runs only when this id isn't one of the sample rows.
  useEffect(() => {
    if (mockSale) return;
    let live = true;
    (async () => {
      const doc = (await fetchBills()).map(billToDoc).find((b) => b.id === id);
      if (!live) return;
      if (doc) {
        const mapped = billDocToSale(doc);
        setPersistedSale(mapped);
        setData(initialData(mapped));
        if (mapped.hasFile) {
          setImageUrl(billFileUrl(mapped.id));
          setPreviewType(String(mapped.contentType).includes('pdf') ? 'pdf' : 'image');
        }
      }
      setResolving(false);
    })();
    return () => {
      live = false;
    };
  }, [id, mockSale]);

  const index = SALES.findIndex((s) => String(s.id) === String(id));

  if (!sale) {
    return (
      <AppShell subnav={<SalesSubnav />}>
        <p className="text-sm text-muted-foreground">
          {resolving ? 'Loading…' : 'Sales document not found.'}
        </p>
      </AppShell>
    );
  }

  const set = (k, v) => setData((d) => ({ ...d, [k]: v }));
  const go = (delta) => {
    const next = SALES[index + delta];
    if (next) navigate(`/sales/${next.id}`);
  };

  const onUploadClick = () => {
    setAiError('');
    fileInputRef.current?.click();
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAiError('');
    const { base64: imageBase64, mediaType, previewUrl } = await prepareUpload(file);
    setPreviewType(mediaType.includes('pdf') ? 'pdf' : 'image');
    setImageUrl(previewUrl);
    // Auto-fill from the uploaded document when Claude Vision is configured.
    if (!visionEnabled) return;
    setExtracting(true);
    try {
      const accounts = await getExtractionAccounts();
      const res = await fetch('/api/costs/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, mediaType, accounts }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAiError(EXTRACT_ERRORS[body.error] ?? 'Extraction failed — please try again.');
        return;
      }
      const { data: ex } = await res.json();
      setData((d) => ({
        ...d,
        date: ex.date || d.date,
        ref: ex.invoiceNumber || d.ref,
        category: ex.category || d.category,
        total: ex.total != null ? String(ex.total) : d.total,
        tax: ex.tax != null ? String(ex.tax) : d.tax,
        // Fill the customer from the extracted party only if it's still blank.
        customer: d.customer || ex.supplier || '',
      }));
    } catch {
      setAiError('Could not read that file.');
    } finally {
      setExtracting(false);
    }
  };

  const MOVE_DESTS = [
    { label: 'Costs', to: '/costs' },
    { label: 'Supplier statements', to: '/supplier-statements' },
    { label: 'Vault', to: '/vault' },
  ];

  const net = (Number(data.total || 0) - Number(data.tax || 0)).toFixed(2);

  return (
    <AppShell subnav={<SalesSubnav />}>
      {/* Action bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TopButton subtle onClick={() => navigate('/sales')}>
          <ChevronLeft className="h-4 w-4" /> Back
        </TopButton>
        <Flag className="mx-1 h-4 w-4 text-muted-foreground" />
        <TopButton onClick={() => navigate('/sales')}>Move to ready</TopButton>
        <TopButton onClick={() => setSplitOpen(true)}>Split</TopButton>
        <TopButton onClick={() => navigate('/sales')}>Archive</TopButton>
        <div className="relative">
          <TopButton onClick={() => setMoveOpen((o) => !o)} dropdown>Move to</TopButton>
          {moveOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMoveOpen(false)} aria-hidden="true" />
              <div className="absolute left-0 z-20 mt-1 w-48 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
                {MOVE_DESTS.map((dest) => (
                  <button
                    key={dest.label}
                    type="button"
                    onClick={() => { setMoveOpen(false); navigate(dest.to); }}
                    className="flex w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                  >
                    {dest.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <TopButton
          danger
          onClick={() => {
            if (window.confirm('Delete this sales document?')) navigate('/sales');
          }}
        >
          Delete
        </TopButton>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={index <= 0}
            className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="tabular-nums text-muted-foreground">{index + 1} / {SALES.length}</span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={index < 0 || index >= SALES.length - 1}
            className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: uploaded document preview */}
        <ReceiptPreview sale={sale} imageUrl={imageUrl} previewType={previewType} />

        {/* Right: details */}
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
              {/* Upload an invoice/receipt image or PDF + Claude auto-fill. */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                className="hidden"
                onChange={onFile}
              />
              <button
                type="button"
                onClick={onUploadClick}
                disabled={extracting}
                className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {visionEnabled ? <Sparkles className="h-4 w-4" strokeWidth={2} /> : <Upload className="h-4 w-4" strokeWidth={2} />}
                {extracting
                  ? 'Reading document…'
                  : visionEnabled
                    ? 'Upload document & auto-fill with Claude'
                    : 'Upload document'}
              </button>
              {aiError && (
                <p className="mb-2 rounded-md border border-foreground/20 bg-muted px-3 py-2 text-center text-xs text-foreground">
                  {aiError}
                </p>
              )}
              {imageUrl && !visionEnabled && (
                <p className="mb-2 rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
                  Document attached. AI auto-fill is off — fill in the fields below manually.
                </p>
              )}

              <SectionHeading>Item details</SectionHeading>
              <Field label="Item ID"><Input value={sale.itemId} readOnly /></Field>
              <Field label="Document owner"><Input value={data.user} onChange={(v) => set('user', v)} /></Field>
              <Field label="Type"><Input value={data.type} onChange={(v) => set('type', v)} /></Field>
              <Field label="Date"><Input value={data.date} onChange={(v) => set('date', v)} /></Field>
              <Field label="Customer" hint="Set customer rules">
                <Input value={data.customer} onChange={(v) => set('customer', v)} />
              </Field>
              <Field label="Document reference"><Input value={data.ref} onChange={(v) => set('ref', v)} /></Field>
              <Field label="Due date"><Input value={data.dueDate} onChange={(v) => set('dueDate', v)} /></Field>
              <Field label="Category">
                <EditableSelect value={data.category} options={categoryOptions} onChange={(v) => set('category', v)} />
              </Field>

              <SectionHeading>Allocation</SectionHeading>
              <Field label="Project"><Input value={data.project} onChange={(v) => set('project', v)} /></Field>
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
              <Field label="Tax amount"><Input value={data.tax} onChange={(v) => set('tax', v)} /></Field>
              <Field label="Net amount"><Input value={net} readOnly /></Field>

              <SectionHeading>Payment</SectionHeading>
              <Field label="Paid">
                <button type="button" onClick={() => setPaid((p) => !p)} className="flex items-center gap-2 pt-1">
                  <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', paid ? 'justify-end bg-foreground' : 'justify-start border')}>
                    <span className={cn('h-4 w-4 rounded-full', paid ? 'bg-background' : 'bg-muted-foreground/50')} />
                  </span>
                  <span className="text-sm text-muted-foreground">{paid ? 'Yes' : 'No'}</span>
                </button>
              </Field>
              <Field label="Payment method"><Input value={data.paymentMethod} onChange={(v) => set('paymentMethod', v)} /></Field>

              <div className="mt-6 flex flex-wrap gap-2 border-t pt-4">
                <button
                  type="button"
                  onClick={() => navigate('/sales')}
                  className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  Move to ready
                </button>
                <TopButton onClick={() => navigate('/sales')}>Archive</TopButton>
                <TopButton onClick={() => setSplitOpen(true)}>Split</TopButton>
              </div>
            </div>
          )}

          {tab === 'note' && (
            <textarea
              rows={6}
              placeholder="Add a note about this document…"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}

          {tab === 'history' && (
            <ul className="space-y-3 text-sm">
              <li className="flex justify-between border-b pb-2">
                <span>Uploaded by {sale.user}</span>
                <span className="text-muted-foreground">{sale.date}</span>
              </li>
              <li className="flex justify-between border-b pb-2">
                <span>Data extracted</span>
                <span className="text-muted-foreground">{sale.date}</span>
              </li>
              <li className="flex justify-between">
                <span>Viewed by Astrid Yang</span>
                <span className="text-muted-foreground">{sale.date}</span>
              </li>
            </ul>
          )}
        </div>
      </div>

      <SplitItemModal
        open={splitOpen}
        onClose={() => setSplitOpen(false)}
        onSplit={() => setSplitOpen(false)}
        imageUrl={imageUrl}
        previewType={previewType}
        current={{ category: data.category, total: data.total, tax: data.tax }}
      />
    </AppShell>
  );
}
