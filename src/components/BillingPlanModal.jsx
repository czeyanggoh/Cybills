import { useEffect, useState } from 'react';
import { Info, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';
import SearchSelect from '@/components/SearchSelect';
import { fetchBillingPlanDraft } from '@/lib/bills';
import { fileForDoc } from '@/lib/reRead';
import { getExtractionAccounts } from '@/lib/organisations';
import { planProblems, stageTotalCents } from '@/lib/billingPlan';
import { deleteBillingPlan, saveBillingPlan } from '@/lib/billingPlans';

// The billing plan dialog: what a supplier's quotation says its invoices will be
// made of (src/lib/billingPlan.js). Stages, each with the lines of ONE invoice;
// CYBills drafts them off the quotation and a person confirms the coding.

const inputCls =
  'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring';

let seq = 0;
const key = () => `k${Date.now().toString(36)}${(seq += 1)}`;
const emptyLine = () => ({ key: key(), description: '', amount: '', category: '', project: '', project2: '', taxRate: '' });
const emptyStage = (name) => ({ id: key(), name, from: '', to: '', lines: [emptyLine()] });
const toForm = (plan) => ({
  id: plan?.id || '',
  supplier: plan?.supplier || '',
  reference: plan?.reference || '',
  currency: plan?.currency || '',
  sourceBillId: plan?.sourceBillId || '',
  stages: plan?.stages?.length
    ? plan.stages.map((s) => ({
        ...emptyStage(''),
        ...s,
        id: s.id || key(),
        lines: (s.lines || []).map((l) => ({ ...emptyLine(), ...l, amount: l.amount ? String(l.amount) : '' })),
      }))
    : [emptyStage('Subscription')],
});

function Labelled({ label, className = '', children }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export default function BillingPlanModal({
  open,
  plan,
  // The document it is opened from, whose file the draft is read off.
  doc,
  categoryOptions = [],
  projectOptions = [],
  project2Options = [],
  projectLabel = 'Project',
  project2Label = 'Project 2',
  taxRateOptions = [],
  visionEnabled = false,
  onClose,
  onSaved,
}) {
  const [form, setForm] = useState(() => toForm(plan));
  const [notes, setNotes] = useState([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(toForm(plan));
    setNotes([]);
    setError('');
    setTried(false);
    // Only when it is OPENED: the caller rebuilds a new plan's object on every
    // render, which must not reset what is being typed.
  }, [open, plan?.id, doc?.id]);

  if (!open) return null;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setStage = (id, patch) =>
    setForm((f) => ({ ...f, stages: f.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const setLine = (stageId, lineKey, patch) =>
    setForm((f) => ({
      ...f,
      stages: f.stages.map((s) =>
        s.id !== stageId ? s : { ...s, lines: s.lines.map((l) => (l.key === lineKey ? { ...l, ...patch } : l)) }
      ),
    }));

  const draft = async () => {
    setReading(true);
    setError('');
    try {
      const rec = await fileForDoc(doc);
      if (!rec) throw new Error('This document has no file to read.');
      const { plan: read, notes: said } = await fetchBillingPlanDraft(rec.base64, rec.mediaType, await getExtractionAccounts('cost'));
      if (!read?.stages?.length) throw new Error('No billing stages found on this document — enter them below.');
      setForm((f) =>
        toForm({
          ...read,
          id: f.id,
          sourceBillId: doc.id,
          // The supplier as this book spells it, which is what invoices are filed under.
          supplier: f.supplier || read.supplier,
        })
      );
      setNotes(said);
    } catch (e) {
      setError(e.message || 'Could not read a billing plan off this document.');
    } finally {
      setReading(false);
    }
  };

  const problems = planProblems(form);
  const save = () => {
    setTried(true);
    if (problems.length) return;
    const saved = saveBillingPlan(form);
    onSaved?.(saved);
    onClose();
  };
  const remove = () => {
    if (!window.confirm('Delete this billing plan? Invoices already coded from it keep their lines.')) return;
    deleteBillingPlan(form.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Billing plan: {form.supplier || 'Supplier'}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-auto p-6">
          <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Set out what each invoice from this supplier is expected to come to, and how it divides. An invoice that
              agrees to the cent is written as these lines when it is read. One that differs is left as it is and says
              what was expected.
            </span>
          </p>

          {doc?.hasFile && visionEnabled && (
            <button
              type="button"
              onClick={draft}
              disabled={reading}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-60"
            >
              {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {reading ? 'Reading…' : 'Draft from this document'}
            </button>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {notes.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-medium">Check before saving</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_14rem_6rem]">
            <Labelled label="Supplier">
              <input value={form.supplier} onChange={(e) => set({ supplier: e.target.value })} className={inputCls} />
            </Labelled>
            <Labelled label="Quotation / agreement no.">
              <input value={form.reference} onChange={(e) => set({ reference: e.target.value })} className={inputCls} />
            </Labelled>
            <Labelled label="Currency">
              <input value={form.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase().slice(0, 3) })} className={inputCls} />
            </Labelled>
          </div>

          {form.stages.map((s) => (
            <div key={s.id} className="space-y-3 rounded-lg border p-4">
              <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_11rem_11rem_auto]">
                <Labelled label="Stage">
                  <input value={s.name} onChange={(e) => setStage(s.id, { name: e.target.value })} placeholder="e.g. Subscription" className={inputCls} />
                </Labelled>
                <Labelled label="Invoices dated from">
                  <input type="date" value={s.from} onChange={(e) => setStage(s.id, { from: e.target.value })} className={inputCls} />
                </Labelled>
                <Labelled label="to">
                  <input type="date" value={s.to} onChange={(e) => setStage(s.id, { to: e.target.value })} className={inputCls} />
                </Labelled>
                <button
                  type="button"
                  onClick={() => set({ stages: form.stages.filter((x) => x.id !== s.id) })}
                  disabled={form.stages.length === 1}
                  title="Remove this stage"
                  aria-label={`Remove stage ${s.name}`}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {s.lines.map((l) => (
                <div key={l.key} className="space-y-2 rounded-md bg-muted/40 p-3">
                  <div className="grid grid-cols-[1fr_9rem_auto] gap-2">
                    <input value={l.description} onChange={(e) => setLine(s.id, l.key, { description: e.target.value })} placeholder="What this part is for" aria-label="Line description" className={inputCls} />
                    <input value={l.amount} onChange={(e) => setLine(s.id, l.key, { amount: e.target.value })} inputMode="decimal" placeholder="Amount" aria-label="Line amount" className={`${inputCls} text-right tabular-nums`} />
                    <button
                      type="button"
                      onClick={() => setStage(s.id, { lines: s.lines.filter((x) => x.key !== l.key) })}
                      disabled={s.lines.length === 1}
                      aria-label="Remove line"
                      title="Remove line"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-muted disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <Labelled label="Category">
                      <SearchSelect value={l.category} options={categoryOptions} onChange={(v) => setLine(s.id, l.key, { category: v })} />
                    </Labelled>
                    {taxRateOptions.length > 0 && (
                      <Labelled label="Tax rate">
                        <SearchSelect value={l.taxRate} options={taxRateOptions} placeholder="Same as the invoice" onChange={(v) => setLine(s.id, l.key, { taxRate: v })} />
                      </Labelled>
                    )}
                    {projectOptions.length > 0 && (
                      <Labelled label={projectLabel}>
                        <SearchSelect value={l.project} options={projectOptions} onChange={(v) => setLine(s.id, l.key, { project: v })} />
                      </Labelled>
                    )}
                    {project2Options.length > 0 && (
                      <Labelled label={project2Label}>
                        <SearchSelect value={l.project2} options={project2Options} onChange={(v) => setLine(s.id, l.key, { project2: v })} />
                      </Labelled>
                    )}
                  </div>
                </div>
              ))}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  // A new line starts as the last one's coding: splitting by outlet
                  // is the same account again with another project.
                  onClick={() => setStage(s.id, { lines: [...s.lines, { ...(s.lines[s.lines.length - 1] || emptyLine()), key: key(), amount: '' }] })}
                  className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 hover:underline"
                >
                  <Plus className="h-4 w-4" /> Add line
                </button>
                <p className="text-sm text-muted-foreground">
                  Each invoice comes to{' '}
                  <span className="font-semibold tabular-nums text-foreground">
                    {form.currency} {(stageTotalCents(s) / 100).toFixed(2)}
                  </span>
                </p>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => set({ stages: [...form.stages, emptyStage(`Stage ${form.stages.length + 1}`)] })}
            className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 hover:underline"
          >
            <Plus className="h-4 w-4" /> Add stage
          </button>
          {tried && problems.length > 0 && (
            <ul className="space-y-0.5 text-sm text-destructive">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={remove}
            disabled={!form.id}
            className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            Delete plan
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
            <button type="button" onClick={save} disabled={reading} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              Save plan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
