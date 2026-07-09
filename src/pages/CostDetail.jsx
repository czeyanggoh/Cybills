import { useState } from 'react';
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

// A labelled field: label on the left, control on the right (Dext-style).
function Field({ label, children, sub = null }) {
  return (
    <div className="flex items-start gap-4 py-2">
      <div className="w-40 shrink-0 pt-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        {sub && <div className="mt-1 text-xs text-foreground/70">{sub}</div>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Input({ value, readOnly = false }) {
  return (
    <input
      defaultValue={value}
      readOnly={readOnly}
      className={cn(
        'h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        readOnly ? 'bg-muted text-muted-foreground' : 'bg-background'
      )}
    />
  );
}

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

// Monochrome stand-in for the uploaded receipt image/screenshot.
function ReceiptPreview({ doc }) {
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

        {/* Faux route/map block */}
        <div className="relative flex h-40 items-center justify-center rounded-md border bg-muted/40">
          <MapPin className="h-6 w-6 text-muted-foreground" />
          <span className="absolute bottom-2 right-2 text-[10px] text-muted-foreground">Map preview</span>
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex gap-2">
            <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-foreground" />
            <div>
              <div>432D Yishun Ave 1, Vista Spring</div>
              <div className="text-xs text-muted-foreground">8:00 AM</div>
            </div>
          </div>
          <div className="flex gap-2">
            <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full border border-foreground" />
            <div>
              <div>Pickup/Drop-off Point, Tuas Naval Base</div>
              <div className="text-xs text-muted-foreground">8:48 AM</div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t pt-3 text-sm">
          <span className="text-muted-foreground">Total</span>
          <span className="font-semibold">
            {doc.currency} {doc.total}
          </span>
        </div>
      </div>

      {/* Zoom / tools bar */}
      <div className="flex items-center justify-center gap-3 border-t p-2 text-muted-foreground">
        <RotateCw className="h-4 w-4 cursor-pointer hover:text-foreground" />
        <span className="text-xs">100%</span>
        <Download className="h-4 w-4 cursor-pointer hover:text-foreground" />
        <Printer className="h-4 w-4 cursor-pointer hover:text-foreground" />
        <Maximize2 className="h-4 w-4 cursor-pointer hover:text-foreground" />
      </div>
    </div>
  );
}

export default function CostDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState('details');
  const [aiNote, setAiNote] = useState(false);

  const doc = getDoc(id);
  const index = DOCS.findIndex((d) => String(d.id) === String(id));

  if (!doc) {
    return (
      <AppShell subnav={<CostsSubnav />}>
        <p className="text-sm text-muted-foreground">Document not found.</p>
      </AppShell>
    );
  }

  const go = (delta) => {
    const next = DOCS[index + delta];
    if (next) navigate(`/costs/${next.id}`);
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
        {/* Left: document preview */}
        <ReceiptPreview doc={doc} />

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
            <span className="mb-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              Viewed
            </span>
          </div>

          {tab === 'details' && (
            <div>
              {/* AI auto-fill — stub for the Claude Vision integration */}
              <button
                type="button"
                onClick={() => setAiNote(true)}
                className="mb-2 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                <Sparkles className="h-4 w-4" strokeWidth={2} />
                Auto-fill from receipt with Claude
              </button>
              {aiNote && (
                <p className="mb-2 rounded-md border border-dashed px-3 py-2 text-center text-xs text-muted-foreground">
                  Vision extraction isn’t wired up yet — this button will call the backend to
                  read the receipt and fill these fields automatically.
                </p>
              )}

              <SectionHeading>Item details</SectionHeading>
              <Field label="Item ID"><Input value={doc.itemId} readOnly /></Field>
              <Field label="Document owner"><Select value={doc.user} /></Field>
              <Field label="Type"><Select value={doc.type} /></Field>
              <Field label="Date"><Input value={doc.date} /></Field>
              <Field label="Supplier"><Select value={doc.supplier} /></Field>
              <Field label="Purchase order number"><Input value="" /></Field>
              <Field label="Document reference"><Input value="" /></Field>
              <Field label="Category"><Select value={doc.category} /></Field>

              <SectionHeading>Allocation</SectionHeading>
              <Field label="Customer"><Select value="ST Engineering Info-Security Pte. Ltd." /></Field>
              <Field label="Project"><Select value="Red Alpha LLC" /></Field>
              <Field label="Description">
                <textarea
                  rows={2}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </Field>

              <SectionHeading>Amount</SectionHeading>
              <Field label="Currency"><Select value={`${doc.currency} — Singapore, Dollars`} /></Field>
              <Field label="Total amount"><Input value={doc.total} /></Field>
              <Field label="Tax"><Select value="Extracted amount" /></Field>
              <Field label="Tax amount"><Input value={doc.tax} /></Field>
              <Field label="Net amount"><Input value={doc.total} readOnly /></Field>

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

              {/* Bottom actions */}
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
