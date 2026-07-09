import { useState } from 'react';
import { Upload, SlidersHorizontal, Plus } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { cn } from '@/lib/utils';

// Mock cost documents standing in for Dext's extracted-document inbox. Static
// for now — this is UI only until the backend/OCR pipeline exists.
const DOCS = [
  { id: 1, status: 'ready', date: '2026-07-07', supplier: 'Amazon Web Services', category: 'Software', total: '1,240.00', tax: '99.20', currency: 'SGD' },
  { id: 2, status: 'review', date: '2026-07-06', supplier: 'Grab', category: 'Travel', total: '38.50', tax: '2.52', currency: 'SGD' },
  { id: 3, status: 'ready', date: '2026-07-05', supplier: 'Foodpanda', category: 'Meals & Entertainment', total: '84.20', tax: '5.51', currency: 'SGD' },
  { id: 4, status: 'inbox', date: '2026-07-05', supplier: 'Figma Inc.', category: 'Software', total: '180.00', tax: '—', currency: 'USD' },
  { id: 5, status: 'review', date: '2026-07-04', supplier: 'SingTel', category: 'Utilities', total: '96.30', tax: '6.30', currency: 'SGD' },
  { id: 6, status: 'ready', date: '2026-07-03', supplier: 'Apple', category: 'Equipment', total: '2,899.00', tax: '231.92', currency: 'SGD' },
  { id: 7, status: 'inbox', date: '2026-07-02', supplier: 'Notion Labs', category: 'Software', total: '96.00', tax: '—', currency: 'USD' },
];

const TABS = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'ready', label: 'Ready' },
  { key: 'review', label: 'To Review' },
  { key: 'all', label: 'All' },
];

// Monochrome status pip — no colour, just weight/fill, per the b&w house style.
function StatusCell({ status }) {
  const map = {
    ready: { dot: 'bg-foreground', label: 'Ready' },
    review: { dot: 'border border-foreground bg-transparent', label: 'To review' },
    inbox: { dot: 'bg-muted-foreground/40', label: 'New' },
  };
  const s = map[status] ?? map.inbox;
  return (
    <span className="inline-flex items-center gap-2 text-muted-foreground">
      <span className={cn('h-2 w-2 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
}

function Th({ children, className }) {
  return (
    <th className={cn('px-4 py-2.5 text-left font-medium text-muted-foreground', className)}>
      {children}
    </th>
  );
}

function Td({ children, className }) {
  return <td className={cn('px-4 py-3 align-middle', className)}>{children}</td>;
}

export default function Costs() {
  const [tab, setTab] = useState('inbox');

  const rows = DOCS.filter((d) => tab === 'all' || d.status === tab);

  const actions = (
    <button
      type="button"
      className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
    >
      <Upload className="h-4 w-4" strokeWidth={2} />
      Upload
    </button>
  );

  return (
    <AppShell title="Costs" actions={actions}>
      {/* Tabs */}
      <div className="mb-4 flex items-center gap-6 border-b">
        {TABS.map((t) => {
          const count = t.key === 'all' ? DOCS.length : DOCS.filter((d) => d.status === t.key).length;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 pb-3 pt-1 text-sm transition-colors',
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
                {count}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          className="ml-auto mb-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Table settings"
        >
          <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40">
            <tr>
              <Th className="w-[140px]">Status</Th>
              <Th className="w-[120px]">Date</Th>
              <Th>Supplier</Th>
              <Th>Category</Th>
              <Th className="text-right">Total</Th>
              <Th className="w-[110px] text-right">Tax</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-b last:border-0 transition-colors hover:bg-muted/40">
                <Td><StatusCell status={d.status} /></Td>
                <Td className="tabular-nums text-muted-foreground">{d.date}</Td>
                <Td className="font-medium">{d.supplier}</Td>
                <Td>
                  <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                    {d.category}
                  </span>
                </Td>
                <Td className="text-right tabular-nums">
                  {d.total}
                  <span className="ml-1 text-xs text-muted-foreground">{d.currency}</span>
                </Td>
                <Td className="text-right tabular-nums text-muted-foreground">{d.tax}</Td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  <Plus className="mx-auto mb-2 h-5 w-5" strokeWidth={1.5} />
                  Nothing here yet — upload a receipt to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
