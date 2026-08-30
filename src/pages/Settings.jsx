import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  Building2,
  Share2,
  Upload,
  Workflow,
  Download,
  ClipboardList,
  ImagePlus,
  Copy,
  Info,
  Mail,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  MessageCircle,
} from 'lucide-react';
import AppShell from '@/components/AppShell';
import ListsSettings from '@/components/ListsSettings';
import { cn } from '@/lib/utils';
import { useCategoryDisplayMode, setCategoryDisplayMode, useCategorySortMode, setCategorySortMode } from '@/lib/categoryDisplay';
import { useBusinessProfile, saveBusinessProfile, mergeXeroProfile } from '@/lib/businessProfile';
import { useExportSettings, saveExportSettings, EXPORT_COLUMNS, RECEIPT_FORMATS } from '@/lib/exportSettings';
import { useAutoSave } from '@/lib/useAutoSave';
import SaveStatus from '@/components/SaveStatus';
import {
  useOrganisations,
  useActiveOrganisation,
  useBridgeEntity,
  isStandaloneOrg,
  fetchXeroProfile,
  getActiveOrganisationId,
  useVisibleTaxRates,
  syncXeroPayments,
  setEmailSuffix,
  useInvalidateOrganisations,
  useIsPrimaryOrganisation,
} from '@/lib/organisations';
import { useMailStatus, connectMailbox, disconnectMailbox, sendTestEmail } from '@/lib/mailSettings';
import { useInboundConfig } from '@/lib/inboundSettings';
import { cleanSuffix, addressTail } from '@/lib/inboundAddress';
import { useWhatsappChannels, createWhatsappChannel, useWhatsappConfig, sendTestDelivery } from '@/lib/whatsapp';
import { useExtractionSettings, saveExtractionSettings, DUE_MODES, DUE_DAYS, DUP_MODES, PAID_OPTIONS } from '@/lib/extractionSettings';
import { useAuth } from '@/lib/auth';
import { isPracticeTeam } from '@/lib/practiceStore';
import { READER_PROVIDERS, readerLabel, effectiveProvider } from '@/lib/readerProvider';

const NAV = [
  {
    group: 'Business settings',
    items: [
      { key: 'business', label: 'Business profile', icon: Building2 },
      { key: 'connections', label: 'Connections', icon: Share2 },
      { key: 'extraction', label: 'Extraction', icon: Upload },
      { key: 'automation', label: 'Automation', icon: Workflow },
      { key: 'email', label: 'Email', icon: Mail },
      { key: 'exports', label: 'Exports', icon: Download },
      { key: 'lists', label: 'Lists', icon: ClipboardList },
    ],
  },
];

// Sections that are the DEPLOYMENT's rather than this entity's. Account email
// leaves from one mailbox for every client — nothing about it is Red Alpha's or
// ST Engineering's — so it belongs in the practice's own entity and nowhere
// else. The server enforces the same rule (mail.ts); this is what stops it
// being offered.
const ACCOUNT_WIDE = new Set(['email']);

function navFor(accountWide) {
  if (accountWide) return NAV;
  return NAV.map((section) => ({ ...section, items: section.items.filter((i) => !ACCOUNT_WIDE.has(i.key)) }));
}

function SettingsNav({ nav, active, onSelect }) {
  const navigate = useNavigate();
  return (
    <div className="p-3 text-sm">
      <button
        type="button"
        onClick={() => navigate('/costs')}
        className="mb-2 flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2} /> Back
      </button>
      {nav.map((section) => (
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

// A value to copy into somebody else's configuration. `secret` keeps it off the
// screen until asked for: a credential nobody is currently reading should not be
// sitting in a window behind them, and it can still be copied without ever being
// shown. (The icon used to be decoration — it copies now.)
function CopyRow({ label, value, secret = false }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value ?? ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused (no permission / insecure context) — reveal it so the
      // value can be selected by hand rather than leaving nothing to do.
      setShown(true);
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 font-mono text-foreground">
        <span className="truncate">{shown ? value : '•'.repeat(24)}</span>
        {secret && (
          <button
            type="button"
            onClick={() => setShown((v) => !v)}
            className="shrink-0 font-sans text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {shown ? 'Hide' : 'Reveal'}
          </button>
        )}
        <button type="button" onClick={copy} aria-label={`Copy ${label}`} title={copied ? 'Copied' : 'Copy'}>
          <Copy className={cn('h-3.5 w-3.5 shrink-0 cursor-pointer', copied ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')} />
        </button>
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
  const [sync, setSync] = useState({ state: 'idle', message: '' }); // idle | loading | ok | error
  // Every edit saves itself; the status sits where the Save button used to.
  const status = useAutoSave(form, (v) => { saveBusinessProfile(v); setDirty(false); });

  // Keep the form in step with the persisted profile until the user edits it.
  useEffect(() => {
    if (!dirty) setForm(stored);
  }, [stored, dirty]);

  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setDirty(true); };
  const setAddr = (key, value) => {
    setForm((f) => ({ ...f, address: { ...f.address, [key]: value } }));
    setDirty(true);
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
      setDirty(true);
      setSync({ state: 'ok', message: 'Pulled from Xero and saved.' });
    } catch (err) {
      const code = err?.code || '';
      const message =
        code === 'xero_not_configured' ? 'Xero isn’t connected on the server yet.'
        : code === 'organisation_not_found' ? 'This organisation isn’t linked to a Xero tenant.'
        : err?.message || 'Could not reach Xero.';
      setSync({ state: 'error', message });
    }
  };


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
        <Row label="GST registered?">
          <SelectBox value={form.gstRegistered || 'Yes'} onChange={(v) => set('gstRegistered', v)} options={['Yes', 'No']} />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {String(form.gstRegistered).toLowerCase() === 'no'
              ? 'Not registered — every document is coded “No Tax” and no GST is split out.'
              : 'Registered — tax codes are analysed from each document.'}
          </p>
        </Row>
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
        <SaveStatus status={status} />
      </div>
    </div>
  );
}

// The engine that reads uploaded documents, chosen per client entity. Only the
// providers the SERVER has an API key for are offered, so this card shows a
// picker on a deploy with both keys configured, a plain statement of fact on one
// with a single key, and nothing at all when extraction is switched off. The
// server re-checks the choice on every call, so picking one whose key is later
// removed degrades to the working reader rather than failing the read.
const SERVER_DEFAULT_LABEL = 'Server default';

function DocumentReaderCard({ value, onChange }) {
  const { visionEnabled, readerProviders = [], defaultReaderProvider } = useAuth();
  const offered = READER_PROVIDERS.filter((p) => readerProviders.includes(p.id));
  const inUse = readerLabel(effectiveProvider(value, readerProviders, defaultReaderProvider));

  if (!visionEnabled) {
    return (
      <Card title="Document reader">
        <p className="text-sm text-muted-foreground">
          No reader is configured on the server yet, so uploaded documents aren&apos;t read
          automatically. Add an Anthropic or OpenAI API key to switch auto-fill on.
        </p>
      </Card>
    );
  }

  if (offered.length < 2) {
    return (
      <Card title="Document reader">
        <p className="text-sm text-muted-foreground">
          Receipts and invoices are read by <span className="font-medium text-foreground">{inUse}</span>.
          Configure a second provider&apos;s API key on the server to be able to switch between them.
        </p>
      </Card>
    );
  }

  const labelFor = (id) => (id ? `${readerLabel(id)}${optionHint(id)}` : `${SERVER_DEFAULT_LABEL} (${readerLabel(defaultReaderProvider)})`);
  const options = [labelFor(''), ...offered.map((p) => labelFor(p.id))];
  const fromLabel = (label) =>
    label.startsWith(SERVER_DEFAULT_LABEL) ? '' : offered.find((p) => label.startsWith(p.label))?.id ?? '';

  return (
    <Card title="Document reader">
      <p className="text-sm text-muted-foreground">
        Which AI reads the receipts and invoices you upload. Both read the same file against the
        same fields, so you can switch at any time — only documents read from now on are affected,
        and anything already read keeps what it got.
      </p>
      <Row
        label="Reader"
        hint="Applies to this client entity only, and to the Vault document summaries as well."
      >
        <SelectBox value={labelFor(value)} onChange={(v) => onChange(fromLabel(v))} options={options} />
      </Row>
    </Card>
  );
}

const optionHint = (id) => {
  const hint = READER_PROVIDERS.find((p) => p.id === id)?.hint;
  return hint ? ` (${hint})` : '';
};

// The entity's short form in its people's addresses: martin.redalpha@cybills.sg.
//
// One mail domain serves every client, so handles are unique across the whole
// deployment: the first Martin took `martin` and Red Alpha's Martin was handed
// `martin2`, which is an address nobody can be told over the phone without
// explaining it. A short form gives the entity its own namespace — its people
// get their own names back, and the address says which company it files into.
//
// Saved on its own button rather than as-you-type: it repoints EVERYBODY in the
// entity at once, which is not a thing to do on a keystroke.
function EmailSuffixRow({ organisation, domain }) {
  const saved = cleanSuffix(organisation?.emailSuffix || '');
  const [value, setValue] = useState(saved);
  const [state, setState] = useState({ busy: false, error: '', done: '' });
  const refresh = useInvalidateOrganisations();
  useEffect(() => { setValue(cleanSuffix(organisation?.emailSuffix || '')); }, [organisation?.id, organisation?.emailSuffix]);
  if (!organisation) return null;
  const clean = cleanSuffix(value);
  const dirty = clean !== saved;

  const save = async () => {
    setState({ busy: true, error: '', done: '' });
    try {
      const body = await setEmailSuffix(organisation.id, clean);
      refresh();
      const n = body?.addresses ?? 0;
      setState({
        busy: false,
        error: '',
        done: clean
          ? `Saved. ${n} ${n === 1 ? 'address' : 'addresses'} now end in .${clean}@${domain}.`
          : `Cleared. ${n} ${n === 1 ? 'address is' : 'addresses are'} back to the plain handle.`,
      });
    } catch (err) {
      setState({ busy: false, error: err?.message || 'Could not save the short form.', done: '' });
    }
  };

  return (
    <Row
      label="Short form"
      hint="Goes after every address in this entity, so one Martin here and another at a different client can each keep their own name."
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-9 min-w-0 flex-1 items-center overflow-hidden rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring">
          <span className="shrink-0 select-none border-r bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground">
            &lt;handle&gt;.
          </span>
          <input
            value={value}
            onChange={(e) => { setValue(e.target.value); setState({ busy: false, error: '', done: '' }); }}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="redalpha"
            aria-label="Entity short form"
            className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
          />
          <span className="shrink-0 select-none border-l bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground">
            @{domain}
          </span>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || state.busy}
          className="inline-flex h-9 shrink-0 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {state.error ? (
        <p className="mt-2 text-xs text-destructive">{state.error}</p>
      ) : state.done ? (
        <p className="mt-2 text-xs text-muted-foreground">{state.done}</p>
      ) : dirty && clean ? (
        // What it will DO, before it is done: everyone moves, and the address
        // they have been using goes on working while nobody else wants it.
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          Every address in this entity becomes <code>&lt;handle&gt;.{clean}@{domain}</code>. The plain
          {' '}<code>&lt;handle&gt;@{domain}</code> keeps arriving while no other entity is using it, so forwarding rules
          already set up are not broken.
        </p>
      ) : null}
    </Row>
  );
}

// Real "Extract by Email" config: the values to wire into the Cloudflare Email
// Worker so `<handle>@<domain>` addresses ingest into CYBills. Per-user addresses
// live on each user's page (Users → Manage → Edit user details).
function ExtractByEmailCard() {
  const config = useInboundConfig();
  const { membership, googleEnabled } = useAuth();
  const organisation = useActiveOrganisation();
  // The Worker credentials are the DEPLOYMENT's, not this entity's: that secret
  // authorises submitting documents for any handle in any client entity, so a
  // client's own admin has no business reading it. They still get the half that
  // is theirs — the addresses their people forward bills to.
  const canSeeWorker = isPracticeTeam(membership, googleEnabled);
  return (
    <Card title="Extract by Email">
      <p className="text-sm text-muted-foreground">
        Users email or forward bills to their own{' '}
        <code>&lt;handle&gt;{addressTail(organisation?.emailSuffix, config?.domain || 'cybills.sg')}</code> address and
        CYBills files them under that person. Each user&rsquo;s address is on their page (Users → Manage → Edit user
        details).
      </p>
      <EmailSuffixRow organisation={organisation} domain={config?.domain || 'cybills.sg'} />
      {canSeeWorker ? (
        <>
          <div className="rounded-md border p-4">
            <p className="mb-1 text-sm font-medium">Cloudflare Email Worker</p>
            <p className="mb-3 text-xs text-muted-foreground">
              Paste these into the <code>cybills-inbound</code> Worker (Settings → Variables), then set the catch-all route to
              that Worker. No server access needed.
            </p>
            {config ? (
              <div className="space-y-2">
                <CopyRow label="CYBILLS_INBOUND_URL" value={config.url || '—'} />
                <CopyRow label="INBOUND_SECRET" value={config.secret || '—'} secret />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            <code>INBOUND_SECRET</code> is the whole deployment&rsquo;s — it authorises submitting documents for any handle in
            any client entity, so it goes into the Worker and nowhere else. Full setup: <code>deploy/EMAIL-INBOUND.md</code>.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          The mail routing itself is set up once for the whole account by the practice — there is nothing to configure
          here.
        </p>
      )}
    </Card>
  );
}

// Business settings → Extraction → "Extract by WhatsApp". The other half of the
// email card above: what the CYWorkspace operator needs to hand bills back to
// CYBills. The group itself is per-entity and lives under Connections; these
// two values are the deployment's.
// How each inbound attempt reads. Refusals are worth as much as successes here:
// they say the call is being MADE, which is the half of the question CYBills
// can answer on its own.
const DELIVERY_LABEL = {
  filed: 'Filed',
  duplicate: 'Already had it',
  bad_key: 'Wrong key',
  unknown_submission: 'Unknown group',
  incomplete: 'Incomplete',
  file_unavailable: 'File unreadable',
};
const DELIVERY_TONE = {
  filed: 'text-emerald-700',
  duplicate: 'text-muted-foreground',
  bad_key: 'text-red-600',
  unknown_submission: 'text-red-600',
  incomplete: 'text-amber-700',
  file_unavailable: 'text-amber-700',
};

// A timestamp as somebody reads it back in a log — short, local, unambiguous.
const fmtStamp = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function ExtractByWhatsappCard() {
  const [config, reloadConfig] = useWhatsappConfig();
  const { membership, googleEnabled } = useAuth();
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState(null);

  const runTest = async () => {
    setTesting(true);
    setTestNote(null);
    try {
      const out = await sendTestDelivery();
      setTestNote({
        ok: true,
        text: `Delivered to ${out.group} — filed as ${out.itemId || 'a new document'}. It is in the Costs inbox; delete it when you have seen it.`,
      });
    } catch (err) {
      setTestNote({ ok: false, text: err.message });
    } finally {
      setTesting(false);
      // Refresh the log, not the page: the attempt is in it either way — which
      // is half of what the button proves — and reloading would throw away the
      // sentence saying what happened before anybody could read it.
      reloadConfig();
    }
  };
  // Same rule as the inbound-email secret, for the same reason: this key
  // authorises filing documents into ANY client entity's book, so it is the
  // practice's and not a client admin's.
  const canSeeKey = isPracticeTeam(membership, googleEnabled);
  return (
    <Card title="Extract by WhatsApp">
      <p className="text-sm text-muted-foreground">
        Each entity gets a WhatsApp group (Business settings → Connections). CYWorkspace reads every
        attachment sent into it and hands the supplier bills to CYBills, which files them under the sender
        and reads them with whatever they typed alongside — &ldquo;recharge this to CY-Biz&rdquo; is an
        instruction about that bill, and it is treated as one.
      </p>
      {canSeeKey ? (
        <>
          <div className="rounded-md border p-4">
            <p className="mb-1 text-sm font-medium">Give these to the CYWorkspace operator</p>
            <p className="mb-3 text-xs text-muted-foreground">
              CYWorkspace POSTs one bill at a time to this URL with the key in <code>X-API-Key</code>.
            </p>
            {config ? (
              <div className="space-y-2">
                <CopyRow label="CYBILLS_INVOICE_URL" value={config.url || '—'} />
                <CopyRow label="CYBILLS_API_KEY" value={config.apiKey || '—'} secret />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            The key is the whole deployment&rsquo;s — it authorises filing a bill into any client entity, so it
            goes to CYWorkspace and nowhere else. Full contract: <code>deploy/WHATSAPP.md</code>.
          </p>
          {/* "I sent a bill and nothing turned up" has two very different
              answers — CYWorkspace never called, or it called and was turned
              away — and they need different people to fix them. Every attempt
              is here, including the refused ones. */}
          <div className="rounded-md border p-4">
            <div className="mb-1 flex items-center justify-between gap-3">
              <p className="text-sm font-medium">What has arrived</p>
              {/* Proves this side end to end without waiting on CYWorkspace:
                  the server posts to its own public endpoint, over the real
                  URL, with the real key, naming a real group. */}
              <button
                type="button"
                onClick={runTest}
                disabled={testing}
                className="inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
              >
                {testing ? 'Sending…' : 'Send a test bill'}
              </button>
            </div>
            {testNote && (
              <p className={cn('mb-2 text-xs', testNote.ok ? 'text-emerald-700' : 'text-red-600')}>{testNote.text}</p>
            )}
            {config?.deliveries?.length ? (
              <ul className="mt-2 space-y-1.5 text-xs">
                {config.deliveries.map((d) => (
                  <li key={d.id} className="flex items-start gap-2">
                    <span className={cn('shrink-0 font-medium', DELIVERY_TONE[d.outcome] || 'text-muted-foreground')}>
                      {DELIVERY_LABEL[d.outcome] || d.outcome}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.detail || '—'}</span>
                    <span className="shrink-0 text-muted-foreground">{fmtStamp(d.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                CYWorkspace has never called this endpoint. Until it is given the URL and key above, a bill sent
                into a group is read by CYWorkspace and goes no further — nothing reaches CYBills to file.
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          The WhatsApp connection itself is set up once for the whole account by the practice — there is
          nothing to configure here.
        </p>
      )}
    </Card>
  );
}

function Extraction() {
  const bridge = useBridgeEntity();
  const stored = useExtractionSettings();
  const [form, setForm] = useState(stored);
  const [dirty, setDirty] = useState(false);
  const status = useAutoSave(form, (v) => { saveExtractionSettings(v); setDirty(false); });
  useEffect(() => { if (!dirty) setForm(stored); }, [stored, dirty]);
  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setDirty(true); };

  // The default-tax-rate pickers offer the SAME rates the cost/sales pickers do
  // — the visible rates from the managed Tax-rates list — plus a "None" option.
  const taxRateOptions = ['— None —', ...useVisibleTaxRates().map((t) => t.name)];

  return (
    <div className="space-y-6">
      <DocumentReaderCard value={form.readerProvider} onChange={(v) => set('readerProvider', v)} />

      <ExtractByEmailCard />

      <ExtractByWhatsappCard />

      <Card title="Inbox tabs">
        <Row label="Show To review and Ready tabs" hint="Show these tabs in the costs and sales inboxes.">
          <Toggle on={form.showReviewReadyTabs} onChange={(v) => set('showReviewReadyTabs', v)} />
        </Row>
      </Card>

      <Card title="Duplicate items">
        <Row
          label="Duplicate cost items"
          hint="Every document is checked against the ones already submitted: the identical file, the same supplier + reference + amount, or the same supplier + amount + date. Automatic holds a match back for review; Review manually lets it in carrying a “Possible duplicate” flag; Off skips the check. An identical file is always refused."
        >
          <SelectBox value={form.duplicateMode} onChange={(v) => set('duplicateMode', v)} options={DUP_MODES} />
        </Row>
      </Card>

      <Card title="Tax">
        <Row label="Extract tax" hint="Extract the tax value from new costs and sales documents.">
          <Toggle on={form.extractTax} onChange={(v) => set('extractTax', v)} />
        </Row>
        {/* A bridge entity's costs never post on their own: it has no Xero, and
            its categories are plain names with no account code in them. They
            reach the parent's ledger as the lines of an expense claim, which is
            where the category-to-account mapping is applied. Offering this here
            was a switch that could only ever do nothing. */}
        {!bridge && (
          <Row
            label="Publish to Xero after reading"
            hint="Off by default. When on, a document that's been read is posted straight to Xero as Awaiting Approval — which means nobody checks the reading first, and publishing finishes the document: it archives, and can no longer go on an expense claim. Only complete documents are posted; anything missing a supplier, date, category or total stays here to publish by hand."
          >
            <Toggle on={form.publishToXeroAfterReading} onChange={(v) => set('publishToXeroAfterReading', v)} />
          </Row>
        )}
        {/* Tax CODES, not the tax amount: a bridge entity has none of its own,
            and its claims post with No Tax at the full amount. The amount is
            still extracted above — that is what the paper says. */}
        {!bridge && (
          <>
            <Row label="Default tax rate for costs">
              <SelectBox value={form.defaultTaxRateCosts || '— None —'} onChange={(v) => set('defaultTaxRateCosts', v === '— None —' ? '' : v)} options={taxRateOptions} />
            </Row>
            <Row label="Default tax rate for sales">
              <SelectBox value={form.defaultTaxRateSales || '— None —'} onChange={(v) => set('defaultTaxRateSales', v === '— None —' ? '' : v)} options={taxRateOptions} />
            </Row>
          </>
        )}
      </Card>

      <Card title="Due dates">
        <Row label="Due date for costs invoices">
          <SelectBox value={form.dueCostsMode} onChange={(v) => set('dueCostsMode', v)} options={DUE_MODES} />
        </Row>
        <Row label="How many days (costs)">
          <SelectBox value={form.dueCostsDays} onChange={(v) => set('dueCostsDays', v)} options={DUE_DAYS} />
        </Row>
        <Row label="Due date for sales invoices">
          <SelectBox value={form.dueSalesMode} onChange={(v) => set('dueSalesMode', v)} options={DUE_MODES} />
        </Row>
        <Row label="How many days (sales)">
          <SelectBox value={form.dueSalesDays} onChange={(v) => set('dueSalesDays', v)} options={DUE_DAYS} />
        </Row>
      </Card>

      <Card title="Payment status">
        {/* Two things this does NOT do, both of which read as it being broken:
            it doesn't reach back over documents already added (Paid is the
            reviewer's own flag, and rewriting it would overwrite somebody's
            answer), and it doesn't beat a supplier's own rule. Said here rather
            than left to be worked out from a document that won't change. */}
        <p className="text-sm text-muted-foreground">
          How a costs document arrives, by its type. This is the starting point for documents added from now
          on — it doesn&rsquo;t change ones already in the inbox, and a supplier whose rules set Paid wins over it.
          To change documents already here, tick them in the Costs inbox and use{' '}
          <span className="font-medium text-foreground">Bulk edit → Paid</span>.
        </p>
        <Row label="Receipts"><SelectBox value={form.payReceipts} onChange={(v) => set('payReceipts', v)} options={PAID_OPTIONS} /></Row>
        <Row label="Invoices"><SelectBox value={form.payInvoices} onChange={(v) => set('payInvoices', v)} options={PAID_OPTIONS} /></Row>
        <Row label="Credit notes"><SelectBox value={form.payCreditNotes} onChange={(v) => set('payCreditNotes', v)} options={PAID_OPTIONS} /></Row>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <SaveStatus status={status} />
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

      <Card title="Line item grouping">
        <Row
          label="Group uncategorised lines"
          hint="Group together line items that don’t match any group in your list."
        >
          <Toggle />
        </Row>
      </Card>

      <Card title="Archive">
        <p className="text-sm text-muted-foreground">Archive items after you complete these actions.</p>
        <Row label="Archive after adding to expense claim"><Toggle defaultOn /></Row>
        <Row label="Archive after exporting to CSV"><Toggle defaultOn /></Row>
      </Card>

    </div>
  );
}

function Exports() {
  const stored = useExportSettings();
  const [form, setForm] = useState(stored);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (!dirty) setForm(stored); }, [stored, dirty]);

  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setDirty(true); };
  const toggleColumn = (c) => {
    setForm((f) => {
      const has = f.columns.includes(c);
      return { ...f, columns: has ? f.columns.filter((x) => x !== c) : [...f.columns, c] };
    });
    setDirty(true);
  };
  const status = useAutoSave(form, (v) => { saveExportSettings(v); setDirty(false); });

  return (
    <div className="space-y-6">
      <Card title="CSV Exports">
        <p className="text-sm text-muted-foreground">Choose how the data in CSV file exports gets formatted.</p>
        {/* CYBills Default and Custom CSV, and nothing else. "Xero" and
            "QuickBooks" were Dext's list: neither ever shaped a file, so
            picking one produced exactly the same CSV as the default — a choice
            with no consequence, which is worse than no choice. */}
        <Row label="Receipts and invoices"><SelectBox value={form.receiptsFormat} onChange={(v) => set('receiptsFormat', v)} options={RECEIPT_FORMATS} /></Row>
        <Row label="Bank statements"><SelectBox value={form.bankFormat} onChange={(v) => set('bankFormat', v)} options={['CYBills Excel', 'Custom']} /></Row>
        <Row label="Sales documents"><SelectBox value={form.salesFormat} onChange={(v) => set('salesFormat', v)} options={['CYBills Sales Default', 'Custom']} /></Row>
        <Row label="Expense reports"><SelectBox value={form.expenseFormat} onChange={(v) => set('expenseFormat', v)} options={['CYBills Default', 'Custom']} /></Row>
        <Row label="Show net amount" hint="Include the net value field in CSV exports."><Toggle on={form.showNet} onChange={(v) => set('showNet', v)} /></Row>
      </Card>

      <Card title="CSV Custom Exports">
        <p className="text-sm text-muted-foreground">Choose how the data in Custom CSV file exports gets formatted. Applied when you pick <span className="font-medium">Custom CSV</span> when exporting costs, sales, or an expense claim.</p>
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

      <Card title="Image sharing">
        <Row
          label="Allow sharing of source document images with exports"
          hint="Include links to the images of source documents when you export items as a CSV file or a PDF file. The links are signed and expire after 30 days, so they open without a CYBills sign-in. Turning this off stops new links being written — and stops the ones already exported from opening."
        >
          <Toggle on={form.imageSharing} onChange={(v) => set('imageSharing', v)} />
        </Row>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <SaveStatus status={status} />
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

// Business settings → Connections. Xero is the only accounting software CYBills
// speaks to (through the cyworkspace relay), and the page says so about THIS
// entity — a bridge entity reaches Xero through the entity it publishes into,
// which is a different answer from "connected" and from "not connected".
// Business settings → Connections → Payment status. Xero's invoice webhook only
// ever tells us about what changes AFTER it was configured, so a bill paid last
// month fired its notice into a void and would show no status forever. This
// button is the catch-up for those, and the repair for any delivery Xero
// dropped — re-running it is safe, it only ever reads.
function PaymentStatusCard({ organisation }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await syncXeroPayments(organisation.id));
    } catch (err) {
      setError(err?.message || 'Could not check payment status in Xero.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Payment status">
      <div className="rounded-lg border p-5">
        <p className="font-medium">Check published bills against Xero</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Xero tells CYBills when a published bill is paid, so the Paid status column keeps itself up to
          date. It can only report what happens from now on, though — run this once to catch up the bills
          that were already settled before it was switched on.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:opacity-60"
          >
            {busy ? 'Checking…' : 'Check now'}
          </button>
          {result && (
            <p className="text-sm text-muted-foreground">
              Checked {result.checked} published {result.checked === 1 ? 'bill' : 'bills'} — {result.updated} updated,{' '}
              {result.paid} paid in Xero
              {result.missing ? `, ${result.missing} no longer in Xero` : ''}
              {result.remaining ? `. ${result.remaining} still to check — run it again.` : '.'}
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </div>
    </Card>
  );
}

// Business settings → Connections → WhatsApp. One bill collection group per
// client entity: the people who actually hold the invoices send photos and PDFs
// into a WhatsApp group, CYWorkspace classifies each attachment, and the
// supplier bills among them land in this entity's Costs inbox.
//
// The button makes a REAL WhatsApp group and adds real phone numbers to it, so
// it is the only thing in the app that can: nothing here creates one on load,
// on save, or as a side effect of anything else.
function WhatsappCollectionCard() {
  const organisation = useActiveOrganisation();
  const [{ channels, enabled, canManage, loading }, reload] = useWhatsappChannels();
  const [open, setOpen] = useState(false);
  const [numbers, setNumbers] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The entity-wide group is the one this card CREATES; the list below shows
  // every group the entity collects through, its people's own included.
  const channel = channels.find((c) => !c.userId) || null;
  const pending = channel && channel.status !== 'open';
  const openGroups = channels.filter((c) => c.status === 'open');

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const participants = numbers.split(/[\s,;]+/).map((n) => n.trim()).filter(Boolean);
      await createWhatsappChannel({ participants, subject: subject.trim() });
      setNumbers('');
      setSubject('');
      setOpen(false);
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;

  const form = (
    <div className="mt-4 space-y-3 border-t pt-4">
      <div>
        <label htmlFor="wa-numbers" className="text-sm font-medium">WhatsApp numbers</label>
        <p className="mt-1 text-xs text-muted-foreground">
          Full international format, digits only — <code>6591234567</code>, not <code>91234567</code>. Several
          go on separate lines.
        </p>
        <textarea
          id="wa-numbers"
          rows={2}
          value={numbers}
          onChange={(e) => setNumbers(e.target.value)}
          placeholder="6591234567"
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div>
        <label htmlFor="wa-subject" className="text-sm font-medium">Group name</label>
        <input
          id="wa-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={`CYBills - ${organisation?.name || 'this entity'}`}
          className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={create}
          disabled={busy || !numbers.trim()}
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Creating…' : pending ? 'Try again' : 'Create the group'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null); }}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {error.message}
            {error.rejected?.length ? (
              <> Check <span className="font-mono">{error.rejected.join(', ')}</span>.</>
            ) : null}
            {/* A group may exist at the far end even when the answer never came
                back. Pressing again reuses the same submission id, so it adopts
                that group instead of making a second one. */}
            {error.retryable ? ' Pressing the button again is safe — it picks up the same group rather than making another.' : ''}
          </span>
        </div>
      )}
    </div>
  );

  return (
    <Card title="WhatsApp bill collection">
      <div className="rounded-lg border p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 font-medium">
              <MessageCircle className="h-4 w-4" strokeWidth={1.75} /> Collect bills in a WhatsApp group
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              CYBot opens a WhatsApp group with the people who hold this entity&rsquo;s invoices. Anything they
              send into it is read, and the supplier bills among them arrive in the Costs inbox. Receipts,
              sales invoices and everything else are left where they are.
            </p>
          </div>
          {/* A status, said as one. Boxed and button-sized it read as something
              to click — and there is nothing to click: WhatsApp has no link that
              opens a group by its id, and CYWorkspace mints no invite link. */}
          <span className="shrink-0 pt-1 text-sm text-muted-foreground">
            {openGroups.length
              ? `${openGroups.length} group${openGroups.length === 1 ? '' : 's'}`
              : pending
                ? 'Not created'
                : 'Not set up'}
          </span>
        </div>

        {!enabled ? (
          <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">
            CYWorkspace isn&rsquo;t connected on this deployment yet, so there is nothing to create the group
            with. It comes on with the same key the Xero relay uses.
          </p>
        ) : openGroups.length ? (
          <>
            {/* Every group, because a count beside the wrong one is worse than
                no count: this card showed "0 bills" for the entity's group while
                three had just arrived through somebody's own, which was not on
                the page at all. */}
            <div className="mt-4 divide-y border-t">
              {openGroups.map((g) => (
                <div key={g.submissionId} className="flex items-start justify-between gap-4 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{g.subject}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {g.personName ? (
                        <>{g.personName}&rsquo;s own group</>
                      ) : (
                        <>This entity&rsquo;s group</>
                      )}
                      {/* The numbers we ASKED with. WhatsApp answers with LIDs —
                          opaque per-user ids — and printing those put 15-digit
                          numbers in front of the reader with no way to tell
                          whose they were. */}
                      {g.participantsRequested.length ? (
                        <> · <span className="font-mono">{g.participantsRequested.join(', ')}</span></>
                      ) : null}
                    </p>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                    {g.received} {g.received === 1 ? 'bill' : 'bills'}
                  </span>
                </div>
              ))}
            </div>
            {/* WhatsApp silently refuses to add somebody whose privacy settings
                disallow it, and answers as though nothing happened. Saying so is
                the only way anybody finds out — otherwise that person waits to
                be added to a group they will never see.
                
                Named only when WhatsApp gave back something we can match to a
                number we sent; otherwise all that is honestly known is how many
                are short. There is no invite link to offer — CYWS's API doesn't
                mint one — so the instruction is what can actually be done. */}
            {channel && (channel.participantsMissing.length > 0 || channel.addedShortfall > 0) && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-600/30 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {channel.participantsMissing.length > 0 ? (
                    <>
                      WhatsApp wouldn&rsquo;t add{' '}
                      <span className="font-mono">{channel.participantsMissing.join(', ')}</span> — their privacy
                      settings don&rsquo;t allow being added to groups.
                    </>
                  ) : (
                    <>
                      WhatsApp added {channel.participantsAddedCount} of the{' '}
                      {channel.participantsRequested.length} numbers asked for — the rest have privacy settings
                      that don&rsquo;t allow being added to groups.
                    </>
                  )}{' '}
                  Someone already in the group has to add them from inside WhatsApp.
                </span>
              </div>
            )}
            {canManage && !open && (
              <button
                type="button"
                onClick={() => setOpen(true)}
                className="mt-4 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Create another group for this entity
              </button>
            )}
          </>
        ) : (
          <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">
            {pending
              ? `The last attempt didn't complete${channel.lastError ? `: ${channel.lastError}` : '.'} Trying again picks up where it left off rather than creating a second group.`
              : 'No group yet.'}
          </p>
        )}

        {enabled && canManage && !open && channel?.status !== 'open' && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mt-4 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            {pending ? 'Try again' : 'Set up the group'}
          </button>
        )}
        {enabled && canManage && open && form}
        {enabled && !canManage && (
          <p className="mt-4 text-xs text-muted-foreground">
            An admin of this entity sets the group up.
          </p>
        )}
      </div>
    </Card>
  );
}

function Connections() {
  const organisation = useActiveOrganisation();
  const bridge = isStandaloneOrg(organisation);
  const parentName = organisation?.parentName || '';
  const tenantName = organisation?.tenantName || '';
  const status = tenantName ? 'Connected' : bridge ? 'Indirect' : 'Not connected';

  return (
    <div className="space-y-5">
      <Card title="Accounting software">
        <div className="rounded-lg border p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium">Publish bookkeeping to Xero</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {bridge
                  ? 'Expense claims raised here are published into the Xero of the entity below. There is no chart of accounts to read on this side — that is what makes it a bridge.'
                  : `CYBills reads ${organisation?.name || 'this entity'}'s chart, tax rates and contacts from Xero, and publishes bills and expense claims back to it.`}
              </p>
            </div>
            <span className="inline-flex h-9 shrink-0 items-center rounded-md border px-4 text-sm font-medium text-muted-foreground">
              {status}
            </span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {/* Xero and nothing else. The greyed-out QuickBooks / Sage / "+22
                more" that used to sit here were Dext's list, not ours — names of
                software CYBills has never spoken to, offered as though they were
                a click away. */}
            <span className="inline-flex h-8 items-center rounded-md border border-foreground/30 bg-muted px-3 text-sm font-medium">
              Xero
            </span>
          </div>
          {tenantName ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Linked to <span className="font-medium text-foreground">{tenantName}</span> in Xero.
            </p>
          ) : bridge ? (
            <p className="mt-4 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{organisation.name}</span> keeps no books of
              its own — it is <span className="font-medium text-foreground">indirectly linked</span> through{' '}
              <span className="font-medium text-foreground">{parentName || 'the entity it publishes into'}</span>,
              whose Xero receives the expense claims raised here. Its categories map to that entity&apos;s
              accounts in <span className="font-medium text-foreground">Lists → Categories</span>.
            </p>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              Not linked yet. Add a Xero organisation from the entity menu (top-left) to publish
              through the relay.
            </p>
          )}
        </div>
      </Card>
      {/* Only where there is a Xero to ask. A bridge entity's own claims post
          into its parent's ledger, so its published bills have a status to
          check too. */}
      {organisation?.id && (tenantName || bridge) && <PaymentStatusCard organisation={organisation} />}
      {/* Not gated on Xero: a bridge entity collects bills the same way, and a
          group is about who sends the paperwork in, not about where it posts. */}
      {organisation?.id && <WhatsappCollectionCard />}
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

  // SMTP (env-configured) vs Microsoft 365 (delegated OAuth). SMTP has no
  // interactive connect step, so its UI is just "sending as … + test".
  const smtp = Boolean(status.smtp);
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
                {smtp ? 'SMTP' : 'Microsoft 365'}
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
              {status.configured && !smtp && (
                <button type="button" onClick={connectMailbox} className={status.connected ? btn : primary}>
                  {status.connected || status.needsReconnect ? 'Reconnect' : 'Connect mailbox'}
                </button>
              )}
              {(status.connected || status.needsReconnect) && !smtp && (
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
                {status.sharedSender && !smtp && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    shared mailbox, authorised by {status.account}
                  </span>
                )}
              </dd>
              {smtp ? (
                <>
                  <dt className="text-muted-foreground">Delivery</dt>
                  <dd>SMTP</dd>
                </>
              ) : (
                <>
                  <dt className="text-muted-foreground">Connected by</dt>
                  <dd>{status.connectedBy}{status.connectedAt ? ` · ${new Date(status.connectedAt).toLocaleDateString()}` : ''}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      </Card>

      {smtp ? (
        <Card title="How it's sent">
          <div className="rounded-lg border p-5 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <ShieldCheck className="h-4 w-4" /> Send-only, via SMTP
            </p>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted-foreground">
              <li>All account email is sent as <span className="font-medium text-foreground">{status.sendingAs}</span> through your SMTP provider.</li>
              <li>Configured on the server — it isn&rsquo;t tied to any user&rsquo;s mailbox, so there&rsquo;s nothing to connect or disconnect here.</li>
              <li>It can only send; it can&rsquo;t read or access any inbox.</li>
              <li>To change the sending address or provider, update the <code className="rounded bg-muted px-1 text-xs">SMTP_*</code> / <code className="rounded bg-muted px-1 text-xs">MAIL_FROM</code> values on the server.</li>
            </ul>
          </div>
        </Card>
      ) : (
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
      )}
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
  // Deep-link support: /settings?section=extraction opens that section directly.
  // Unknown/removed sections fall back to Business profile.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('section');
  const [section, setSection] = useState(() => (requested && TITLES[requested] ? requested : 'business'));
  // The account-wide sections are the practice's, in the practice's own entity.
  // Both halves matter: it is not a client's setting, and it is not a client
  // admin's to change.
  const { membership, googleEnabled } = useAuth();
  const inPrimary = useIsPrimaryOrganisation();
  const accountWide = inPrimary && isPracticeTeam(membership, googleEnabled);
  // A deep link (or the mail callback) naming a section this entity does not
  // have lands on Business profile rather than on a page that isn't offered.
  const shown = ACCOUNT_WIDE.has(section) && !accountWide ? 'business' : section;

  const selectSection = (key) => {
    setSection(key);
    // Reflect the choice in the URL (replace, so back doesn't step through tabs).
    setSearchParams(key === 'business' ? {} : { section: key }, { replace: true });
  };

  return (
    <AppShell hideSidebar subnav={<SettingsNav nav={navFor(accountWide)} active={shown} onSelect={selectSection} />}>
      <h1 className="mb-6 text-xl font-semibold tracking-tight">{TITLES[shown]}</h1>
      {shown === 'business' ? (
        <BusinessProfile />
      ) : shown === 'connections' ? (
        <Connections />
      ) : shown === 'extraction' ? (
        <Extraction />
      ) : shown === 'automation' ? (
        <Automation />
      ) : shown === 'email' ? (
        <EmailSettings />
      ) : shown === 'exports' ? (
        <Exports />
      ) : shown === 'lists' ? (
        <ListsSettings />
      ) : shown === 'vault' ? (
        <VaultSettings />
      ) : (
        <Placeholder label={TITLES[shown]} />
      )}
    </AppShell>
  );
}
