import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Flag,
  Image,
  Search,
  Settings2,
  Plus,
  FileText,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import ClaimExportModal from '@/components/ClaimExportModal';
import ClaimEmailModal from '@/components/ClaimEmailModal';
import ClaimApprovalModal from '@/components/ClaimApprovalModal';
import { useClaims, submitForApproval } from '@/lib/claimStore';
import { useAuth } from '@/lib/auth';
import { CATEGORIES } from '@/data/categories';
import { generateClaimPdf } from '@/lib/claimPdf';
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

function DetailField({ label, children }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="w-32 shrink-0 pt-2 text-sm text-muted-foreground">{label}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Input({ value, readOnly = false }) {
  // Read-only fields stay controlled; editable ones are uncontrolled
  // (defaultValue) so the user can type without wiring per-field state.
  const common = cn(
    'h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
    readOnly ? 'bg-muted text-muted-foreground' : 'bg-background'
  );
  return readOnly ? (
    <input value={value} readOnly className={common} />
  ) : (
    <input defaultValue={value} className={common} />
  );
}

function CategorySelect({ value, onChange }) {
  const known = CATEGORIES.includes(value);
  return (
    <div className="relative w-40">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full appearance-none rounded-md border bg-background px-2.5 pr-7 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {!known && value && <option value={value}>{value}</option>}
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export default function ExpenseClaimDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const claims = useClaims();
  const claim = claims.find((c) => String(c.id) === String(id)) || null;
  const [tab, setTab] = useState('details');
  const [catOverrides, setCatOverrides] = useState({});
  const [exportMenu, setExportMenu] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);

  const index = claims.findIndex((c) => String(c.id) === String(id));
  const go = (delta) => {
    const next = claims[index + delta];
    if (next) navigate(`/expense-claims/${next.id}`);
  };

  if (!claim) {
    return (
      <AppShell subnav={<CostsSubnav />}>
        <p className="text-sm text-muted-foreground">Expense claim not found.</p>
      </AppShell>
    );
  }

  // Apply any in-session category tweaks on top of the stored line items.
  const rows = claim.transactions.map((t) =>
    catOverrides[t.itemId] ? { ...t, category: catOverrides[t.itemId] } : t
  );
  const setRowCategory = (itemId, category) =>
    setCatOverrides((o) => ({ ...o, [itemId]: category }));

  return (
    <AppShell subnav={<CostsSubnav />}>
      {/* Action bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TopButton subtle onClick={() => navigate('/expense-claims')}>
          <ChevronLeft className="h-4 w-4" /> Back
        </TopButton>
        <Flag className="mx-1 h-4 w-4 text-muted-foreground" />
        <TopButton onClick={() => setApprovalOpen(true)}>Submit for approval</TopButton>
        <TopButton onClick={() => navigate('/expense-claims')}>Archive</TopButton>
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
        <TopButton danger onClick={() => navigate('/expense-claims')}>Delete claim</TopButton>
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
        <div className="min-w-0 rounded-lg border p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{claim.claimFor}&rsquo;s Expense Claim</h1>
              <div className="mt-3 space-y-1 text-sm">
                <p>
                  <span className="text-muted-foreground">Claim name&nbsp;&nbsp;</span>
                  <span className="font-medium">{claim.name}</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Claim date&nbsp;&nbsp;</span>
                  <span className="font-medium">{claim.claimDate}</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Expense total&nbsp;&nbsp;</span>
                  <span className="font-medium">
                    {claim.currency} {claim.total} ( Incl. Tax: {claim.tax} )
                  </span>
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => generateClaimPdf({ ...claim, transactions: rows })}
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
            >
              <FileText className="h-4 w-4" strokeWidth={1.75} />
              PDF preview
            </button>
          </div>

          {/* Line-item toolbar */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/costs')}
              title="Open the Costs inbox, then use “Add to expense claim” on the items you want"
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" /> Add items
            </button>
            <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm text-muted-foreground/60" disabled>
              Actions <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <div className="relative ml-auto hidden sm:block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input type="text" placeholder="Search" className="h-8 w-44 rounded-md border bg-background pl-8 pr-16 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
              <button type="button" className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground">
                Advanced <ChevronDown className="h-3 w-3" />
              </button>
            </div>
            <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Table settings">
              <Settings2 className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>

          {/* Line items */}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr className="text-muted-foreground">
                  <th className="w-28 px-3 py-2.5"><span className="sr-only">Select</span></th>
                  <th className="px-3 py-2.5 font-medium">Supplier</th>
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Category</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr
                    key={t.itemId}
                    onClick={() => navigate(`/costs/${t.itemId}`)}
                    className="cursor-pointer border-b last:border-0 transition-colors hover:bg-muted/40"
                  >
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1.5">
                        <input type="checkbox" className="h-4 w-4 accent-black" />
                        <Flag className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={1.75} />
                        <Image className="h-3.5 w-3.5 text-muted-foreground/60" strokeWidth={1.75} />
                        <span className="rounded bg-foreground px-2 py-0.5 text-xs text-background">Ready</span>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">{t.supplier}</td>
                    <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{t.date}</td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <CategorySelect value={t.category} onChange={(v) => setRowCategory(t.itemId, v)} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/20">
                  <td colSpan={3} className="px-3 py-3 text-right text-sm font-medium">Expense total</td>
                  <td className="px-3 py-3 text-sm font-semibold tabular-nums">
                    {claim.currency} {claim.total}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-center text-xs text-muted-foreground">
            Showing {rows.length} of {rows.length} items
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
              <DetailField label="Claim ID"><Input value={claim.id} readOnly /></DetailField>
              <DetailField label="Claim for"><Input value={claim.claimFor} /></DetailField>
              <DetailField label="Claim name"><Input value={claim.name} /></DetailField>
              <DetailField label="End date"><Input value={claim.endDate} /></DetailField>
              <DetailField label="Currency"><Input value={`${claim.currency} — Singapore, Dollars`} /></DetailField>
              <DetailField label="Claim description">
                <textarea rows={2} className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
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
                      <p className="mt-0.5 text-xs text-muted-foreground">{e.at}</p>
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
        defaultName={user?.name || 'Astrid Yang'}
      />
      <ClaimApprovalModal
        open={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        onSubmit={(approver) => {
          submitForApproval(claim.id, approver, user?.name || 'Astrid Yang');
          setApprovalOpen(false);
          setTab('history');
        }}
      />
    </AppShell>
  );
}
