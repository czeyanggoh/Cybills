import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { canManageBusiness } from '@/lib/userStore';
import { getMeta, setMetaField } from '@/lib/listsStore';
import { matchSupplierRule, setSupplierRule } from '@/lib/supplierRules';
import { accountCodeFromCategory } from '@/data/xeroAccounts';
import {
  resolveCategorisationOrgId,
  fetchXeroCategories,
  updateXeroCategoryDescription,
} from '@/lib/organisations';

// Offered the moment someone overrules the reader on a document's Category or
// Project. A correction is the only time anyone knows both what was wrong AND
// what the right answer is, so it's the cheapest possible moment to capture a
// rule — far better than remembering to go and edit a list later.
//
// Two shapes of rule, because they answer different questions:
//   - a SUPPLIER rule ("everything from this vendor is X") is deterministic and
//     needs no judgement, so it's offered first
//   - the "when to use" text is the judgement call, edited here pre-filled so a
//     rule that misfired can be sharpened rather than rewritten
//
// Both fields offer both, but the text lives in different places. A project's
// belongs to CYBills (Lists → Projects). A category's is the Xero ACCOUNT's own
// Description — the reader is given it with the chart, and it is the client's
// chart of accounts, so editing it here writes to Xero exactly as the Lists page
// does. That difference is why this used to be a sentence pointing at Business
// settings for categories; it needn't be, so it isn't.
//
// Both rules it offers are BUSINESS settings — a supplier rule is a standing
// policy for everyone's documents, and a category's wording is the client's own
// chart of accounts in Xero — so it is offered on exactly the terms Business
// settings is: `canManageBusiness`, which is Business Admin, and a practice
// colleague, who is a Business Admin inside every entity they hold access to. A
// Standard user (and a User Admin, who runs the roster rather than the business)
// still corrects the document in front of them; they are simply not asked to
// turn that correction into a rule they could not go and edit afterwards. Shown
// to them it would be a button that fails, or worse, one that quietly rewrites
// the chart of accounts from a document page.
export default function TeachRule({ field, value, supplier, onClose }) {
  const { membership, googleEnabled } = useAuth();
  const [mode, setMode] = useState('');
  const [rule, setRule] = useState('');
  const [done, setDone] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // The Xero account behind a category label: null = not looked up yet,
  // 'missing' = no linked org, or a chart that has no such account.
  const [account, setAccount] = useState(null);
  const isCategory = field === 'category';
  const label = isCategory ? 'category' : 'project';
  const code = isCategory ? accountCodeFromCategory(value) : '';
  // "Edit the 4202 rule…" reads better than the whole account label.
  const shortName = (isCategory && code) || value;

  useEffect(() => {
    if (isCategory || !value) return;
    setRule(String(getMeta('projects')[value]?.rules || ''));
  }, [isCategory, value]);

  if (!value) return null;
  if (!canManageBusiness(membership, googleEnabled)) return null;
  const vendor = String(supplier || '').trim();
  const already = vendor ? matchSupplierRule(vendor)[field] : '';

  const saveVendorRule = () => {
    setSupplierRule(vendor, { [field]: value });
    setDone(`Saved — documents from ${vendor} will use ${value}.`);
  };

  // Fetch the account's current description only when asked for it — a
  // correction is usually dismissed or turned into a supplier rule, and neither
  // of those should cost a round trip to Xero.
  const openRuleEditor = async () => {
    setMode('rule');
    setError('');
    if (!isCategory || account) return;
    const orgId = await resolveCategorisationOrgId().catch(() => '');
    if (!orgId) { setAccount('missing'); return; }
    const rows = await fetchXeroCategories(orgId).catch(() => []);
    const match = code ? rows.find((c) => c.code === code) : rows.find((c) => c.name === value);
    if (!match) { setAccount('missing'); return; }
    setAccount({ ...match, orgId });
    setRule(String(match.description || ''));
  };

  const saveRule = async () => {
    if (!isCategory) {
      setMetaField('projects', value, 'rules', rule.trim());
      setDone(`Saved — the ${value} rule is updated.`);
      return;
    }
    if (!account || account === 'missing') return;
    setSaving(true);
    setError('');
    try {
      await updateXeroCategoryDescription(account.orgId, account.id, {
        name: account.name,
        code: account.code,
        description: rule.trim(),
      });
      setDone(`Saved to Xero — ${shortName}'s description is updated, and the reader will use it from the next read.`);
    } catch (err) {
      setError((err && err.message) || 'Could not save that to Xero. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const loading = isCategory && mode === 'rule' && account === null;
  const unavailable = isCategory && account === 'missing';

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
                {isCategory && !unavailable && (
                  <>
                    {' '}It is this account&apos;s <span className="font-medium text-foreground">description in Xero</span>,
                    so saving updates the chart of accounts too.
                  </>
                )}
              </p>
              {loading ? (
                <p className="text-muted-foreground">Loading this account&apos;s description from Xero…</p>
              ) : unavailable ? (
                <p className="text-muted-foreground">
                  A category&apos;s wording is its Xero account description, and this account isn&apos;t in the
                  linked chart (or no organisation is linked yet). Edit it under Business settings → Lists →
                  Categories, or put the rule in your Review instructions.
                </p>
              ) : (
                <textarea
                  rows={3}
                  value={rule}
                  onChange={(e) => setRule(e.target.value)}
                  placeholder={
                    isCategory
                      ? 'e.g. “Staff meals and internal meetings — food for our own people, not for clients”'
                      : 'e.g. “Documents for this site, client or cost centre”'
                  }
                  className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              )}
              {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
              <div className="mt-2 flex gap-2">
                {!loading && !unavailable && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={saveRule}
                    className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save rule'}
                  </button>
                )}
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
                <button type="button" onClick={openRuleEditor} className="inline-flex h-8 items-center rounded-md border px-3 text-sm transition-colors hover:bg-muted">
                  Edit the {shortName} rule…
                </button>
              </div>
              {isCategory && (
                <p className="mt-2 text-xs text-muted-foreground">
                  For wording that spans several accounts, use your Review instructions under Business settings →
                  Lists.
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
