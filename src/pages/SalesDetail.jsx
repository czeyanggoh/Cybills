import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronDown, Flag, Copy, Star } from 'lucide-react';
import AppShell from '@/components/AppShell';
import SalesSubnav from '@/components/SalesSubnav';
import SplitItemModal from '@/components/SplitItemModal';
import { SALES, getSale } from '@/data/sales';
import { useCategoryOptions } from '@/lib/organisations';
import { cn } from '@/lib/utils';

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

// Left panel: a compact ride-receipt-style preview of the sales document.
function SalesPreview({ sale }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-sm font-medium">{sale.date}{sale.time ? `, ${sale.time}` : ''}</span>
        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{sale.type}</span>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Booking ID</span>
          <span className="flex items-center gap-2 font-mono text-xs">
            {sale.ref}
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        </div>
        <div className="rounded-md border p-3 text-center text-sm">
          <p className="text-muted-foreground">Rate this ride</p>
          <div className="mt-2 flex justify-center gap-1 text-muted-foreground/40">
            {[0, 1, 2, 3, 4].map((i) => (
              <Star key={i} className="h-5 w-5" strokeWidth={1.5} />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-md border p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-xs font-medium">
            {sale.payer.split(' ').map((w) => w[0]).slice(0, 2).join('')}
          </div>
          <span className="text-sm font-medium">{sale.payer}</span>
        </div>
        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
          <span className="text-muted-foreground">{sale.card}</span>
          <span className="text-xs text-muted-foreground">Personal</span>
        </div>
        <div className="flex items-center justify-between border-t pt-3 text-sm">
          <span className="text-muted-foreground">Total</span>
          <span className="font-semibold">S${sale.total}</span>
        </div>
      </div>
    </div>
  );
}

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
  const categoryOptions = useCategoryOptions();
  const sale = getSale(id);
  const [tab, setTab] = useState('details');
  const [moveOpen, setMoveOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [paid, setPaid] = useState(false);
  const [data, setData] = useState(() => initialData(sale ?? {}));

  const index = SALES.findIndex((s) => String(s.id) === String(id));

  if (!sale) {
    return (
      <AppShell subnav={<SalesSubnav />}>
        <p className="text-sm text-muted-foreground">Sales document not found.</p>
      </AppShell>
    );
  }

  const set = (k, v) => setData((d) => ({ ...d, [k]: v }));
  const go = (delta) => {
    const next = SALES[index + delta];
    if (next) navigate(`/sales/${next.id}`);
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
            disabled={index >= SALES.length - 1}
            className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: preview */}
        <SalesPreview sale={sale} />

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
              <Field label="Description" hint={`Use ${sale.payer}`}>
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
        imageUrl=""
        previewType="image"
        current={{ category: data.category, total: data.total, tax: data.tax }}
      />
    </AppShell>
  );
}
