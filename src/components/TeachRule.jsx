import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { getMeta, setMetaField } from '@/lib/listsStore';
import { matchSupplierRule, setSupplierRule } from '@/lib/supplierRules';

// Offered the moment someone overrules the reader on a document's Category or
// Project. A correction is the only time anyone knows both what was wrong AND
// what the right answer is, so it's the cheapest possible moment to capture a
// rule — far better than remembering to go and edit a list later.
//
// Two shapes of rule, because they answer different questions:
//   - a SUPPLIER rule ("everything from this vendor is X") is deterministic and
//     needs no judgement, so it's offered first
//   - a PROJECT's own "when to use" text is the judgement call, edited here
//     pre-filled so a rule that misfired can be sharpened rather than rewritten
export default function TeachRule({ field, value, supplier, onClose }) {
  const [mode, setMode] = useState('');
  const [rule, setRule] = useState('');
  const [done, setDone] = useState('');
  const label = field === 'project' ? 'project' : 'category';

  useEffect(() => {
    if (field !== 'project' || !value) return;
    setRule(String(getMeta('projects')[value]?.rules || ''));
  }, [field, value]);

  if (!value) return null;
  const vendor = String(supplier || '').trim();
  const already = vendor ? matchSupplierRule(vendor)[field] : '';

  const saveVendorRule = () => {
    setSupplierRule(vendor, { [field]: value });
    setDone(`Saved — documents from ${vendor} will use ${value}.`);
  };
  const saveProjectRule = () => {
    setMetaField('projects', value, 'rules', rule.trim());
    setDone(`Saved — the ${value} rule is updated.`);
  };

  return (
    <div className="mt-2 rounded-md border border-foreground/20 bg-muted/40 px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          {done ? (
            <p className="text-foreground">{done}</p>
          ) : mode === 'rule' ? (
            <div>
              <p className="mb-1.5 text-muted-foreground">
                When should <span className="font-medium text-foreground">{value}</span> be used? This is the rule
                the reader follows — sharpen it so the same mistake isn&apos;t made again.
              </p>
              <textarea
                rows={3}
                value={rule}
                onChange={(e) => setRule(e.target.value)}
                placeholder="e.g. “Documents for this site, client or cost centre”"
                className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={saveProjectRule} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90">Save rule</button>
                <button type="button" onClick={() => setMode('')} className="inline-flex h-8 items-center rounded-md border px-3 text-sm hover:bg-muted">Back</button>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-muted-foreground">
                You changed the {label} to <span className="font-medium text-foreground">{value}</span>. Remember
                this for next time?
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {vendor && (
                  <button
                    type="button"
                    onClick={saveVendorRule}
                    title={already && already !== value ? `Replaces the current rule (${already})` : ''}
                    className="inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors hover:bg-muted"
                  >
                    Always use {value} for {vendor}
                    {already && already !== value ? ' (replaces the current rule)' : ''}
                  </button>
                )}
                {field === 'project' && (
                  <button type="button" onClick={() => setMode('rule')} className="inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors hover:bg-muted">
                    Edit the {value} rule…
                  </button>
                )}
              </div>
              {field === 'category' && (
                <p className="mt-2 text-xs text-muted-foreground">
                  For wording that applies across suppliers, edit the account&apos;s description or your Review
                  instructions under Business settings → Lists.
                </p>
              )}
            </div>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="Dismiss" className="text-muted-foreground transition-colors hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
