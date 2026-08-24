import { useState } from 'react';
import { X, ChevronDown, HelpCircle, Copy, Check, Mail, ExternalLink } from 'lucide-react';
import { ROLES, ROLE_INFO, updateUser, dismissForward } from '@/lib/userStore';
import { PRACTICE_ROLES, PRACTICE_ROLE_INFO } from '@/lib/practiceStore';
import { useOrganisations } from '@/lib/organisations';
import { cn } from '@/lib/utils';

// The mail domain user inbound addresses live on (mirrors the server's
// INBOUND_MAIL_DOMAIN default).
const INBOUND_DOMAIN = 'cybills.sg';

// "Extract by email" — the user's inbound address plus any Gmail forwarding
// confirmation CYBills is holding for them to click.
function ExtractByEmail({ user }) {
  const [copied, setCopied] = useState(false);
  const address = user.emailHandle ? `${user.emailHandle}@${INBOUND_DOMAIN}` : '';
  const pending = user.pendingForward;
  if (!address) return null;
  const copy = () => {
    navigator.clipboard?.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Mail className="h-4 w-4" strokeWidth={1.75} /> Extract by email
      </div>
      <p className="text-xs text-muted-foreground">
        Forward bills to this address and CYBills files them under {user.name || 'this user'}.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 text-sm">{address}</code>
        <button type="button" onClick={copy} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Gmail forwarding confirmation caught for this user */}
      {pending ? (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-3 dark:bg-amber-500/10">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">Forwarding confirmation received</p>
          <p className="text-xs text-amber-900/80 dark:text-amber-200/80">
            Google sent a confirmation for a forward to this address. Open the link{pending.code ? `, or enter code ${pending.code},` : ''} to finish setting it up.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {pending.url && (
              <a href={pending.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90">
                <ExternalLink className="h-3.5 w-3.5" /> Confirm forwarding
              </a>
            )}
            {pending.code && (
              <code className="rounded border bg-background px-2 py-1 text-xs">{pending.code}</code>
            )}
            <button
              type="button"
              onClick={() => dismissForward(user.id)}
              className="ml-auto text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          When {user.name || 'this user'} sets up Gmail forwarding to this address, Google&rsquo;s confirmation link will
          appear here to click — no mailbox needed.
        </p>
      )}
    </div>
  );
}

function Toggle({ on, onToggle }) {
  return (
    <button type="button" onClick={onToggle} className="flex items-center gap-2">
      <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', on ? 'justify-end bg-foreground' : 'justify-start border')}>
        <span className={cn('h-4 w-4 rounded-full', on ? 'bg-background' : 'bg-muted-foreground/50')} />
      </span>
      <span className="text-sm text-muted-foreground">{on ? 'Yes' : 'No'}</span>
    </button>
  );
}

// Splits a combined display name into first / last for editing.
function splitName(user) {
  if (user.firstName || user.lastName) return { first: user.firstName || '', last: user.lastName || '' };
  const parts = String(user.name || '').trim().split(/\s+/);
  return { first: parts.shift() || '', last: parts.join(' ') };
}

// Edit an existing user's details or privileges (Manage → Edit user details /
// Edit privileges). `mode` is 'details' or 'privileges'.
//
// `practice` switches this to a colleague: the role being edited is then their
// role in the PRACTICE (Owner / Practice Admin / Standard), not a role inside a
// client entity — a colleague is a Business Admin in every client they're given,
// and which clients those are is granted separately (Manage → Client access).
// There is no organisation to move them to either, since they belong to none.
export default function EditUserModal({ open, mode, user, practice = false, onClose }) {
  const seed = user ? splitName(user) : { first: '', last: '' };
  const [firstName, setFirstName] = useState(seed.first);
  const [lastName, setLastName] = useState(seed.last);
  const [login, setLogin] = useState(user?.login === 'Yes');
  const [email, setEmail] = useState(user?.email || '');
  const [role, setRole] = useState((practice ? user?.practiceRole : user?.role) || 'Standard');
  const [priv, setPriv] = useState(user?.privileges || { accessAll: false, createClaims: false, canPublish: false });
  // Rosters are per-organisation, so an admin can move someone to another entity
  // — the row then only appears (and is only manageable) under that one.
  const { data: organisations = [] } = useOrganisations();
  const [organisationId, setOrganisationId] = useState(user?.organisationId || '');

  if (!open || !user) return null;

  const movingOut = organisationId && organisationId !== user.organisationId;

  const input = 'h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const isDetails = mode === 'details';
  const emailValid = !login || /.+@.+\..+/.test(email.trim());
  const canSave = isDetails ? firstName.trim() && lastName.trim() && emailValid : true;

  const save = () => {
    if (isDetails) {
      updateUser(user.id, {
        firstName,
        lastName,
        login: login ? 'Yes' : 'No',
        email: login ? email : '',
        ...(movingOut ? { organisationId } : {}),
      });
    } else {
      updateUser(user.id, practice ? { practiceRole: role, privileges: priv } : { role, privileges: priv });
    }
    onClose();
  };
  const setP = (k, v) => setPriv((p) => ({ ...p, [k]: v }));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">
            {isDetails ? (practice ? 'Edit colleague details' : 'Edit user details') : 'Edit privileges'}
          </h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {isDetails ? (
            <div className="space-y-5">
              <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                <span>First name <span className="text-destructive">*</span></span>
                <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={input} />
              </label>
              <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                <span>Last name <span className="text-destructive">*</span></span>
                <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={input} />
              </label>
              {!practice && organisations.length > 1 && (
                <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                  <span>Organisation</span>
                  <div className="relative">
                    <select
                      value={organisationId}
                      onChange={(e) => setOrganisationId(e.target.value)}
                      className="h-10 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {organisations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </label>
              )}
              {movingOut && (
                <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                  Moving {user.name} to another organisation removes them from this
                  one&apos;s user list, and clears their direct-manager links.
                </p>
              )}
              <div className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                <span className="flex items-center gap-1">Login access <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" /></span>
                <Toggle on={login} onToggle={() => setLogin((v) => !v)} />
              </div>
              {login ? (
                <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                  <span>Email <span className="text-destructive">*</span></span>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className={input} />
                </label>
              ) : (
                <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                  Without login access this {practice ? 'colleague' : 'user'} can’t sign in — no email is required.
                </p>
              )}
              {!practice && <ExtractByEmail user={user} />}
            </div>
          ) : (
            <div className="space-y-5">
              <label className="grid grid-cols-[140px_1fr] items-center gap-4 text-sm">
                <span>Role</span>
                <div className="relative">
                  <select value={role} onChange={(e) => setRole(e.target.value)} className="h-10 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {(practice ? PRACTICE_ROLES : ROLES).map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </label>
              <div className="text-sm">
                <p className="font-medium">{role} {practice ? 'colleagues' : 'users'} can:</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {((practice ? PRACTICE_ROLE_INFO : ROLE_INFO)[role] || []).map((line) => <li key={line}>{line}</li>)}
                </ul>
              </div>
              {role === 'Standard' && !practice && (
                <div className="space-y-4">
                  <p className="text-sm font-medium">and optionally:</p>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Access all documents</span>
                    <Toggle on={priv.accessAll} onToggle={() => setP('accessAll', !priv.accessAll)} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Create expense claims</span>
                    <Toggle on={priv.createClaims} onToggle={() => setP('createClaims', !priv.createClaims)} />
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-medium">Publishing permissions</p>
                    <label className="mb-2 flex items-center gap-2 text-sm">
                      <input type="radio" name="epub" checked={!priv.canPublish} onChange={() => setP('canPublish', false)} className="accent-black" />
                      Can’t publish to accounting software
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name="epub" checked={priv.canPublish} onChange={() => setP('canPublish', true)} className="accent-black" />
                      Can publish items and expense claims to an accounting software
                    </label>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button type="button" onClick={save} disabled={!canSave} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">Save</button>
        </div>
      </div>
    </div>
  );
}
