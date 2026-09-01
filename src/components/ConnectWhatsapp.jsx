import { useState } from 'react';
import { MessageCircle, AlertTriangle } from 'lucide-react';
import { useWhatsappForUser, connectWhatsappForUser } from '@/lib/whatsapp';
import CloseWhatsappGroup from '@/components/CloseWhatsappGroup';

// "Connect to WhatsApp" — one row's own bill collection group.
//
// The number lives in this card rather than up with the name fields, the way the
// inbound address lives in the one beside it: its whole job in CYBills is
// WhatsApp. It is what the group is opened with AND what a bill arriving from
// that number is matched back to, which is why one field does both.
//
// `user` is usually a person. It can also be an entity's GENERAL account — the
// row that owns the paperwork nobody claimed — which collects the same way and
// through the same endpoint; `description` and `owner` are what let the card say
// so in its own words instead of calling an account a person.
export default function ConnectWhatsapp({ user, mobile, setMobile, description, owner, saveLabel = 'Save' }) {
  const [{ channel, alsoCollecting, enabled, canManage, loading }, reload] = useWhatsappForUser(user.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const who = owner || user.name || 'this person';

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
        {description || (
          <>
            Opens a WhatsApp group with {who}. Bills they send into it are read and filed under them — no sign-in,
            no app.
          </>
        )}
      </p>
      <label className="sr-only" htmlFor="wa-mobile">Mobile number</label>
      <div className="flex items-center gap-2">
        <input
          id="wa-mobile"
          type="tel"
          value={mobile}
          onChange={(e) => { setMobile(e.target.value); setError(null); }}
          placeholder="6591234567"
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
        Country code first, digits only — <code>6591234567</code>, not <code>91234567</code>.
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
              <span className="font-medium">{saveLabel}</span> stores this number, and bills sent from it are
              filed under {who} from then on. It doesn&rsquo;t change the group, though — that one was
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

      {/* Conversations of their own that were pointed at CYBills rather than
          opened by CYBot — a client chat that already held their bills. They
          file under the same person, so they belong on this card; they are not
          the group above, though, and folding them into it is exactly the
          mistake that made two chats look like one. */}
      {alsoCollecting?.map((g) => (
        <div key={g.submissionId} className="space-y-2 rounded-md border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Also collecting</span> — {g.subject}
            {' '}· a group of their own, pointed at CYBills rather than opened by CYBot
            {g.received ? ` · ${g.received} ${g.received === 1 ? 'bill' : 'bills'} so far` : ''}
          </p>
          <CloseWhatsappGroup channel={g} canManage={canManage} onClosed={reload} />
        </div>
      ))}

      {/* Closing it down. Sits at the foot of the card rather than beside
          "Connected", because it is the end of the group and not a detail of
          it — and because expanded it is a panel, not a button. */}
      <CloseWhatsappGroup channel={channel} canManage={canManage} onClosed={reload} />

      {error && (
        <p className="text-xs text-destructive">
          {error.message}
          {error.rejected?.length ? ` Check ${error.rejected.join(', ')}.` : ''}
        </p>
      )}
    </div>
  );
}
