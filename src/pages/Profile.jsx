import { useState } from 'react';
import { ChevronDown, CheckCircle2 } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { useAuth } from '@/lib/auth';
import ChangeEmailModal from '@/components/ChangeEmailModal';
import ChangePasswordModal from '@/components/ChangePasswordModal';
import { useProfile, setBookkeepingFreq, setBookkeepingToggle, setApprovalFreq } from '@/lib/profileStore';
import { updateUser, normalizeRole, isAdminAccess } from '@/lib/userStore';
import { cn } from '@/lib/utils';

const NAV = [
  { key: 'personal', label: 'Personal details' },
  { key: 'login', label: 'Login details' },
  { key: 'security', label: 'Security' },
  { key: 'language', label: 'Language and time zone' },
  { key: 'bookkeeping', label: 'Bookkeeping email notifications' },
  { key: 'approval', label: 'Approval email notifications' },
];

function ProfileNav({ active, onSelect }) {
  return (
    <div className="p-3 text-sm">
      {NAV.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelect(item.key)}
          className={cn(
            'flex w-full items-center rounded-md px-3 py-2 text-left transition-colors',
            active === item.key
              ? 'border-l-2 border-foreground bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// --- Reusable primitives ---------------------------------------------------
function Card({ title, children }) {
  return (
    <section className="overflow-hidden rounded-lg border bg-background">
      <div className="border-b px-5 py-4 text-base font-semibold tracking-tight">{title}</div>
      <div className="space-y-5 p-5">{children}</div>
    </section>
  );
}

function Row({ label, required = false, children }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[220px_1fr] sm:items-center">
      <span className="text-sm font-medium">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      <div>{children}</div>
    </div>
  );
}

// Controlled when `value`+`onChange` are given, else uncontrolled via defaultValue.
function Select({ defaultValue = undefined, value = undefined, onChange = undefined, options }) {
  const controlled = value !== undefined && onChange;
  return (
    <div className="relative">
      <select
        {...(controlled ? { value, onChange: (e) => onChange(e.target.value) } : { defaultValue })}
        className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function OutlineButton({ children, onClick }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex h-9 shrink-0 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
      {children}
    </button>
  );
}

// Controlled when `on`+`onToggle` are given, else self-managed via defaultOn.
function Toggle({ defaultOn = false, on: onProp = undefined, onToggle = undefined }) {
  const [localOn, setLocalOn] = useState(defaultOn);
  const controlled = onProp !== undefined && onToggle;
  const on = controlled ? onProp : localOn;
  const toggle = () => (controlled ? onToggle(!on) : setLocalOn((v) => !v));
  return (
    <button type="button" onClick={toggle} className="inline-flex items-center gap-2 text-sm">
      <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-foreground' : 'justify-start bg-muted')}>
        <span className="h-4 w-4 rounded-full bg-background" />
      </span>
      <span className="text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

// A "title + description" row with a control on the right (security / 2FA).
function ActionRow({ title, desc, children }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        {desc && <p className="mt-0.5 text-sm text-muted-foreground">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const FREQ = ['Daily', 'Weekly', 'Never'];
const APPROVAL_FREQ = ['Instantly', 'Group hourly', 'Group daily', 'Never'];

// Controlled text input (Personal details is editable + saved).
function EditInput({ value, onChange, placeholder = '' }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

// --- Sections ---------------------------------------------------------------
function PersonalDetails({ rosterUser, refresh, onSaved, isAdmin }) {
  const name0 = rosterUser?.name || '';
  const first0 = rosterUser?.firstName || name0.split(' ')[0] || '';
  const last0 = rosterUser?.lastName || name0.split(' ').slice(1).join(' ') || '';
  const mobile0 = rosterUser?.mobile || '';
  const [first, setFirst] = useState(first0);
  const [last, setLast] = useState(last0);
  const [mobile, setMobile] = useState(mobile0);
  const [saving, setSaving] = useState(false);

  const dirty = first !== first0 || last !== last0 || mobile !== mobile0;
  const canSave = Boolean(rosterUser?.id) && first.trim() && last.trim() && dirty && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await updateUser(rosterUser.id, {
        firstName: first.trim(),
        lastName: last.trim(),
        name: `${first.trim()} ${last.trim()}`.trim(),
        mobile: mobile.trim(),
      });
      await refresh?.(); // refetch session/roster so the header updates too
      onSaved?.('Your details were saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Personal details">
      <Row label="First name" required><EditInput value={first} onChange={setFirst} /></Row>
      <Row label="Last name" required><EditInput value={last} onChange={setLast} /></Row>
      <Row label="Mobile number">
        <div className="flex gap-2">
          <div className="w-24"><Select defaultValue="+65" options={['+65', '+60', '+1', '+44', '+61']} /></div>
          <div className="flex-1"><EditInput value={mobile} onChange={setMobile} placeholder="Mobile number" /></div>
        </div>
      </Row>
      {/* Read-only — only an admin can change a role, in Users. Shown because
          the role is what decides whether Users + Business settings appear in
          the sidebar; without it, losing admin looks like the buttons vanished. */}
      <Row label="Role">
        <div className="space-y-1">
          <span className="inline-flex h-9 items-center rounded-md border bg-muted px-3 text-sm">
            {normalizeRole(rosterUser?.role)}
          </span>
          <p className="text-xs text-muted-foreground">
            {isAdmin
              ? 'Admins can open Users and Business settings (categories, lists, exports).'
              : 'Users and Business settings (categories, lists, exports) are Admin-only. Ask an admin to change your role in Users.'}
          </p>
        </div>
      </Row>
      <div className="flex items-center justify-end gap-3 border-t pt-4">
        {!rosterUser?.id && (
          <span className="text-xs text-muted-foreground">Your profile isn’t on the team roster yet, so it can’t be saved here.</span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className={cn(
            'inline-flex h-9 items-center rounded-md px-4 text-sm font-medium transition-opacity',
            canSave ? 'bg-foreground text-background hover:opacity-90' : 'bg-muted text-muted-foreground cursor-not-allowed'
          )}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Card>
  );
}

function LoginDetails({ email, onChangeEmail }) {
  return (
    <Card title="Login details">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          Your current email is <span className="font-semibold">{email}</span>
        </p>
        <OutlineButton onClick={onChangeEmail}>Change</OutlineButton>
      </div>
    </Card>
  );
}

function Security({ onChangePassword }) {
  return (
    <Card title="Security">
      <ActionRow title="Password" desc="Update your password to keep your account safe">
        <OutlineButton onClick={onChangePassword}>Change</OutlineButton>
      </ActionRow>
    </Card>
  );
}

function LanguageZone() {
  return (
    <Card title="Language and time zone">
      <Row label="Language"><Select defaultValue="English" options={['English', 'Bahasa Melayu', '中文', 'Tamil']} /></Row>
      <Row label="Time zone"><Select defaultValue="Asia - Singapore" options={['Asia - Singapore', 'Asia - Kuala Lumpur', 'Asia - Hong Kong', 'UTC']} /></Row>
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-3 text-sm">
        <span className="text-muted-foreground">ⓘ</span>
        <span>
          <span className="font-medium">We&rsquo;ve automatically detected your time zone.</span>{' '}
          <span className="text-muted-foreground">Confirm your time zone is Asia - Singapore or choose one from the list. You can change this at any time.</span>
        </span>
      </div>
    </Card>
  );
}

const BOOKKEEPING = [
  ['On acknowledgement', 'Keep this setting on to receive notifications about rejected items and inbox issues.'],
  ['Account', 'Keep this setting on to receive emails about general account information.'],
  ['Security', 'Keep this setting on to receive security alerts.'],
  ['Processing', 'Processing emails provide an overview of the items added to your account.'],
  ['Auto-publishing', 'Keep this setting on to receive notifications about items that were unable to auto-publish.'],
  ['Fetch', 'Keep this setting on to receive an email if your Fetch connections fail.'],
  ['Bank feeds', 'Keep this setting on to receive bank feed related emails.'],
];

function Bookkeeping() {
  const profile = useProfile();
  const isOn = (title) => profile.bookkeeping[title] ?? true; // default on
  return (
    <Card title="Bookkeeping email notifications">
      <Row label="Frequency">
        <Select value={profile.bookkeepingFreq} onChange={setBookkeepingFreq} options={FREQ} />
      </Row>
      {BOOKKEEPING.map(([title, desc]) => (
        <div key={title} className="flex flex-wrap items-start justify-between gap-3 border-t pt-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold">{title}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{desc}</p>
          </div>
          <Toggle on={isOn(title)} onToggle={(v) => setBookkeepingToggle(title, v)} />
        </div>
      ))}
    </Card>
  );
}

const APPROVAL = [
  ['Items you need to approve', 'Choose how often emails are sent about items that need your approval', 'Group hourly'],
  ['Your rejected items', "Choose how often emails are sent about rejected items that you've submitted for approval", 'Instantly'],
  ['Your cancelled items', 'Choose how often emails are sent about items that have been cancelled', 'Instantly'],
  ['Your approved costs', 'Choose how often emails are sent about your costs that have been approved', 'Never'],
  ['Your approved expense claims', 'Choose how often emails are sent about your expense claims that have been approved', 'Instantly'],
  ['Your approved sales', 'Choose how often emails are sent about your sales that have been approved', 'Never'],
];

function Approval() {
  const profile = useProfile();
  return (
    <Card title="Approval email notifications">
      {APPROVAL.map(([title, desc, def]) => (
        <div key={title} className="grid grid-cols-1 gap-2 border-b pb-4 last:border-0 last:pb-0 sm:grid-cols-[1fr_220px] sm:items-center">
          <div>
            <p className="text-sm font-semibold">{title}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{desc}</p>
          </div>
          <Select value={profile.approval[title] ?? def} onChange={(v) => setApprovalFreq(title, v)} options={APPROVAL_FREQ} />
        </div>
      ))}
    </Card>
  );
}

const SECTIONS = {
  personal: PersonalDetails,
  login: LoginDetails,
  security: Security,
  language: LanguageZone,
  bookkeeping: Bookkeeping,
  approval: Approval,
};

export default function Profile() {
  const { user, membership, googleEnabled, refresh } = useAuth();
  const profile = useProfile();
  const [section, setSection] = useState('personal');
  const [emailModal, setEmailModal] = useState(false);
  const [pwModal, setPwModal] = useState(false);
  const [toast, setToast] = useState('');

  // The CYBills roster row is the editable identity (managed in Users); the raw
  // session name comes from the Google profile and may differ.
  const rosterUser = membership?.user || null;
  // A locally-changed email (Change email) takes precedence over the session one.
  // Never fall back to a hardcoded identity — show the real signed-in user only.
  const email = profile.email || rosterUser?.email || user?.email || '';

  const props = {
    rosterUser,
    isAdmin: isAdminAccess(membership, googleEnabled),
    refresh,
    onSaved: (msg) => setToast(msg),
    email,
    onChangeEmail: () => setEmailModal(true),
    onChangePassword: () => setPwModal(true),
  };
  const Section = SECTIONS[section];

  return (
    <AppShell subnav={<ProfileNav active={section} onSelect={setSection} />}>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Profile</h1>
      {toast && (
        <div className="mb-4 flex max-w-3xl items-center gap-2 rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> {toast}
          <button type="button" onClick={() => setToast('')} className="ml-auto text-emerald-700/70 hover:text-emerald-700">Dismiss</button>
        </div>
      )}
      <div className="max-w-3xl">
        <Section {...props} />
      </div>

      <ChangeEmailModal
        key={emailModal ? email : 'closed'}
        open={emailModal}
        currentEmail={email}
        onClose={() => setEmailModal(false)}
        onSaved={(e) => setToast(`Email updated to ${e}.`)}
      />
      <ChangePasswordModal
        open={pwModal}
        hasPassword={Boolean(membership?.user?.hasPassword)}
        onClose={() => setPwModal(false)}
        onSaved={() => setToast('Password updated. We’ve emailed you a confirmation.')}
      />
    </AppShell>
  );
}
