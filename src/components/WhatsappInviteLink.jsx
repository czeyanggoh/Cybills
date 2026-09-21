import { useState } from 'react';
import { Check, Copy, Link2, Mail, Share2 } from 'lucide-react';
import { sendWhatsappInvite } from '@/lib/whatsapp';

// How people get into a collection group: its invite link.
//
// CYBot never adds a number to a group. Adding numbers that have never spoken to
// it is the pattern WhatsApp enforces against, and the number is shared by every
// client's group, so one enforcement would stop collection for all of them. The
// group is opened empty, the person is emailed the link, and this is where
// whoever administers them can copy it, share it from their OWN WhatsApp, or
// email it again.
//
// Nothing for an adopted conversation (the client's own to share) or a closed
// one, and nothing for somebody who does not administer the group — the server
// blanks the link for them, because holding it is enough to join and send bills
// into somebody's book.
export default function WhatsappInviteLink({ channel, canManage, onDone, defaultEmail = '' }) {
  const [email, setEmail] = useState(defaultEmail || '');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState(null);

  if (!channel || channel.status !== 'open' || channel.adopted || !canManage) return null;
  const link = channel.inviteLink || '';

  const run = async (kind, args) => {
    setBusy(kind);
    setNote(null);
    try {
      const out = await sendWhatsappInvite({ submissionId: channel.submissionId, ...args });
      if (out.invite) {
        setNote(
          out.invite.sent
            ? { ok: true, text: `Invite link emailed to ${out.invite.email}.` }
            : { ok: false, text: `Couldn’t email ${out.invite.email} (${out.invite.error}). Copy the link and send it yourself.` }
        );
      }
      onDone?.();
    } catch (err) {
      setNote({ ok: false, text: err.message });
    } finally {
      setBusy('');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setNote({ ok: false, text: 'Couldn’t copy — select the link and copy it by hand.' });
    }
  };

  const last = channel.lastInvite;

  return (
    <div className="space-y-2 rounded-md border bg-background px-3 py-2.5 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <Link2 className="h-3.5 w-3.5" /> Invite link
      </p>
      {link ? (
        <>
          <div className="flex items-center gap-2">
            {/* A real link: on a phone it opens WhatsApp straight into the
                group, on a desktop WhatsApp's own join page. */}
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              title={link}
              className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border bg-muted/30 px-2 font-mono text-xs text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
            >
              <span className="truncate">{link}</span>
            </a>
            <button
              type="button"
              onClick={copy}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 font-medium hover:bg-muted"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {/* Opens the ADMIN's own WhatsApp with the link typed in — their
                message to somebody they know, not CYBot's to a stranger. */}
            <a
              href={`https://wa.me/?text=${encodeURIComponent(`Join the group for sending in your bills: ${link}`)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 font-medium hover:bg-muted"
            >
              <Share2 className="h-3.5 w-3.5" /> Share
            </a>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run('email', { email: email.trim() });
            }}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              aria-label="Email the invite to"
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="submit"
              disabled={Boolean(busy) || !email.trim()}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-foreground px-2.5 font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              <Mail className="h-3.5 w-3.5" /> {busy === 'email' ? 'Sending…' : 'Email invite'}
            </button>
          </form>
          <p className="text-muted-foreground">
            Anyone with this link can join the group, so send it only to the people it is for.
            {last ? (
              <>
                {' '}Last emailed to {last.email}
                {last.sent ? '' : ' — not delivered'} on {new Date(last.at).toLocaleDateString()}.
              </>
            ) : null}
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            {channel.invite
              ? 'The link wasn’t available when the group opened.'
              : 'People join this group by its invite link — CYBot doesn’t add numbers.'}
          </span>
          <button
            type="button"
            onClick={() => run('fetch', { send: false })}
            disabled={Boolean(busy)}
            className="inline-flex h-8 items-center rounded-md border px-2.5 font-medium hover:bg-muted disabled:opacity-50"
          >
            {busy === 'fetch' ? 'Getting…' : 'Get invite link'}
          </button>
        </div>
      )}
      {note && (
        <p className={note.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>{note.text}</p>
      )}
    </div>
  );
}
