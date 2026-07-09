import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  Sparkles,
  ChevronDown,
  RotateCw,
  Download,
  Printer,
  Maximize2,
  MapPin,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import { useAuth } from '@/lib/auth';
import { DOCS, getDoc } from '@/data/docs';
import { cn } from '@/lib/utils';

function TopButton({ children, onClick = () => {}, subtle = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors hover:bg-muted',
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

// Read-only dropdown-styled display of an extracted value.
function Select({ value }) {
  return (
    <div className="flex h-9 w-full items-center justify-between rounded-md border bg-background px-3 text-sm">
      <span className="truncate">{value}</span>
      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
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

// Left panel: the uploaded image once one exists, else a monochrome stand-in.
function ReceiptPreview({ doc, imageUrl }) {
  if (imageUrl) {
    return (
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="border-b px-4 py-3 text-sm font-medium">Uploaded receipt</div>
        <img src={imageUrl} alt="Uploaded receipt" className="max-h-[560px] w-full object-contain" />
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="border-b px-4 py-3 text-sm">
        <span className="font-medium">{doc.supplier}</span>
        <span className="ml-2 text-muted-foreground">· {doc.date}</span>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-3 rounded-md border p-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-xs font-medium">
            NB
          </div>
          <div className="text-sm">
            <div className="font-medium">Ng Boon Ann</div>
            <div className="text-xs text-muted-foreground">Standard · Car or taxi</div>
          </div>
          <div className="ml-auto text-xs text-muted-foreground">31.88 km · 47 min</div>
        </div>
        <div className="relative flex h-40 items-center justify-center rounded-md border bg-muted/40">
          <MapPin className="h-6 w-6 text-muted-foreground" />
          <span className="absolute bottom-2 right-2 text-[10px] text-muted-foreground">Map preview</span>
        </div>
        <div className="flex items-center justify-between border-t pt-3 text-sm">
          <span className="text-muted-foreground">Total</span>
          <span className="font-semibold">
            {doc.currency} {doc.total}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-center gap-3 border-t p-2 text-muted-foreground">
        <RotateCw className="h-4 w-4" />
        <span className="text-xs">100%</span>
        <Download className="h-4 w-4" />
        <Printer className="h-4 w-4" />
        <Maximize2 className="h-4 w-4" />
      </div>
    </div>
  );
}

// Reads a File into a bare base64 string (no data-URL prefix).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const EXTRACT_ERRORS = {
  vision_not_configured: 'Vision extraction isn’t configured on the server yet.',
  invalid_image: 'That file type isn’t supported — use a PNG, JPG, or WebP.',
  refused: 'Claude declined to read that image.',
  no_data: 'Couldn’t read fields from that image — try a clearer photo.',
};

function initialData(doc) {
  return {
    user: doc.user,
    type: doc.type,
    date: doc.date,
    supplier: doc.supplier,
    po: '',
    ref: '',
    category: doc.category,
    currency: doc.currency,
    total: doc.total,
    tax: doc.tax,
    description: '',
  };
}

export default function CostDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { visionEnabled } = useAuth();
  const fileInputRef = useRef(null);

  const [tab, setTab] = useState('details');
  const [data, setData] = useState(() => initialData(getDoc(id) ?? {}));
  const [imageUrl, setImageUrl] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiNote, setAiNote] = useState(false);

  const doc = getDoc(id);
  const index = DOCS.findIndex((d) => String(d.id) === String(id));

  // Reset the form when navigating between documents (Prev/Next).
  useEffect(() => {
    const d = getDoc(id);
    if (d) setData(initialData(d));
    setImageUrl('');
    setAiError('');
    setAiNote(false);
  }, [id]);

  if (!doc) {
    return (
      <AppShell subnav={<CostsSubnav />}>
        <p className="text-sm text-muted-foreground">Document not found.</p>
      </AppShell>
    );
  }

  const set = (key, value) => setData((d) => ({ ...d, [key]: value }));
  const go = (delta) => {
    const next = DOCS[index + delta];
    if (next) navigate(`/costs/${next.id}`);
  };

  const onAiClick = () => {
    setAiError('');
    if (visionEnabled) fileInputRef.current?.click();
    else setAiNote(true);
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAiError('');
    setExtracting(true);
    setImageUrl(URL.createObjectURL(file));
    try {
      const imageBase64 = await fileToBase64(file);
      const res = await fetch('/api/costs/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, mediaType: file.type }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAiError(EXTRACT_ERRORS[body.error] ?? 'Extraction failed — please try again.');
        return;
      }
      const { data: ex } = await res.json();
      setData((d) => ({
        ...d,
        supplier: ex.supplier || d.supplier,
        date: ex.date || d.date,
        type: ex.documentType || d.type,
        currency: ex.currency || d.currency,
        category: ex.category || d.category,
        total: ex.total != null ? String(ex.total) : d.total,
        tax: ex.tax != null ? String(ex.tax) : d.tax,
      }));
    } catch {
      setAiError('Could not read that file.');
    } finally {
      setExtracting(false);
    }
  };

  return (
    <AppShell subnav={<CostsSubnav />}>
      {/* Action bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TopButton subtle onClick={() => navigate('/costs')}>
          <ChevronLeft className="h-4 w-4" /> Back
        </TopButton>
        <Flag className="mx-1 h-4 w-4 text-muted-foreground" />
        <TopButton>Move to ready</TopButton>
        <TopButton>Add to expense claim</TopButton>
        <TopButton>Split</TopButton>
        <TopButton>Archive</TopButton>
        <TopButton>
          Move to <ChevronDown className="h-3.5 w-3.5" />
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
          <span className="tabular-nums text-muted-foreground">{index + 1} / 78</span>
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: preview */}
        <ReceiptPreview doc={doc} imageUrl={imageUrl} />

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
              {/* Real Claude Vision auto-fill */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={onFile}
              />
              <button
                type="button"
                onClick={onAiClick}
                disabled={extracting}
                className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                <Sparkles className="h-4 w-4" strokeWidth={2} />
                {extracting ? 'Reading receipt…' : 'Auto-fill from receipt with Claude'}
              </button>
              {aiError && (
                <p className="mb-2 rounded-md border border-foreground/20 bg-muted px-3 py-2 text-center text-xs text-foreground">
                  {aiError}
                </p>
              )}
              {aiNote && !visionEnabled && (
                <p className="mb-2 rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
                  Vision extraction isn’t configured yet — set an <span className="font-mono">ANTHROPIC_API_KEY</span> on
                  the server to enable it.
                </p>
              )}

              <SectionHeading>Item details</SectionHeading>
              <Field label="Item ID"><Input value={doc.itemId} readOnly /></Field>
              <Field label="Document owner"><Select value={data.user} /></Field>
              <Field label="Type"><Select value={data.type} /></Field>
              <Field label="Date"><Input value={data.date} onChange={(v) => set('date', v)} /></Field>
              <Field label="Supplier"><Select value={data.supplier} /></Field>
              <Field label="Purchase order number"><Input value={data.po} onChange={(v) => set('po', v)} /></Field>
              <Field label="Document reference"><Input value={data.ref} onChange={(v) => set('ref', v)} /></Field>
              <Field label="Category"><Select value={data.category} /></Field>

              <SectionHeading>Allocation</SectionHeading>
              <Field label="Customer"><Select value="ST Engineering Info-Security Pte. Ltd." /></Field>
              <Field label="Project"><Select value="Red Alpha LLC" /></Field>
              <Field label="Description">
                <textarea
                  rows={2}
                  value={data.description}
                  onChange={(e) => set('description', e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>

              <SectionHeading>Amount</SectionHeading>
              <Field label="Currency"><Select value={data.currency} /></Field>
              <Field label="Total amount"><Input value={data.total} onChange={(v) => set('total', v)} /></Field>
              <Field label="Tax"><Select value="Extracted amount" /></Field>
              <Field label="Tax amount"><Input value={data.tax} onChange={(v) => set('tax', v)} /></Field>
              <Field label="Net amount"><Input value={data.total} readOnly /></Field>

              <SectionHeading>Payment</SectionHeading>
              <Field label="Paid">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-9 items-center rounded-full border p-0.5">
                    <span className="h-4 w-4 rounded-full bg-muted-foreground/50" />
                  </span>
                  <span className="text-sm text-muted-foreground">No</span>
                </div>
              </Field>
              <Field label="Payment method"><Select value="—" /></Field>

              <div className="mt-6 flex flex-wrap gap-2 border-t pt-4">
                <button type="button" className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
                  Move to ready
                </button>
                <TopButton>Add to expense claim</TopButton>
                <TopButton>Archive</TopButton>
                <TopButton>
                  More <ChevronDown className="h-3.5 w-3.5" />
                </TopButton>
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
                <span>Uploaded by {doc.user}</span>
                <span className="text-muted-foreground">{doc.date}</span>
              </li>
              <li className="flex justify-between border-b pb-2">
                <span>Data extracted</span>
                <span className="text-muted-foreground">{doc.date}</span>
              </li>
              <li className="flex justify-between">
                <span>Viewed by Astrid Yang</span>
                <span className="text-muted-foreground">{doc.date}</span>
              </li>
            </ul>
          )}
        </div>
      </div>
    </AppShell>
  );
}
