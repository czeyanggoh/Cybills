import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Building2,
  Share2,
  Upload,
  Workflow,
  Sparkles,
  Check,
  Download,
  ClipboardList,
  Briefcase,
  Archive,
  LayoutGrid,
  ImagePlus,
  Copy,
  ListChecks,
  ChevronDown,
  RefreshCw,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import { cn } from '@/lib/utils';
import {
  useOrganisations,
  getActiveOrganisationId,
  useXeroAccounts,
} from '@/lib/organisations';

const NAV = [
  {
    group: 'Business settings',
    items: [
      { key: 'business', label: 'Business profile', icon: Building2 },
      { key: 'connections', label: 'Connections', icon: Share2 },
      { key: 'extraction', label: 'Extraction', icon: Upload },
      { key: 'automation', label: 'Automation', icon: Workflow },
      { key: 'ai', label: 'AI Assist', icon: Sparkles },
      { key: 'approvals', label: 'Approvals', icon: Check },
      { key: 'exports', label: 'Exports', icon: Download },
      { key: 'lists', label: 'Lists', icon: ClipboardList },
      { key: 'accountant', label: 'Accountant', icon: Briefcase },
      { key: 'vault', label: 'Vault', icon: Archive },
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

function TextInput({ defaultValue = '', readOnly = false, placeholder = '' }) {
  return (
    <input
      defaultValue={defaultValue}
      readOnly={readOnly}
      placeholder={placeholder}
      className={cn(
        'h-9 w-full rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        readOnly ? 'bg-muted text-muted-foreground' : 'bg-background'
      )}
    />
  );
}

function SelectBox({ defaultValue, options }) {
  return (
    <select
      defaultValue={defaultValue}
      className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

function Toggle({ defaultOn = false }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button
      type="button"
      onClick={() => setOn((v) => !v)}
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

function CheckRow({ label, defaultChecked = false }) {
  const [on, setOn] = useState(defaultChecked);
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={on} onChange={() => setOn((v) => !v)} className="h-4 w-4 accent-black" />
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

function SaveBar() {
  return (
    <div className="flex justify-end">
      <button type="button" className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
        Save changes
      </button>
    </div>
  );
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

// --- Sections ---------------------------------------------------------------
function BusinessProfile() {
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
        <Row label="CRN"><TextInput defaultValue="9881375639" readOnly /></Row>
        <Row label="Business name" required><TextInput defaultValue="CY Business Management" /></Row>
        <Row label="Practice code"><TextInput placeholder="" /></Row>
        <Row label="Country of registration" required>
          <SelectBox defaultValue="Singapore" options={['Singapore', 'Malaysia', 'United Kingdom', 'Australia']} />
        </Row>
        <Row label="Base currency">
          <SelectBox defaultValue="SGD — Singapore, Dollars" options={['SGD — Singapore, Dollars', 'USD — US, Dollars', 'MYR — Malaysian, Ringgit', 'GBP — British, Pounds']} />
        </Row>
        <Row label="Account language">
          <SelectBox defaultValue="English" options={['English', 'Chinese', 'Malay']} />
        </Row>
        <Row label="Industry">
          <SelectBox defaultValue="IT and Computer Services" options={['IT and Computer Services', 'Professional Services', 'Retail', 'Construction', 'Other']} />
        </Row>
      </Card>

      <Card title="Registered address">
        <Row label="Address line 1"><TextInput /></Row>
        <Row label="Address line 2"><TextInput /></Row>
        <Row label="City/town"><TextInput /></Row>
        <Row label="Postal/zip code"><TextInput /></Row>
        <Row label="Country"><TextInput defaultValue="Singapore" readOnly /></Row>
      </Card>

      <Card title="Item messaging">
        <Row
          label="Use company name"
          hint="Sign-off messages to clients with your company name rather than the signed-in user."
        >
          <Toggle />
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

function Automation() {
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
        <Row label="Category display">
          <SelectBox defaultValue="Code and name" options={['Code and name', 'Name only', 'Code only']} />
        </Row>
        <Row label="Category sort">
          <SelectBox defaultValue="Code" options={['Code', 'Name']} />
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

function Approvals() {
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

const EXPORT_COLUMNS = [
  'Receipt ID', 'Invoice number', 'Type', 'Status', 'Owner', 'Date', 'Due date', 'Supplier',
  'Customer', 'Description', 'Category', 'Product/Service', 'Project 1', 'Payment method',
  'Currency', 'Tax rate', 'Quantity (line items)', 'Unit price (net)', 'Unit price (total)',
  'Net amount', 'Tax amount', 'Total amount', 'Net with currency', 'Tax with currency',
  'Total with currency', 'Base net amount', 'Base total amount', 'Note', 'Image', 'Project 2',
];
const EXPORT_DEFAULTS = new Set(['Receipt ID', 'Description', 'Net amount', 'Tax amount', 'Total amount']);

function Exports() {
  return (
    <div className="space-y-6">
      <Card title="CSV Exports">
        <p className="text-sm text-muted-foreground">Choose how the data in CSV file exports gets formatted.</p>
        <Row label="Receipts and invoices"><SelectBox defaultValue="Dext Default" options={['Dext Default', 'Custom CSV', 'Xero', 'QuickBooks']} /></Row>
        <Row label="Bank statements"><SelectBox defaultValue="Standard Dext Excel" options={['Standard Dext Excel', 'Custom']} /></Row>
        <Row label="Sales documents"><SelectBox defaultValue="Dext Sales Default" options={['Dext Sales Default', 'Custom']} /></Row>
        <Row label="Expense reports"><SelectBox defaultValue="Dext Default" options={['Dext Default', 'Custom']} /></Row>
        <Row label="Show net amount" hint="Include the net value field in CSV exports."><Toggle /></Row>
      </Card>

      <Card title="CSV Custom Exports">
        <p className="text-sm text-muted-foreground">Choose how the data in Custom CSV file exports gets formatted.</p>
        <Row label="Decimal separator"><SelectBox defaultValue="Dot (.)" options={['Dot (.)', 'Comma (,)']} /></Row>
        <Row label="Date format">
          <SelectBox defaultValue="DD-Mon-YYYY (e.g. 20-Sep-2025)" options={['DD-Mon-YYYY (e.g. 20-Sep-2025)', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']} />
        </Row>
        <Row label="Show item header in line items export"><Toggle /></Row>
        <div>
          <p className="mb-1 text-sm font-medium">Custom CSV Export columns</p>
          <p className="mb-3 text-xs text-muted-foreground">Choose the columns to include in the Custom CSV export.</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            {EXPORT_COLUMNS.map((c) => (
              <CheckRow key={c} label={c} defaultChecked={EXPORT_DEFAULTS.has(c)} />
            ))}
          </div>
        </div>
      </Card>

      <Card title="PDF Exports">
        <Row label="Item headers in PDF exports" hint="A page is generated before each item with the item ID.">
          <Toggle />
        </Row>
        <Row label="Order of items" hint="Order of items in the PDF export.">
          <SelectBox defaultValue="Date (old to new)" options={['Date (old to new)', 'Date (new to old)', 'Supplier']} />
        </Row>
        <Row label="Hide Project in expense claim PDFs"><Toggle /></Row>
        <Row label="Hide Project 2 in expense claim PDFs"><Toggle /></Row>
      </Card>

      <SaveBar />
    </div>
  );
}

// Human labels for Xero's account Type enum (kept short for the table cell).
const ACCOUNT_TYPE_LABELS = {
  EXPENSE: 'Expense',
  OVERHEADS: 'Overheads',
  DIRECTCOSTS: 'Direct costs',
  REVENUE: 'Revenue',
  SALES: 'Sales',
  OTHERINCOME: 'Other income',
  CURRENT: 'Current asset',
  FIXED: 'Fixed asset',
  INVENTORY: 'Inventory',
  NONCURRENT: 'Non-current asset',
  CURRLIAB: 'Current liability',
  LIABILITY: 'Liability',
  TERMLIAB: 'Non-current liability',
  EQUITY: 'Equity',
  BANK: 'Bank',
  PREPAYMENT: 'Prepayment',
};

function typeLabel(type) {
  return ACCOUNT_TYPE_LABELS[type] || (type ? type[0] + type.slice(1).toLowerCase() : '—');
}

// Lists → Chart of accounts. Pulls the linked Xero organisation's account codes
// live through the cyworkspace relay (GET /api/xero/organisations/:id/accounts).
function Lists() {
  const { data: organisations = [], isLoading: orgsLoading } = useOrganisations();
  const [organisationId, setOrganisationId] = useState('');
  const [query, setQuery] = useState('');

  // Preselect the active organisation (falling back to the first) once the
  // linked organisations have loaded.
  useEffect(() => {
    if (!organisations.length) return;
    setOrganisationId((current) => {
      if (current && organisations.some((o) => o.id === current)) return current;
      const active = getActiveOrganisationId();
      return organisations.some((o) => o.id === active) ? active : organisations[0].id;
    });
  }, [organisations]);

  const {
    data: accounts = [],
    isLoading: accountsLoading,
    isFetching,
    error,
    refetch,
  } = useXeroAccounts(organisationId);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? accounts.filter(
        (a) =>
          a.code.toLowerCase().includes(q) ||
          (a.name ?? '').toLowerCase().includes(q) ||
          typeLabel(a.type).toLowerCase().includes(q)
      )
    : accounts;

  const err = /** @type {any} */ (error);
  const configError = err?.code === 'xero_not_configured';
  const notConnected = err?.status === 502 || err?.code === 'relay_unreachable';

  if (orgsLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (!organisations.length) {
    return (
      <Card title="Chart of accounts">
        <p className="text-sm text-muted-foreground">
          No organisation is linked to Xero yet. Add one from the workspace menu (top left) to pull
          in its account codes.
        </p>
      </Card>
    );
  }

  const selectClass =
    'h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

  return (
    <div className="space-y-6">
      <Card title="Chart of accounts">
        <p className="text-sm text-muted-foreground">
          Account codes pulled live from Xero through the cyworkspace relay. These are the active
          accounts bills can be published to.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          {organisations.length > 1 && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Organisation</span>
              <div className="relative">
                <select
                  value={organisationId}
                  onChange={(e) => setOrganisationId(e.target.value)}
                  className={cn(selectClass, 'w-56')}
                >
                  {organisations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </label>
          )}

          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Search</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by code, name or type"
              className="h-9 w-full min-w-48 rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} strokeWidth={1.75} />
            Refresh
          </button>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-destructive">Could not load account codes from Xero</p>
            <p className="mt-1 text-muted-foreground">
              {configError
                ? 'The cyworkspace relay is not configured on this server yet (CYWORKSPACE_API_KEY).'
                : notConnected
                  ? 'The cyworkspace relay could not be reached. Check that the connection is up and try again.'
                  : error.message}
            </p>
          </div>
        ) : accountsLoading ? (
          <p className="text-sm text-muted-foreground">Loading account codes from Xero…</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This Xero organisation has no active accounts.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="border-b bg-muted/40 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Code</th>
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Tax</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr key={a.code} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-3 py-2 font-mono">{a.code}</td>
                      <td className="px-3 py-2">{a.name}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {typeLabel(a.type)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {a.taxType || '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{a.description || '—'}</td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                        No accounts match “{query}”.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              {filtered.length === accounts.length
                ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}`
                : `${filtered.length} of ${accounts.length} accounts`}
            </p>
          </>
        )}
      </Card>
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
  const linked = organisations.filter((o) => o.xeroTenantId || o.xeroTenantName);

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
                {linked.map((o) => o.xeroTenantName || o.name).join(', ')}
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

      <Card title="Back up">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-medium">Backup your paperwork</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect CYBills to a cloud storage provider to back up all your Costs and Sales
              documents automatically or on demand.
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-sm text-muted-foreground/60">
              {['Dropbox', 'Google Drive', 'OneDrive', 'Everial'].map((p) => (
                <span key={p} className="inline-flex h-8 items-center rounded-md border px-3">{p}</span>
              ))}
            </div>
          </div>
          <button type="button" className="inline-flex h-9 shrink-0 items-center rounded-md border px-4 text-sm font-medium text-muted-foreground" disabled>
            Connect
          </button>
        </div>
      </Card>

      <Card title="Cost connections">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-medium">Fetch bills automatically</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Automatically collect your new bills and invoices from these apps or websites. Find the
              collected documents in your Costs inbox.
            </p>
          </div>
          <button type="button" className="inline-flex h-9 shrink-0 items-center rounded-md border px-4 text-sm font-medium text-muted-foreground" disabled>
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
      ) : section === 'exports' ? (
        <Exports />
      ) : section === 'lists' ? (
        <Lists />
      ) : (
        <Placeholder label={TITLES[section]} />
      )}
    </AppShell>
  );
}
