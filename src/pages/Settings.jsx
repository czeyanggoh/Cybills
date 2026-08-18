import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Building2,
  Share2,
  Upload,
  Workflow,
  Check,
  Download,
  ClipboardList,
  LayoutGrid,
  ImagePlus,
  Copy,
  ListChecks,
  Info,
  Mail,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import ListsSettings from '@/components/ListsSettings';
import { cn } from '@/lib/utils';
import { useApprovalReminders, setReminders, DAYS, TIMES } from '@/lib/approvalReminders';
import { useCategoryDisplayMode, setCategoryDisplayMode, useCategorySortMode, setCategorySortMode } from '@/lib/categoryDisplay';
import { useBusinessProfile, saveBusinessProfile, mergeXeroProfile } from '@/lib/businessProfile';
import { useExportSettings, saveExportSettings, EXPORT_COLUMNS } from '@/lib/exportSettings';
import {
  useOrganisations,
  fetchXeroProfile,
  getActiveOrganisationId,
} from '@/lib/organisations';
import { useMailStatus, connectMailbox, disconnectMailbox, sendTestEmail } from '@/lib/mailSettings';

const NAV = [
  {
    group: 'Business settings',
    items: [
      { key: 'business', label: 'Business profile', icon: Building2 },
      { key: 'connections', label: 'Connections', icon: Share2 },
      { key: 'extraction', label: 'Extraction', icon: Upload },
      { key: 'automation', label: 'Automation', icon: Workflow },
      { key: 'approvals', label: 'Approvals', icon: Check },
      { key: 'email', label: 'Email', icon: Mail },
      { key: 'exports', label: 'Exports', icon: Download },
      { key: 'lists', label: 'Lists', icon: ClipboardList },
    ],
  },
  { group: 'Manage', items: [{ key: 'subscription', label: 'Subscription', icon: LayoutGrid }] },
];

function SettingsNav({ active, onSelect }) {
  return (
    <div className="p-3 text-sm">
      {NAV.map((section) => (
        <div key={section.group} className="mb-3">
          <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {section.group}
          </p>
          {section.items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onSelect(item.key)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
                active === item.key
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-4 w-4" strokeWidth={1.75} />
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// --- Reusable form primitives (b&w) ----------------------------------------
function Card({ title, children }) {
  return (
    <section className="overflow-hidden rounded-lg border bg-background">
      {title && (
        <div className="border-b px-5 py-4 text-base font-semibold tracking-tight">{title}</div>
      )}
      <div className="space-y-5 p-5">{children}</div>
    </section>
  );
}

function Row({ label, children, hint = '', required = false }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[240px_1fr] sm:items-start">
      <div className="pt-2">
        <span className="text-sm font-medium">
          {label}
          {required && <span className="text-destructive"> *</span>}
        </span>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function TextInput({ defaultValue = '', value = undefined, onChange = undefined, readOnly = false, placeholder = '' }) {
  const controlled = value !== undefined && onChange;
  return (
    <input
      {...(controlled ? { value, onChange: (e) => onChange(e.target.value) } : { defaultValue })}
      readOnly={readOnly}
      placeholder={placeholder}
      className={cn(
        'h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        readOnly ? 'bg-muted text-muted-foreground' : 'bg-background'
      )}
    />
  );
}

// Controlled when `value`+`onChange` are given, else uncontrolled via defaultValue.
function SelectBox({ defaultValue = undefined, value = undefined, onChange = undefined, options }) {
  const controlled = value !== undefined && onChange;
  return (
    <select
      {...(controlled ? { value, onChange: (e) => onChange(e.target.value) } : { defaultValue })}
      className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

function Toggle({ defaultOn = false, on: onProp = undefined, onChange = undefined }) {
  const controlled = onProp !== undefined && onChange;
  const [onState, setOn] = useState(defaultOn);
  const on = controlled ? onProp : onState;
  const toggle = () => (controlled ? onChange(!onProp) : setOn((v) => !v));
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex items-center gap-2 text-sm"
    >
      <span
        className={cn(
          'flex h-5 w-9 items-center rounded-full p-0.5 transition-colors',
          on ? 'justify-end bg-foreground' : 'justify-start bg-muted'
        )}
      >
        <span className="h-4 w-4 rounded-full bg-background" />
      </span>
      <span className="text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

function CopyRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 font-mono text-foreground">
        <span className="truncate">{value}</span>
        <Copy className="h-3.5 w-3.5 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground" />
      </span>
    </div>
  );
}

function CheckRow({ label, defaultChecked = false, checked = undefined, onChange = undefined }) {
  const controlled = checked !== undefined && onChange;
  const [onState, setOn] = useState(defaultChecked);
  const on = controlled ? checked : onState;
  const toggle = () => (controlled ? onChange(!checked) : setOn((v) => !v));
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={on} onChange={toggle} className="h-4 w-4 accent-black" />
      <span>{label}</span>
    </label>
  );
}

function MiniSelect({ defaultValue, options }) {
  return (
    <select
      defaultValue={defaultValue}
      className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

// --- Sections ---------------------------------------------------------------
function BusinessProfile() {
  const stored = useBusinessProfile();
  const { data: organisations = [] } = useOrganisations();
  const [form, setForm] = useState(stored);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sync, setSync] = useState({ state: 'idle', message: '' }); // idle | loading | ok | error

  // Keep the form in step with the persisted profile until the user edits it.
  useEffect(() => {
    if (!dirty) setForm(stored);
  }, [stored, dirty]);

  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setDirty(true); setSaved(false); };
  const setAddr = (key, value) => {
    setForm((f) => ({ ...f, address: { ...f.address, [key]: value } }));
    setDirty(true); setSaved(false);
  };

  // Which linked org to read from Xero: the active one, else the first.
  const orgId = (organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0])?.id || '';
  const linked = Boolean(orgId);

  const pullFromXero = async () => {
    if (!orgId) { setSync({ state: 'error', message: 'No Xero organisation is linked yet. Link one under Connections first.' }); return; }
    setSync({ state: 'loading', message: '' });
    try {
      const xero = await fetchXeroProfile(orgId);
      if (!xero) { setSync({ state: 'error', message: 'Xero returned no organisation details.' }); return; }
      setForm((f) => mergeXeroProfile(f, xero));
      setDirty(true); setSaved(false);
      setSync({ state: 'ok', message: 'Pulled from Xero. Review, then Save changes.' });
    } catch (err) {
      const code = err?.code || '';
      const message =
        code === 'xero_not_configured' ? 'Xero isn’t connected on the server yet.'
        : code === 'organisation_not_found' ? 'This organisation isn’t linked to a Xero tenant.'
        : err?.message || 'Could not reach Xero.';
      setSync({ state: 'error', message });
    }
  };

  const save = () => { saveBusinessProfile(form); setDirty(false); setSaved(true); };

  // First time in, if a Xero org is linked and the profile has never been
  // synced, pull it automatically so the fields reflect Xero out of the box.
  // One attempt per mount; the user still reviews and Saves.
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || !linked || form.syncedAt || dirty) return;
    autoTried.current = true;
    pullFromXero();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  return (
    <div className="space-y-6">
      <Card title="Upload your logo">
        <div className="flex flex-wrap items-center gap-6">
          <button
            type="button"
            className="flex h-32 w-56 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-muted-foreground transition-colors hover:bg-muted"
          >
            <ImagePlus className="h-6 w-6" strokeWidth={1.5} />
            <span className="text-xs font-medium">UPLOAD LOGO</span>
          </button>
          <div className="text-sm text-muted-foreground">
            <p>Max. size: 1 MB</p>
            <p>Min. dimension: 100 × 60 pixels</p>
            <p>Formats: JPEG or PNG</p>
          </div>
        </div>
      </Card>

      <Card title="Business profile">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {form.syncedAt
              ? `Registration details last synced from Xero on ${new Date(form.syncedAt).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short' })}.`
              : 'Pull the registration details straight from your connected Xero organisation.'}
          </p>
          <button
            type="button"
            onClick={pullFromXero}
            disabled={sync.state === 'loading'}
            className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={cn('h-4 w-4', sync.state === 'loading' && 'animate-spin')} />
            {sync.state === 'loading' ? 'Updating…' : 'Update from Xero'}
          </button>
        </div>
        {sync.message && (
          <p className={cn('text-xs', sync.state === 'error' ? 'text-destructive' : 'text-muted-foreground')}>{sync.message}</p>
        )}
        {!linked && (
          <p className="text-xs text-muted-foreground">No Xero organisation is linked yet — add one under <span className="font-medium">Connections</span> to enable syncing.</p>
        )}

        <Row label="CRN"><TextInput value={form.crn} onChange={(v) => set('crn', v)} placeholder="Company registration no." /></Row>
        <Row label="Business name" required><TextInput value={form.businessName} onChange={(v) => set('businessName', v)} /></Row>
        <Row label="Tax / GST number"><TextInput value={form.taxNumber} onChange={(v) => set('taxNumber', v)} placeholder="—" /></Row>
        <Row label="Practice code"><TextInput value={form.practiceCode} onChange={(v) => set('practiceCode', v)} /></Row>
        <Row label="Country of registration" required>
          <SelectBox value={form.country} onChange={(v) => set('country', v)} options={['Singapore', 'Malaysia', 'United Kingdom', 'Australia']} />
        </Row>
        <Row label="Base currency">
          <SelectBox value={form.baseCurrency} onChange={(v) => set('baseCurrency', v)} options={['SGD — Singapore, Dollars', 'USD — US, Dollars', 'MYR — Malaysian, Ringgit', 'GBP — British, Pounds']} />
        </Row>
        <Row label="Account language">
          <SelectBox value={form.language} onChange={(v) => set('language', v)} options={['English', 'Chinese', 'Malay']} />
        </Row>
        <Row label="Industry">
          <SelectBox value={form.industry} onChange={(v) => set('industry', v)} options={['IT and Computer Services', 'Professional Services', 'Retail', 'Construction', 'Other']} />
        </Row>
      </Card>

      <Card title="Registered address">
        <Row label="Address line 1"><TextInput value={form.address.line1} onChange={(v) => setAddr('line1', v)} /></Row>
        <Row label="Address line 2"><TextInput value={form.address.line2} onChange={(v) => setAddr('line2', v)} /></Row>
        <Row label="City/town"><TextInput value={form.address.city} onChange={(v) => setAddr('city', v)} /></Row>
        <Row label="Postal/zip code"><TextInput value={form.address.postalCode} onChange={(v) => setAddr('postalCode', v)} /></Row>
        <Row label="Country"><TextInput value={form.address.country} onChange={(v) => setAddr('country', v)} /></Row>
      </Card>

      <Card title="Item messaging">
        <Row
          label="Use company name"
          hint="Sign-off messages to clients with your company name rather than the signed-in user."
        >
          <Toggle />
        </Row>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
        <button
          type="button"
          onClick={save}
          disabled={!dirty}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Save changes
        </button>
      </div>
    </div>
  );
}

function Extraction() {
  return (
    <div className="space-y-6">
      <Card title="Extract by Email">
        <p className="text-sm text-muted-foreground">
          Add documents to your account by emailing them to the addresses below.
        </p>
        <Row label="Your email address begins with"><TextInput defaultValue="cybm.costs" /></Row>
        <div className="rounded-md border p-4">
          <p className="mb-2 text-sm font-medium">Costs</p>
          <p className="mb-3 text-xs text-muted-foreground">
            Give these to suppliers so they can email invoices straight in.
          </p>
          <div className="space-y-2">
            <CopyRow label="Single documents" value="cybm.costs@dext.cc" />
            <CopyRow label="Multiple documents" value="cybm.costs@multiple.dext.cc" />
          </div>
        </div>
        <div className="rounded-md border p-4">
          <p className="mb-3 text-sm font-medium">Sales</p>
          <div className="space-y-2">
            <CopyRow label="Single documents" value="cybm.costs+sales@dext.cc" />
            <CopyRow label="Multiple documents" value="cybm.costs+sales@multiple.dext.cc" />
          </div>
        </div>
        <Row label="Blocked email addresses" hint="Emails that will be rejected by the system.">
          <button type="button" className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted">
            Manage
          </button>
        </Row>
      </Card>

      <Card title="Inbox tabs">
        <Row label="Show To review and Ready tabs" hint="Show these tabs in the costs and sales inboxes.">
          <Toggle defaultOn />
        </Row>
      </Card>

      <Card title="Duplicate items">
        <Row
          label="Duplicate cost items"
          hint="Supplier rules take priority when identifying duplicate items."
        >
          <SelectBox defaultValue="Automatic" options={['Automatic', 'Review manually', 'Off']} />
        </Row>
      </Card>

      <Card title="Tax">
        <Row label="Extract tax" hint="Extract the tax value from new costs and sales documents.">
          <Toggle defaultOn />
        </Row>
        <Row label="Default tax rate for costs">
          <SelectBox defaultValue="— None —" options={['— None —', 'Standard-Rated 9%', 'Zero-Rated', 'Exempt']} />
        </Row>
        <Row label="Default tax rate for sales">
          <SelectBox defaultValue="— None —" options={['— None —', 'Standard-Rated 9%', 'Zero-Rated', 'Exempt']} />
        </Row>
      </Card>

      <Card title="Due dates">
        <Row label="Due date for costs invoices">
          <SelectBox defaultValue="A number of days after the invoice date" options={['A number of days after the invoice date', 'End of the following month', 'On the invoice date']} />
        </Row>
        <Row label="How many days (costs)">
          <SelectBox defaultValue="30" options={['7', '14', '30', '60']} />
        </Row>
        <Row label="Due date for sales invoices">
          <SelectBox defaultValue="A number of days after the invoice date" options={['A number of days after the invoice date', 'End of the following month', 'On the invoice date']} />
        </Row>
        <Row label="How many days (sales)">
          <SelectBox defaultValue="7" options={['7', '14', '30', '60']} />
        </Row>
      </Card>

      <Card title="Payment status">
        <p className="text-sm text-muted-foreground">Mark costs documents as paid or not paid by default.</p>
        <Row label="Receipts"><SelectBox defaultValue="Not paid" options={['Not paid', 'Paid']} /></Row>
        <Row label="Invoices"><SelectBox defaultValue="Not paid" options={['Not paid', 'Paid']} /></Row>
        <Row label="Credit notes"><SelectBox defaultValue="Not paid" options={['Not paid', 'Paid']} /></Row>
      </Card>

      <Card title="Bank statements">
        <p className="text-sm text-muted-foreground">Choose if we should notify you about missing bank statement data.</p>
        <Row label="Missing period" hint="Display notifications for missing bank data between bank statements.">
          <Toggle defaultOn />
        </Row>
      </Card>

      <Card title="Email notifications">
        <Row
          label="When a document doesn’t have an owner"
          hint="Who to notify by email when a costs or sales document has no owner."
        >
          <SelectBox defaultValue="— None —" options={['— None —', 'Account admins', 'Document uploader']} />
        </Row>
      </Card>

      <div className="flex justify-end">
        <button type="button" className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
          Save changes
        </button>
      </div>
    </div>
  );
}

const CAT_DISPLAY_OPTIONS = ['Code and name', 'Name only', 'Code only'];
const CAT_MODE_TO_LABEL = { codeName: 'Code and name', name: 'Name only', code: 'Code only' };
const CAT_LABEL_TO_MODE = { 'Code and name': 'codeName', 'Name only': 'name', 'Code only': 'code' };

function Automation() {
  const catMode = useCategoryDisplayMode();
  const catSort = useCategorySortMode();
  return (
    <div className="space-y-6">
      <Card title="Categorisation">
        <p className="text-sm text-muted-foreground">Specify how categories are applied to your costs items.</p>
        <Row label="Auto-categorisation" hint="Automatically apply categories to new documents.">
          <SelectBox defaultValue="Always" options={['Always', 'When confident', 'Never']} />
        </Row>
        <Row label="Default category" hint="Applied when there’s no supplier rule and no better match.">
          <SelectBox defaultValue="— None —" options={['— None —', 'Transport - Taxi', 'Meals & Entertainment', 'Others']} />
        </Row>
        <Row label="Category display" hint="How categories appear in the Costs dropdowns.">
          <SelectBox
            value={CAT_MODE_TO_LABEL[catMode] || 'Code and name'}
            onChange={(v) => setCategoryDisplayMode(CAT_LABEL_TO_MODE[v] || 'codeName')}
            options={CAT_DISPLAY_OPTIONS}
          />
        </Row>
        <Row label="Category sort" hint="Order of the categories in the Costs dropdowns.">
          <SelectBox
            value={catSort === 'name' ? 'Name' : 'Code'}
            onChange={(v) => setCategorySortMode(v === 'Name' ? 'name' : 'code')}
            options={['Code', 'Name']}
          />
        </Row>
      </Card>

      <Card title="Smart Suggestions">
        <Row
          label="Display Smart Suggestions?"
          hint="Generate suggestions under certain fields; you choose to accept or ignore them."
        >
          <Toggle defaultOn />
        </Row>
        <Row label="Auto-apply for projects"><Toggle /></Row>
        <Row label="Auto-apply for description of items"><Toggle /></Row>
      </Card>

      <Card title="Line item grouping">
        <Row
          label="Group uncategorised lines"
          hint="Group together line items that don’t match any group in your list."
        >
          <Toggle />
        </Row>
      </Card>

      <Card title="Auto Expense claims">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-4 text-sm">
            <div>
              <p className="mb-1 font-medium">Summary</p>
              <div className="grid grid-cols-[150px_1fr] gap-y-1 text-muted-foreground">
                <span>Current claim end</span><span className="text-foreground">26 Jul 2026</span>
                <span>Frequency</span><span className="text-foreground">Monthly</span>
              </div>
            </div>
            <div>
              <p className="mb-1 font-medium">Created for</p>
              <div className="rounded-md border px-3 py-2 text-foreground">Sean Tan</div>
            </div>
          </div>
          <button type="button" className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted">
            Edit
          </button>
        </div>
      </Card>

      <Card title="Archive">
        <p className="text-sm text-muted-foreground">Archive items after you complete these actions.</p>
        <Row label="Archive after adding to expense claim"><Toggle defaultOn /></Row>
        <Row label="Archive after exporting to CSV"><Toggle defaultOn /></Row>
      </Card>

      <div className="flex justify-end">
        <button type="button" className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
          Save changes
        </button>
      </div>
    </div>
  );
}

// Approvals settings: Workflows (Dext-style rules, display) + Reminders (live).
function Approvals() {
  const [sub, setSub] = useState('workflows');
  return (
    <div className="space-y-5">
      <div className="flex gap-6 border-b">
        {[['workflows', 'Workflows'], ['reminders', 'Reminders']].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setSub(k)}
            className={cn(
              '-mb-px border-b-2 pb-3 pt-1 text-sm transition-colors',
              sub === k ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === 'workflows' ? <ApprovalWorkflows /> : <ApprovalReminders />}
    </div>
  );
}

function ApprovalWorkflows() {
  const [view, setView] = useState('list');
  const [tab, setTab] = useState('Costs');
  const [stages, setStages] = useState([{}]);

  if (view === 'create') {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={() => setView('list')}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Approval workflows
        </button>
        <Card title="Approval workflow creator">
          <Row label="Workflow name" required><TextInput /></Row>
          <Row label="Description">
            <textarea
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Row>
          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Apply approvals to
          </p>
          <Row label="Item type"><SelectBox defaultValue="Costs" options={['Costs', 'Sales', 'Expense claims']} /></Row>
          <Row label="Documents"><SelectBox defaultValue="All documents" options={['All documents', 'Receipts', 'Invoices']} /></Row>
          <Row label="Document owners"><SelectBox defaultValue="All document owners" options={['All document owners']} /></Row>
          <Row label="Project"><SelectBox defaultValue="All projects" options={['All projects']} /></Row>
          <Row label="Suppliers"><SelectBox defaultValue="All suppliers" options={['All suppliers']} /></Row>
          <Row label="Customers"><SelectBox defaultValue="All customers" options={['All customers']} /></Row>
          <Row label="Categories"><SelectBox defaultValue="All categories" options={['All categories']} /></Row>

          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Create approval flow
          </p>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">Approver type</th>
                  <th className="px-3 py-2 font-medium">Approver(s)</th>
                  <th className="px-3 py-2 font-medium">Condition</th>
                  <th className="px-3 py-2 font-medium">Amount (SGD)</th>
                  <th className="px-3 py-2 font-medium">Can edit?</th>
                </tr>
              </thead>
              <tbody>
                {stages.map((_, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-2">{ORDINALS[i] ?? `${i + 1}th`}</td>
                    <td className="px-3 py-2"><MiniSelect defaultValue="Specific user" options={['Specific user', 'Manager', 'Any admin']} /></td>
                    <td className="px-3 py-2"><MiniSelect defaultValue="Select user(s)" options={['Select user(s)', 'Sean Tan', 'Astrid Yang']} /></td>
                    <td className="px-3 py-2"><MiniSelect defaultValue="Always" options={['Always', 'Amount is over']} /></td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">Any amount</td>
                    <td className="px-3 py-2"><MiniSelect defaultValue="No" options={['No', 'Yes']} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={() => setStages((s) => [...s, {}])}
            className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
          >
            + Add stage
          </button>

          <div className="space-y-4 border-t pt-4">
            <Row label="Switch workflow on" hint="This workflow will apply to current and future documents once saved.">
              <Toggle defaultOn />
            </Row>
            <Row label="Allow self-approval" hint="Whether approvers can approve their own documents.">
              <Toggle />
            </Row>
          </div>
        </Card>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setView('list')}
            className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button type="button" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-6 border-b">
          {['Costs', 'Sales', 'Expense claims'].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                '-mb-px border-b-2 pb-3 pt-1 text-sm transition-colors',
                tab === t
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setView('create')}
          className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
        >
          Create workflow
        </button>
      </div>
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-xl border">
          <ListChecks className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
        </div>
        <p className="text-lg font-semibold tracking-tight">Welcome to your approvals workspace</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Set up approval workflows to automatically route {tab.toLowerCase()} items to managers or
          specific people.
        </p>
        <button
          type="button"
          onClick={() => setView('create')}
          className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Create workflow
        </button>
      </div>
    </div>
  );
}

// Live approval reminders. No mail server yet, so delivery is in-app (a banner
// to approvers with outstanding requests); the schedule is stored for later.
function ApprovalReminders() {
  const reminders = useApprovalReminders();
  const update = (patch) => setReminders({ ...reminders, ...patch });
  return (
    <Card title="Approval reminders">
      <Row label="Enable approval reminders" hint="Remind approvers who have outstanding approval requests.">
        <button type="button" onClick={() => update({ enabled: !reminders.enabled })} className="flex items-center gap-2 pt-1">
          <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', reminders.enabled ? 'justify-end bg-foreground' : 'justify-start border')}>
            <span className={cn('h-4 w-4 rounded-full', reminders.enabled ? 'bg-background' : 'bg-muted-foreground/50')} />
          </span>
          <span className="text-sm text-muted-foreground">{reminders.enabled ? 'Yes' : 'No'}</span>
        </button>
      </Row>
      {reminders.enabled && (
        <>
          <div className="grid gap-6 pt-2 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-medium">Send reminders every</p>
              <div className="space-y-1.5">
                {DAYS.map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(reminders.days[k])}
                      onChange={() => update({ days: { ...reminders.days, [k]: !reminders.days[k] } })}
                      className="h-4 w-4 accent-black"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-sm font-medium">At</p>
              <div className="space-y-1.5">
                {TIMES.map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="reminder-time"
                      checked={reminders.time === k}
                      onChange={() => update({ time: k })}
                      className="h-4 w-4 accent-black"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              CYBills has no mail server yet, so reminders show <span className="font-medium text-foreground">in-app</span>:
              an approver with outstanding requests sees a banner at the top of the app. The day/time schedule is saved and
              will drive email once mail is connected.
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

function Exports() {
  const stored = useExportSettings();
  const [form, setForm] = useState(stored);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (!dirty) setForm(stored); }, [stored, dirty]);

  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setDirty(true); setSaved(false); };
  const toggleColumn = (c) => {
    setForm((f) => {
      const has = f.columns.includes(c);
      return { ...f, columns: has ? f.columns.filter((x) => x !== c) : [...f.columns, c] };
    });
    setDirty(true); setSaved(false);
  };
  const save = () => { saveExportSettings(form); setDirty(false); setSaved(true); };

  return (
    <div className="space-y-6">
      <Card title="CSV Exports">
        <p className="text-sm text-muted-foreground">Choose how the data in CSV file exports gets formatted.</p>
        <Row label="Receipts and invoices"><SelectBox value={form.receiptsFormat} onChange={(v) => set('receiptsFormat', v)} options={['CYBills Default', 'Custom CSV', 'Xero', 'QuickBooks']} /></Row>
        <Row label="Bank statements"><SelectBox value={form.bankFormat} onChange={(v) => set('bankFormat', v)} options={['CYBills Excel', 'Custom']} /></Row>
        <Row label="Sales documents"><SelectBox value={form.salesFormat} onChange={(v) => set('salesFormat', v)} options={['CYBills Sales Default', 'Custom']} /></Row>
        <Row label="Expense reports"><SelectBox value={form.expenseFormat} onChange={(v) => set('expenseFormat', v)} options={['CYBills Default', 'Custom']} /></Row>
        <Row label="Show net amount" hint="Include the net value field in CSV exports."><Toggle on={form.showNet} onChange={(v) => set('showNet', v)} /></Row>
      </Card>

      <Card title="CSV Custom Exports">
        <p className="text-sm text-muted-foreground">Choose how the data in Custom CSV file exports gets formatted. Applied when you pick <span className="font-medium">Custom CSV</span> when exporting an expense claim.</p>
        <Row label="Decimal separator" hint="Comma switches the CSV field delimiter to “;” so numbers stay unambiguous."><SelectBox value={form.decimalSeparator} onChange={(v) => set('decimalSeparator', v)} options={['Dot (.)', 'Comma (,)']} /></Row>
        <Row label="Date format">
          <SelectBox value={form.dateFormat} onChange={(v) => set('dateFormat', v)} options={['DD-Mon-YYYY (e.g. 20-Sep-2025)', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']} />
        </Row>
        <Row label="Show item header in line items export"><Toggle on={form.showItemHeader} onChange={(v) => set('showItemHeader', v)} /></Row>
        <div>
          <p className="mb-1 text-sm font-medium">Custom CSV Export columns</p>
          <p className="mb-3 text-xs text-muted-foreground">Choose the columns to include in the Custom CSV export.</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            {EXPORT_COLUMNS.map((c) => (
              <CheckRow key={c} label={c} checked={form.columns.includes(c)} onChange={() => toggleColumn(c)} />
            ))}
          </div>
        </div>
      </Card>

      <Card title="PDF Exports">
        <Row label="Item headers in PDF exports" hint="A page is generated before each item with the item ID.">
          <Toggle on={form.pdfItemHeaders} onChange={(v) => set('pdfItemHeaders', v)} />
        </Row>
        <Row label="Order of items" hint="Order of items in the PDF export.">
          <SelectBox value={form.pdfOrder} onChange={(v) => set('pdfOrder', v)} options={['Date (old to new)', 'Date (new to old)', 'Supplier']} />
        </Row>
        <Row label="Hide Project in expense claim PDFs"><Toggle on={form.hideProject} onChange={(v) => set('hideProject', v)} /></Row>
        <Row label="Hide Project 2 in expense claim PDFs"><Toggle on={form.hideProject2} onChange={(v) => set('hideProject2', v)} /></Row>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
        <button
          type="button"
          onClick={save}
          disabled={!dirty}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Save changes
        </button>
      </div>
    </div>
  );
}


function Placeholder({ label }) {
  return (
    <div className="flex h-[50vh] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
      <p className="text-sm font-medium">{label}</p>
      <p className="text-sm text-muted-foreground">This settings section is coming soon.</p>
    </div>
  );
}

const TITLES = Object.fromEntries(NAV.flatMap((s) => s.items).map((i) => [i.key, i.label]));

// Business settings → Connections. Accounting software is the live one (CYBills
// posts to Xero through the cyworkspace relay); Back up and Cost connections are
// shown for parity with Dext but not yet wired.
function Connections() {
  const { data: organisations = [] } = useOrganisations();
  const linked = organisations.filter((o) => o.tenantId || o.tenantName);

  return (
    <div className="space-y-5">
      <Card title="Accounting software">
        <div className="rounded-lg border p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">Connect and manage software for bookkeeping</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Retrieve data from your accounting software and publish transactions directly to it.
              </p>
            </div>
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="pointer-events-none inline-flex h-9 shrink-0 items-center rounded-md border px-4 text-sm font-medium text-muted-foreground"
            >
              {linked.length ? 'Connected' : 'Connect'}
            </a>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {/* Xero is the only supported provider today; the rest are shown greyed for parity. */}
            <span className="inline-flex h-8 items-center rounded-md border border-foreground/30 bg-muted px-3 text-sm font-medium">
              Xero
            </span>
            {['QuickBooks', 'Sage', 'KashFlow', 'FreeAgent'].map((p) => (
              <span key={p} className="inline-flex h-8 items-center rounded-md border px-3 text-sm text-muted-foreground/60">
                {p}
              </span>
            ))}
            <span className="inline-flex h-8 items-center rounded-md bg-muted px-3 text-xs text-muted-foreground">+22 more</span>
          </div>
          {linked.length > 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Linked to Xero:{' '}
              <span className="font-medium text-foreground">
                {linked.map((o) => o.tenantName || o.name).join(', ')}
              </span>
              .
            </p>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              Only Xero is available right now. Link a Xero organisation from the workspace menu
              (top-left) to publish bills through the relay.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

// Business settings → Email. Connects the Microsoft 365 mailbox that account
// email (invitations, password resets, password-changed notices) is sent from.
//
// CYBills asks Microsoft only for DELEGATED Mail.Send: it sends *as* the
// account that consents here, and can never reach another mailbox or read
// anything in this one. The trade-off of that narrower grant is that the
// connection is a user's, so it can lapse — hence the reconnect path below.
function EmailSettings() {
  const [params, setParams] = useSearchParams();
  const [status, reload] = useMailStatus();
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  // The OAuth callback returns here with ?mail=connected|error.
  const outcome = params.get('mail');
  const reason = params.get('reason');
  useEffect(() => {
    if (!outcome) return;
    setNote(
      outcome === 'connected'
        ? `Connected ${params.get('account') || 'the mailbox'}. Send a test email to confirm it works.`
        : `Could not connect: ${reason || 'unknown error'}`
    );
    // Clear the params so a refresh doesn't replay the banner.
    const next = new URLSearchParams(params);
    ['mail', 'reason', 'account'].forEach((k) => next.delete(k));
    next.set('section', 'email');
    setParams(next, { replace: true });
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const disconnect = async () => {
    if (!window.confirm('Disconnect the sending mailbox? Invitations and password resets will stop being emailed until you reconnect.')) return;
    setBusy('disconnect');
    await disconnectMailbox();
    setBusy('');
    setNote('Mailbox disconnected. Invite links will be handed to admins to share manually.');
    reload();
  };

  const test = async () => {
    setBusy('test');
    const res = await sendTestEmail();
    setBusy('');
    setNote(res.sent ? `Test email sent to ${res.to}.` : `Test failed: ${res.error || 'unknown error'}`);
    reload();
  };

  if (!status) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const btn = 'inline-flex h-9 shrink-0 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50';
  const primary = 'inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50';

  return (
    <div className="space-y-5">
      {note && (
        <div className="flex items-start gap-2 rounded-md border bg-muted px-3 py-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{note}</span>
          <button type="button" onClick={() => setNote('')} className="text-muted-foreground hover:text-foreground">Dismiss</button>
        </div>
      )}

      <Card title="Sending mailbox">
        <div className="rounded-lg border p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium">
                Microsoft 365
                {status.connected ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-600/30 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    <ShieldCheck className="h-3 w-3" /> Connected
                  </span>
                ) : status.needsReconnect ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-600/30 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    <AlertTriangle className="h-3 w-3" /> Reconnect needed
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                    Not connected
                  </span>
                )}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Invitations, password resets and password-changed notices are sent from this mailbox.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {status.connected && (
                <button type="button" onClick={test} disabled={Boolean(busy)} className={btn}>
                  {busy === 'test' ? 'Sending…' : 'Send test email'}
                </button>
              )}
              {status.configured && (
                <button type="button" onClick={connectMailbox} className={status.connected ? btn : primary}>
                  {status.connected || status.needsReconnect ? 'Reconnect' : 'Connect mailbox'}
                </button>
              )}
              {(status.connected || status.needsReconnect) && (
                <button type="button" onClick={disconnect} disabled={Boolean(busy)} className={cn(btn, 'text-destructive')}>
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
              )}
            </div>
          </div>

          {!status.configured && (
            <p className="mt-4 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
              No Azure app registration is configured yet, so a mailbox can&rsquo;t be connected. Set
              <code className="mx-1 rounded bg-muted px-1 text-xs">GRAPH_TENANT_ID</code>,
              <code className="mx-1 rounded bg-muted px-1 text-xs">GRAPH_CLIENT_ID</code> and
              <code className="mx-1 rounded bg-muted px-1 text-xs">GRAPH_CLIENT_SECRET</code> on the
              server — see <span className="font-medium text-foreground">deploy/EMAIL.md</span>. Until
              then, invitations still work: the link is handed to the admin to share.
            </p>
          )}

          {status.needsReconnect && (
            <p className="mt-4 rounded-md border border-amber-600/30 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              The connection to <span className="font-medium">{status.account}</span> stopped working
              {status.invalidReason ? ` (${status.invalidReason})` : ''}. This normally means that
              account&rsquo;s password changed or its consent was revoked. Reconnect to resume sending.
            </p>
          )}

          {(status.connected || status.needsReconnect) && (
            <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[160px_1fr]">
              <dt className="text-muted-foreground">Sending as</dt>
              <dd className="font-medium">
                {status.sendingAs}
                {status.sharedSender && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    shared mailbox, authorised by {status.account}
                  </span>
                )}
              </dd>
              <dt className="text-muted-foreground">Connected by</dt>
              <dd>{status.connectedBy}{status.connectedAt ? ` · ${new Date(status.connectedAt).toLocaleDateString()}` : ''}</dd>
            </dl>
          )}
        </div>
      </Card>

      <Card title="Access granted">
        <div className="rounded-lg border p-5 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <ShieldCheck className="h-4 w-4" /> Send-only, one mailbox
          </p>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted-foreground">
            <li>
              CYBills holds the <span className="font-medium text-foreground">Mail.Send (Delegated)</span>{' '}
              permission — it sends as the account connected above and nothing else.
            </li>
            <li>It cannot read, search, or delete anything in that mailbox, or any other.</li>
            <li>
              No tenant-wide application permission is used, so no other mailbox in the organisation
              is reachable.
            </li>
            <li>Sent messages appear in that mailbox&rsquo;s Sent Items, so there&rsquo;s a delivery trail.</li>
          </ul>
        </div>
      </Card>
    </div>
  );
}

// Business settings → Vault. Flagging (auto-flag files N days before due) and
// Vault sync (cloud storage the Vault mirrors to).
function VaultSettings() {
  const [days, setDays] = useState(() => localStorage.getItem('cybills.vault.flagdays.v1') || '14');
  const [platform, setPlatform] = useState(() => localStorage.getItem('cybills.vault.syncplatform.v1') || '');

  const saveDays = (v) => {
    const n = v.replace(/[^0-9]/g, '');
    setDays(n);
    localStorage.setItem('cybills.vault.flagdays.v1', n);
  };
  const pick = (p) => {
    setPlatform(p);
    localStorage.setItem('cybills.vault.syncplatform.v1', p);
  };

  const PLATFORMS = ['Dropbox', 'Google Drive', 'OneDrive'];

  return (
    <div className="space-y-5">
      <Card title="Flagging files">
        <div>
          <p className="font-medium">Flag by due date</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Flagged files appear in the To review section. Files with due dates are automatically
            flagged a set number of days before they’re due. Files with due dates more than a month in
            the past will not be flagged.
          </p>
        </div>
        <Row label="Days before due date" hint="Change how many days in advance files are flagged.">
          <input
            value={days}
            onChange={(e) => saveDays(e.target.value)}
            inputMode="numeric"
            className="h-10 w-40 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Row>
      </Card>

      <Card title="Vault sync">
        <p className="text-sm text-muted-foreground">Select a storage platform, then sign in to connect with Vault.</p>
        <div className="space-y-3">
          {PLATFORMS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => pick(p)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border px-4 py-3.5 text-left text-sm transition-colors',
                platform === p ? 'border-foreground bg-muted/40' : 'hover:bg-muted/40'
              )}
            >
              <span className={cn('flex h-4 w-4 items-center justify-center rounded-full border-2', platform === p ? 'border-foreground' : 'border-muted-foreground/50')}>
                {platform === p && <span className="h-2 w-2 rounded-full bg-foreground" />}
              </span>
              <span className="font-medium">{p}</span>
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button type="button" disabled={!platform} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
            Connect
          </button>
        </div>
      </Card>
    </div>
  );
}

export default function Settings() {
  // Deep-link support: /settings?section=approvals opens that section directly.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('section');
  const [section, setSection] = useState(() => (requested && TITLES[requested] ? requested : 'business'));

  const selectSection = (key) => {
    setSection(key);
    // Reflect the choice in the URL (replace, so back doesn't step through tabs).
    setSearchParams(key === 'business' ? {} : { section: key }, { replace: true });
  };

  return (
    <AppShell subnav={<SettingsNav active={section} onSelect={selectSection} />}>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">{TITLES[section]}</h1>
      {section === 'business' ? (
        <BusinessProfile />
      ) : section === 'connections' ? (
        <Connections />
      ) : section === 'extraction' ? (
        <Extraction />
      ) : section === 'automation' ? (
        <Automation />
      ) : section === 'approvals' ? (
        <Approvals />
      ) : section === 'email' ? (
        <EmailSettings />
      ) : section === 'exports' ? (
        <Exports />
      ) : section === 'lists' ? (
        <ListsSettings />
      ) : section === 'vault' ? (
        <VaultSettings />
      ) : (
        <Placeholder label={TITLES[section]} />
      )}
    </AppShell>
  );
}
