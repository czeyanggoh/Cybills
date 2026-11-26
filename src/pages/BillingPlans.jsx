import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Pencil, Plus, TriangleAlert } from 'lucide-react';
import AppShell from '@/components/AppShell';
import CostsSubnav from '@/components/CostsSubnav';
import BillingPlanModal from '@/components/BillingPlanModal';
import { isPlanSource, planOverview, progressText } from '@/lib/billingPlan';
import { billingPlansReady, useBillingPlans } from '@/lib/billingPlans';
import { costPath, useDocumentSuppliers } from '@/lib/bills';
import { mergeSupplierNames, addedSuppliers, withoutRemovedSuppliers, useSupplierList } from '@/lib/supplierList';
import { useCostsDocs } from '@/lib/costsData';
import { useBaseCurrency, useGstRegistered } from '@/lib/businessProfile';
import { useCategoryOptions, useVisibleTaxRates, useXeroProjectOptions, useXeroSuppliers } from '@/lib/organisations';
import { useProjectLabels } from '@/lib/projectLabels';
import { xeroPaidStatus } from '@/lib/xeroPaidStatus';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/date';
import { cn } from '@/lib/utils';

// Costs -> Billing plans: every supplier's quoted future charges and how far each
// has got — what has been invoiced, what is still to come, and the bills a plan
// does not explain. The counting is src/lib/billingPlan.js (planOverview). A plan
// is recorded from its quotation on the document page, or typed here where there
// is no paper for it.

const money = (currency, c) =>
  `${currency ? `${currency} ` : ''}${(c / 100).toLocaleString('en-SG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "Project" / "Outlet" from a list's own label ("Projects", "Outlets").
const singular = (label) => String(label || 'Project').replace(/s$/i, '');

const inXero = (doc) =>
  doc.xeroInvoiceId ? xeroPaidStatus(doc)?.label || 'In Xero' : doc.paperworkMatch ? 'In Xero' : 'Not published';

const span = (stage) => {
  if (stage.from && stage.to) return `invoices dated ${formatDate(stage.from)} to ${formatDate(stage.to)}`;
  if (stage.from) return `invoices dated from ${formatDate(stage.from)}`;
  if (stage.to) return `invoices dated up to ${formatDate(stage.to)}`;
  return '';
};

function Bar({ billed, quantity, over }) {
  const width = Math.min(100, (billed / quantity) * 100);
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={quantity}
      aria-valuenow={Math.min(billed, quantity)}
      aria-label="Invoices billed"
    >
      <div className={cn('h-full rounded-full', over ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${width}%` }} />
    </div>
  );
}

function Stage({ row, currency }) {
  const { stage, progress, eachCents, invoicedCents, invoices } = row;
  return (
    <div className="space-y-2 px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-medium">{stage.name}</h3>
        <p className="text-sm text-muted-foreground">
          {money(currency, eachCents)} an invoice{span(stage) ? ` · ${span(stage)}` : ''}
        </p>
      </div>
      {progress.quantity > 0 && <Bar billed={progress.billed} quantity={progress.quantity} over={progress.over} />}
      <p className={cn('text-sm', progress.over ? 'font-medium text-amber-700' : '')}>
        {progressText(progress, stage, currency) ||
          `${progress.billed} billed. Edit the plan and enter the number of invoices to see how many are left.`}
      </p>
      <p className="text-xs text-muted-foreground">
        Invoiced in CYBills: {money(currency, invoicedCents)}
        {progress.billedBefore > 0 ? ` · ${progress.billedBefore} more billed before, not in CYBills` : ''}
      </p>
      {invoices.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Invoice</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Coding</th>
                <th className="px-3 py-2 font-medium">Xero</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(({ doc, place, coded }) => (
                <tr key={doc.id} className="border-t">
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{place}</td>
                  <td className="whitespace-nowrap px-3 py-2">{formatDate(doc.date)}</td>
                  <td className="px-3 py-2">
                    <Link to={costPath(doc)} className="font-medium text-emerald-700 hover:underline">
                      {doc.invoiceNumber || `Item ${doc.displayId}`}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {money(doc.currency, Math.round(Number(doc.total) * 100) || 0)}
                  </td>
                  <td className={cn('px-3 py-2', !coded && 'text-muted-foreground')}>
                    {coded ? 'Split by the plan' : 'Not split by the plan'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{inXero(doc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function BillingPlans() {
  const plans = useBillingPlans();
  const { allDocs, loaded } = useCostsDocs();
  const { visionEnabled, membership, googleEnabled } = useAuth();
  const mayEdit = !googleEnabled || Boolean(membership?.admin);
  const [editing, setEditing] = useState(null);
  const categoryOptions = useCategoryOptions('cost');
  const projectOptions = useXeroProjectOptions(0);
  const project2Options = useXeroProjectOptions(1);
  const projectLabels = useProjectLabels();
  const taxRates = useVisibleTaxRates('cost');
  const gstRegistered = useGstRegistered();
  const baseCurrency = useBaseCurrency();
  useSupplierList();
  const supplierOptions = withoutRemovedSuppliers(
    mergeSupplierNames(useXeroSuppliers(), [...useDocumentSuppliers(), ...addedSuppliers()])
  );

  const ready = loaded && (plans.length > 0 || billingPlansReady());
  const sorted = [...plans].sort((a, b) => String(a.supplier).localeCompare(String(b.supplier)));

  return (
    <AppShell subnav={<CostsSubnav />}>
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Billing plans</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              What each supplier’s quotation or agreement says it will invoice, and how far that has got.
            </p>
          </div>
          {mayEdit && (
            <button
              type="button"
              onClick={() => setEditing({ currency: baseCurrency })}
              disabled={!ready}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> New billing plan
            </button>
          )}
        </div>

        {!ready ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !sorted.length ? (
          <div className="rounded-lg border border-dashed px-5 py-10 text-center text-sm text-muted-foreground">
            No billing plans yet. Open a supplier’s quotation in <Link to="/costs" className="font-medium text-emerald-700 hover:underline">Costs</Link> and
            click <span className="font-medium text-foreground">Record billing plan</span>, or, with no document for it, click{' '}
            <span className="font-medium text-foreground">New billing plan</span>.
          </div>
        ) : (
          sorted.map((plan) => {
            const view = planOverview(plan, allDocs, plans);
            const source = allDocs.find((d) => d.id === plan.sourceBillId && isPlanSource(d));
            return (
              <section key={plan.id} className="overflow-hidden rounded-lg border bg-background">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
                  <div>
                    <h2 className="font-semibold">{plan.supplier}</h2>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                      {plan.reference && <span>{plan.reference}</span>}
                      {source && (
                        <Link to={costPath(source)} className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                          Open quotation <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                      )}
                      {view.leftCents != null && <span>Still to come: {money(plan.currency, view.leftCents)}</span>}
                    </p>
                  </div>
                  {mayEdit && (
                    <button
                      type="button"
                      onClick={() => setEditing(plan)}
                      className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
                    >
                      <Pencil className="h-4 w-4" /> Edit plan
                    </button>
                  )}
                </div>
                <div className="divide-y">
                  {view.stages.map((row) => <Stage key={row.stage.id} row={row} currency={plan.currency} />)}
                </div>
                {view.differing.length > 0 && (
                  <div className="border-t bg-amber-50 px-5 py-4">
                    <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                      <TriangleAlert className="h-4 w-4" /> Differs from the plan
                    </h3>
                    <ul className="mt-2 space-y-1 text-sm text-amber-900">
                      {view.differing.map(({ doc, reason }) => (
                        <li key={doc.id}>
                          <Link to={costPath(doc)} className="font-medium underline-offset-2 hover:underline">
                            {doc.invoiceNumber || `Item ${doc.displayId}`}
                          </Link>
                          {' '}({formatDate(doc.date) || 'undated'}): {reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      <BillingPlanModal
        open={Boolean(editing)}
        plan={editing}
        doc={allDocs.find((d) => d.id === editing?.sourceBillId && isPlanSource(d)) ?? null}
        docs={allDocs}
        supplierOptions={supplierOptions}
        categoryOptions={categoryOptions.filter((c) => c !== 'Uncategorised')}
        projectOptions={projectOptions}
        project2Options={project2Options}
        projectLabel={singular(projectLabels.project)}
        project2Label={singular(projectLabels.project2)}
        taxRateOptions={gstRegistered ? taxRates.map((t) => t.name) : []}
        visionEnabled={visionEnabled}
        onClose={() => setEditing(null)}
      />
    </AppShell>
  );
}
