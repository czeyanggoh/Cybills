import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircle, Info, FileText } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { useWhatsappChats } from '@/lib/whatsapp';
import { cn } from '@/lib/utils';

// What has come in through this entity's WhatsApp collection groups, read as a
// conversation rather than as an inbox.
//
// It is NOT WhatsApp Web, and the page says so rather than letting somebody
// find out. CYWorkspace classifies everything sent into a group and forwards
// only the bills and receipts; the plain messages, the other attachments and
// the back-and-forth never reach CYBills at all. A chat quietly missing most of
// itself would be worse than no chat — you would read it as the whole
// conversation and conclude somebody had sent nothing.

const fmtWhen = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const fmtDay = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-SG', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
};

// One bubble per document that arrived: what they typed, then what it turned
// out to be once it was read.
function Message({ m, onOpen }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[34rem] rounded-lg rounded-br-sm border bg-muted/40 px-3 py-2">
        <p className="text-xs font-medium">
          {m.senderName || m.from || 'Someone'}
          {m.senderName && m.from ? <span className="ml-2 font-normal text-muted-foreground">{m.from}</span> : null}
        </p>
        {/* The caption — the covering note the document was read with. */}
        {m.text ? <p className="mt-1 whitespace-pre-wrap text-sm">{m.text}</p> : null}
        <button
          type="button"
          onClick={() => onOpen(m)}
          className="mt-2 flex w-full items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted"
        >
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{m.fileName || 'Document'}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {m.supplier || 'Not read yet'}
              {Number(m.total) > 0 ? ` · ${m.currency || 'SGD'} ${m.total}` : ''}
            </span>
          </span>
        </button>
        <p className="mt-1 text-right text-[11px] text-muted-foreground">{fmtWhen(m.sentAt)}</p>
      </div>
    </div>
  );
}

export default function WhatsappChats() {
  const navigate = useNavigate();
  const { groups, loading } = useWhatsappChats();
  const [picked, setPicked] = useState('');

  // Open on the group something last arrived in, which is the one being looked
  // for; leave a deliberate choice alone once it has been made.
  useEffect(() => {
    if (!picked && groups.length) setPicked(groups[0].submissionId);
  }, [groups, picked]);

  const group = useMemo(
    () => groups.find((g) => g.submissionId === picked) || groups[0] || null,
    [groups, picked]
  );

  // Messages grouped by the day they were sent, the way a chat reads.
  const days = useMemo(() => {
    const out = [];
    for (const m of group?.messages ?? []) {
      const day = fmtDay(m.sentAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.messages.push(m);
      else out.push({ day, messages: [m] });
    }
    return out;
  }, [group]);

  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">WhatsApp</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The documents that have come in through this entity&rsquo;s collection groups.
        </p>
      </div>

      {/* Said once, at the top, because the page looks like a chat. */}
      <div className="mb-4 flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Only the bills and receipts CYWorkspace picks out of a group reach CYBills, so this is what was
          FILED — not the whole conversation. Plain messages and everything else stay in WhatsApp.
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !groups.length ? (
        <p className="rounded-md border bg-muted/20 px-4 py-12 text-center text-sm text-muted-foreground">
          No collection groups yet.
          <br />
          <span className="text-xs">
            Business settings → Connections sets one up for this entity, and a person&rsquo;s own is on their
            page (Users → Manage → Edit details).
          </span>
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          {/* Every group, newest first. */}
          <div className="overflow-hidden rounded-lg border">
            {groups.map((g) => (
              <button
                key={g.submissionId}
                type="button"
                onClick={() => setPicked(g.submissionId)}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 border-b px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/60',
                  g.submissionId === group?.submissionId && 'bg-muted'
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.subject}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{g.messages.length}</span>
                </span>
                <span className="truncate pl-6 text-xs text-muted-foreground">
                  {g.personName ? `${g.personName}'s own group` : "This entity's group"}
                </span>
              </button>
            ))}
          </div>

          <div className="rounded-lg border">
            {group ? (
              <>
                <div className="border-b px-4 py-3">
                  <p className="font-medium">{group.subject}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {group.personName ? `${group.personName}'s own group` : "This entity's group"}
                    {group.participants?.length ? (
                      <> · <span className="font-mono">{group.participants.join(', ')}</span></>
                    ) : null}
                  </p>
                </div>
                <div className="max-h-[60vh] space-y-4 overflow-auto p-4">
                  {days.length ? (
                    days.map((d) => (
                      <div key={d.day} className="space-y-2">
                        <p className="text-center text-xs text-muted-foreground">{d.day}</p>
                        {d.messages.map((m) => (
                          <Message key={m.messageId} m={m} onOpen={(x) => navigate(`/costs/${x.itemId || x.billId}`)} />
                        ))}
                      </div>
                    ))
                  ) : (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      Nothing has come in through this group yet.
                    </p>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </AppShell>
  );
}
