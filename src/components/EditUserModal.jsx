import { useState } from 'react';
import { X, ChevronDown, HelpCircle, Copy, Check, Mail, ExternalLink, MessageCircle, AlertTriangle } from 'lucide-react';
import { ROLES, ROLE_INFO, updateUser, dismissForward } from '@/lib/userStore';
import { PRACTICE_ROLES, PRACTICE_ROLE_INFO } from '@/lib/practiceStore';
import { useOrganisations } from '@/lib/organisations';
import { cleanHandle, inboundAddress, addressTail, suffixForUser } from '@/lib/inboundAddress';
import { useWhatsappForUser, connectWhatsappForUser } from '@/lib/whatsapp';
import { cn } from '@/lib/utils';

// "Extract by email" — the user's inbound address plus any Gmail forwarding
// confirmation CYBills is holding for them to click.
//
// `suffix` is their entity's short form, set in Business settings → Extraction:
// with one, this person is `martin.redalpha@cybills.sg` rather than `martin@`.
// It is fixed here, like the domain — one entity, one short form, so choosing
// it per person is not a thing that could mean anything.
function ExtractByEmail({ user, handle, setHandle, suffix, error }) {
  const [copied, setCopied] = useState(false);
  const clean = cleanHandle(handle);
  const address = inboundAddress(clean, suffix);
  const tail = addressTail(suffix);
  const pending = user.pendingForward;
  const copy = () => {
    if (!address) return;
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
      {/* The local-part is editable: the generated one is a starting point, not
          the address the person has to live with. The domain is fixed, so it is
          shown rather than typed — half an address is not a thing to get wrong. */}
      <div className="flex items-center gap-2">
        <div className={cn('flex h-9 flex-1 items-center overflow-hidden rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring', error && 'border-destructive')}>
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            aria-label="Inbound email address"
            placeholder="name"
            className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
          />
          <span className="shrink-0 select-none border-l bg-muted/40 px-2.5 py-2 text-sm text-muted-foreground">
            {tail}
          </span>
        </div>
        <button type="button" onClick={copy} disabled={!address} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        clean !== handle.trim().toLowerCase() && handle.trim() && (
          <p className="text-xs text-muted-foreground">Will be saved as {address}</p>
        )
      )}
      {/* Changing it takes the old address out of service, and any forwarding
          rule already pointing at it stops arriving — worth saying before Save,
          not after. */}
      {clean && user.emailHandle && clean !== user.emailHandle && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Mail sent to {inboundAddress(user.emailHandle, suffix)} will stop arriving. Any forwarding rule already set up
          needs repointing at the new address.
        </p>
      )}

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

// "Connect to WhatsApp" — this person's own bill collection group.
//
// The number lives in this card rather than up with the name fields, the way
// the inbound address lives in the one above: its whole job in CYBills is
// WhatsApp. It is what the group is opened with AND what a bill arriving from
// that number is matched back to, which is why one field does both.
function ConnectWhatsapp({ user, mobile, setMobile }) {
  const [{ channel, enabled, canManage, loading }, reload] = useWhatsappForUser(user.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const connect = async (replace = false) => {
    setBusy(true);
    setError(null);
    try {
      await connectWhatsappForUser({ userId: user.id, mobile, replace });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      // Reload either way. A FAILED attempt still left a channel behind — that
      // is the point of it, since its submission id is what a retry reuses —
      // and the card has to say so, or the button keeps offering to "Connect"
      // something that is already half-made.
      reload();
    }
  };

  const open = channel?.status === 'open';
  // A number changed after the fact does not move the group — the person in it
  // stays whoever was added. Worth saying before Save, not after.
  //
  // Compared against the number the group was OPENED with, not against what
  // WhatsApp echoed back: that comes back as a LID, an opaque per-user id, and
  // no phone number will ever match one.
  const inGroup = channel?.participantsRequested?.[0] || '';
  const digits = String(mobile || '').replace(/\D+/g, '');
  const drifted = open && inGroup && digits && !digits.endsWith(inGroup) && !inGroup.endsWith(digits);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageCircle className="h-4 w-4" strokeWidth={1.75} /> Connect to WhatsApp
      </div>
      <p className="text-xs text-muted-foreground">
        Opens a WhatsApp group with {user.name || 'this person'}. Bills they send into it are read and filed
        under them — no sign-in, no app.
      </p>
      <label className="sr-only" htmlFor="wa-mobile">Mobile number</label>
      <div className="flex items-center gap-2">
        <input
          id="wa-mobile"
          type="tel"
          value={mobile}
          onChange={(e) => { setMobile(e.target.value); setError(null); }}
          placeholder="60123456789"
          spellCheck={false}
          autoComplete="tel"
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {!open && (
          <button
            type="button"
            onClick={() => connect(false)}
            disabled={busy || loading || !enabled || !canManage || !mobile.trim()}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-3 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Connecting…' : channel ? 'Try again' : 'Connect'}
          </button>
        )}
      </div>
      {/* Full international format, or WhatsApp simply adds nobody and says
          nothing. A leading 0 is a national trunk prefix and is refused rather
          than guessed at — no country code starts with one. */}
      <p className="text-xs text-muted-foreground">
        Country code first, digits only — <code>60123456789</code>, not <code>0123456789</code>.
      </p>

      {open ? (
        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Connected</span> — {channel.subject}
          {/* Which number the group actually holds. Without it, a mismatch below
              is an accusation with nothing to check it against. */}
          {inGroup ? <> · opened with <span className="font-mono">{inGroup}</span></> : null}
          {channel.received ? ` · ${channel.received} ${channel.received === 1 ? 'bill' : 'bills'} so far` : ''}
        </div>
      ) : !enabled && !loading ? (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          CYWorkspace isn&rsquo;t connected on this deployment yet, so there is nothing to open the group with.
        </p>
      ) : channel ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {channel.lastError || 'The last attempt didn’t complete.'} Trying again picks up the same group rather
          than making a second one.
        </p>
      ) : null}

      {/* The number and the group are two separate things, and the warning that
          used to sit here said so without giving anybody anywhere to go: it
          reported a mismatch, offered no action (the Connect button is hidden
          once a group is open), and stayed up after Save — which reads exactly
          like the number failing to save, and was reported as one.

          So it says what Save does, and the group gets a button of its own. */}
      {drifted && (
        <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2.5 dark:bg-amber-500/10">
          <p className="flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium">Save</span> stores this number, and bills sent from it are filed
              under {user.name || 'them'} from then on. It doesn&rsquo;t change the group, though — that one was
              opened with <span className="font-mono">{inGroup}</span> and WhatsApp has no way to swap a number
              inside it.
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-3 pl-5">
            <button
              type="button"
              onClick={() => connect(true)}
              disabled={busy || !enabled || !canManage}
              className="inline-flex h-8 items-center rounded-md border border-amber-700/40 bg-background px-3 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              {busy ? 'Opening…' : 'Open a new group with this number'}
            </button>
            <span className="text-xs text-amber-800/80 dark:text-amber-200/70">
              or add it from inside the existing group — the old one keeps working either way.
            </span>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive">
          {error.message}
          {error.rejected?.length ? ` Check ${error.rejected.join(', ')}.` : ''}
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
  // The short form this person's entity puts in their address. Read from the
  // entity list the dialog already has, so nothing extra is fetched to print an
  // address.
  const suffix = suffixForUser(user, organisations);
  const [handle, setHandle] = useState(user?.emailHandle || '');
  const [mobile, setMobile] = useState(user?.mobile || '');
  const [handleError, setHandleError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!open || !user) return null;

  const movingOut = organisationId && organisationId !== user.organisationId;

  const input = 'h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const isDetails = mode === 'details';
  const emailValid = !login || /.+@.+\..+/.test(email.trim());
  const canSave = isDetails ? firstName.trim() && lastName.trim() && emailValid : true;

  const save = async () => {
    setSaving(true);
    setHandleError('');
    try {
      if (isDetails) {
        const wanted = cleanHandle(handle);
        await updateUser(user.id, {
          firstName,
          lastName,
          login: login ? 'Yes' : 'No',
          // The address is sent only when login is ON. Turning login OFF says
          // this person may not SIGN IN; it does not say they stop existing —
          // and this used to send `email: ''`, which wiped the address their
          // whole identity hangs off: the session resolves by it, their
          // documents are owned by it, their claims are made out to it. A
          // colleague sitting at Login access = No (which is most of them) lost
          // their address the moment anybody pressed Save on this dialog for
          // any reason at all — a name, an inbound handle, a phone number.
          //
          // Changing the address itself is a deliberate act with its own dialog
          // (Manage → Change email), and that is where it belongs.
          ...(login ? { email } : {}),
          mobile,
          // Only when it actually changed — sending it unchanged would make an
          // edit to somebody's NAME fail on their own existing address.
          ...(wanted && wanted !== user.emailHandle ? { emailHandle: wanted } : {}),
          ...(movingOut ? { organisationId } : {}),
        });
      } else {
        await updateUser(user.id, practice ? { practiceRole: role, privileges: priv } : { role, privileges: priv });
      }
      onClose();
    } catch (err) {
      // The dialog stays open on a rejected address, with the reason on the
      // field — closing it would throw away every other edit in the form.
      if (err?.code === 'handle_taken') {
        const taken = err.info?.address || inboundAddress(err.info?.handle || handle, suffix);
        setHandleError(`${taken} is already used by ${err.info?.takenBy || 'someone else'}.`);
      } else if (err?.code === 'invalid_handle') {
        setHandleError('Use letters and numbers, optionally separated by dots or hyphens.');
      } else {
        setHandleError('Could not save. Please try again.');
      }
    } finally {
      setSaving(false);
    }
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
              <ExtractByEmail
                user={user}
                handle={handle}
                setHandle={(v) => { setHandle(v); setHandleError(''); }}
                suffix={suffix}
                error={handleError}
              />
              {/* The other road a bill travels. Same shape as the card above on
                  purpose: they are the two ways paperwork reaches CYBills
                  without anybody signing in. */}
              <ConnectWhatsapp user={user} mobile={mobile} setMobile={setMobile} />
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
          <button type="button" onClick={save} disabled={!canSave || saving} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
