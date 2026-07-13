import { useState } from 'react';
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
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import { cn } from '@/lib/utils';

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

      <div className="flex justify-end">
        <button type="button" className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
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

export default function Settings() {
  const [section, setSection] = useState('business');

  return (
    <AppShell subnav={<SettingsNav active={section} onSelect={setSection} />}>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">{TITLES[section]}</h1>
      {section === 'business' ? (
        <BusinessProfile />
      ) : section === 'extraction' ? (
        <Extraction />
      ) : (
        <Placeholder label={TITLES[section]} />
      )}
    </AppShell>
  );
}
