import { useState } from 'react';
import { promoteWhatsappAdmins } from '@/lib/whatsapp';

// Making the people in a collection group admins of it.
//
// The group has to keep working when CYBot is not looking at it. Only an admin
// can add somebody WhatsApp declined to add, rename the group, or take a person
// out of it — and every shortfall this app reports ends in exactly that
// instruction ("somebody already in the group has to add them"), which an
// ordinary member cannot follow.
//
// New groups ask for it as they are made, and so does adding a number to one.
// This is for the groups opened before that, and for a group somebody has since
// added a member to from inside WhatsApp — which is why it stays on the card
// rather than disappearing once it has been pressed. Pressing it again is a
// no-op at WhatsApp's end.
//
// Not offered on an ADOPTED conversation: that group is the client's own,
// merely pointed at CYBills, and handing out admin in it from an accounting app
// is the same species of act as taking it apart. The server refuses it too.
export default function PromoteWhatsappAdmins({ channel, canManage, onDone }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  if (!channel || channel.status !== 'open' || channel.adopted || !canManage) return null;

  const promote = async () => {
    setBusy(true);
    setNote(null);
    try {
      const out = await promoteWhatsappAdmins({ submissionId: channel.submissionId });
      setNote(
        out.promotedNow
          ? {
              ok: true,
              text: `${out.promotedNow} ${out.promotedNow === 1 ? 'person is' : 'people are'} now an admin of the group — they can add and remove members themselves.`,
            }
          : // A 200 with nobody promoted is the ordinary answer once they all
            // are: CYWS reports who it CHANGED, and a refusal comes back as an
            // error rather than as an empty list.
            { ok: true, text: 'Everyone in the group is already an admin.' }
      );
      onDone?.(out);
    } catch (err) {
      setNote({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={promote}
        disabled={busy}
        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
      >
        {busy ? 'Making everyone an admin…' : 'Make everyone an admin'}
      </button>
      {note && (
        <p className={note.ok ? 'text-xs text-emerald-700 dark:text-emerald-400' : 'text-xs text-destructive'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
