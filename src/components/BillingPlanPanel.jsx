import { CalendarClock, Check, TriangleAlert } from 'lucide-react';
import { billingPlanPatch, billingPlanStatus, planLabel, plansForSupplier, progressText, stageProgress, stageTotalCents, takesBillingPlan } from '@/lib/billingPlan';
import { isAdvanceDocument } from '@/lib/prepayment';
import { cn } from '@/lib/utils';

// Where a document stands against its supplier's billing plan, on the document
// page (src/lib/billingPlan.js has the rules).
//
// On a QUOTATION (or pro-forma, or an agreement read as Other): record the plan,
// or see and edit the one recorded. On an INVOICE from a supplier with a plan:
// coded from it, ready to apply, or what the plan expected instead. Renders
// nothing otherwise.

const actionCls =
  'inline-flex h-9 items-center rounded-md border-2 border-foreground px-4 text-sm font-semibold transition-colors hover:bg-muted';
const linkCls = 'text-sm text-muted-foreground underline-offset-2 hover:underline';

export default function BillingPlanPanel({ doc, plans, docs = [], rates, published, mayEdit, onEdit, onApply }) {
  if (!doc?.persisted || (doc.kind && doc.kind !== 'cost')) return null;
  const mine = plansForSupplier(doc.supplier, plans);
  const type = String(doc.type || '').toLowerCase();
  const source = isAdvanceDocument(doc.type) || type === 'other';
  // The book with this document as it stands on screen. Counted for an admin
  // only: somebody who sees just their own documents would count short.
  const book = mayEdit ? [...docs.filter((d) => d.id !== doc.id), doc] : [];

  if (source) {
    if (!mine.length && !mayEdit) return null;
    return (
      <div className="rounded-lg border bg-background p-4">
        <div className="mb-2 flex items-center gap-2 text-base font-semibold">
          <CalendarClock className="h-5 w-5" strokeWidth={1.75} />
          Billing plan
        </div>
        {mine.length ? (
          <div className="space-y-3 text-sm">
            {mine.map((p) => (
              <div key={p.id} className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{planLabel(p)}</span>
                  {mayEdit && <button type="button" className={linkCls} onClick={() => onEdit(p)}>Edit</button>}
                </div>
                {p.stages.map((s) => {
                  const run = mayEdit ? progressText(stageProgress(p, s, book), s, p.currency) : '';
                  return (
                    <p key={s.id} className="text-muted-foreground">
                      {s.name} · {(stageTotalCents(s) / 100).toFixed(2)} an invoice{run ? ` · ${run}` : ''}
                    </p>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Does this set out what later invoices will charge? Record it, and each invoice that agrees is split and
              coded as you set it here.
            </p>
            <button type="button" className={actionCls} onClick={() => onEdit(null)}>Record billing plan</button>
          </div>
        )}
      </div>
    );
  }

  if (!mine.length || !takesBillingPlan({ ...doc, documentType: doc.type })) return null;
  const status = billingPlanStatus({ ...doc, documentType: doc.type }, plans, { rates });
  if (!status) return null;
  const applied = status.status === 'applied';
  const match = status.status === 'match';
  // A published bill is in the ledger; what is left to say is only that it
  // followed the plan.
  if (published && !applied) return null;
  // Where this invoice sits in its stage's run, and what is still to come.
  const progress = mayEdit && (applied || match) ? stageProgress(status.plan, status.stage, book) : null;
  const nth = progress ? progress.invoices.findIndex((d) => d.id === doc.id) + 1 : 0;
  const run = progress ? progressText(progress, status.stage, status.plan.currency) : '';
  const place = nth ? progress.billedBefore + nth : 0;
  const beyond = Boolean(progress?.quantity && place > progress.quantity);

  return (
    <div className="rounded-lg border bg-background p-4">
      <div
        className={cn(
          'flex items-center gap-2 text-base font-semibold',
          applied ? 'text-emerald-700' : match ? '' : 'text-amber-600'
        )}
      >
        {applied ? <Check className="h-5 w-5" /> : match ? <CalendarClock className="h-5 w-5" strokeWidth={1.75} /> : <TriangleAlert className="h-5 w-5" strokeWidth={1.75} />}
        {applied ? 'Coded from the billing plan' : match ? 'Billing plan matches' : 'Differs from the billing plan'}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {applied
          ? `${planLabel(status.plan)}, ${status.stage.name}.`
          : match
            ? `This invoice agrees with ${planLabel(status.plan)}, ${status.stage.name}: ${status.rows.map((r) => `${r.total} to ${r.category}`).join('; ')}.`
            : status.reason}
      </p>
      {run && (
        <p className={cn('mt-1 text-sm', beyond ? 'font-medium text-amber-700' : 'text-muted-foreground')}>
          {place ? `This is invoice ${place}${beyond ? ', more than the plan agrees to' : ''}. ` : ''}
          {run}.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3 empty:hidden">
        {match && (
          <button
            type="button"
            className={actionCls}
            onClick={() => {
              if (doc.lineItems?.length && !window.confirm('Replace the line items on this document with the billing plan’s?')) return;
              onApply(billingPlanPatch(status));
            }}
          >
            Apply billing plan
          </button>
        )}
        {mayEdit && <button type="button" className={linkCls} onClick={() => onEdit(status.plan)}>Edit plan</button>}
      </div>
    </div>
  );
}
