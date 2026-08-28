import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, FileText, Info, Loader2, MessageCircle, Paperclip, Search } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { cn } from '@/lib/utils';
import { useActiveOrganisation } from '@/lib/organisations';
import {
  useWhatsappThreads,
  useWhatsappThread,
  setMessageCategory,
  fileMessageAsCost,
  DOC_CATEGORIES,
  categoryLabel,
} from '@/lib/whatsapp';

// The collection groups, as conversations.
//
// Costs answers "what did we get out of WhatsApp". This page answers the two
// questions Costs cannot: what was actually SAID in the group, and what is
// sitting in it that nobody filed. The second is the one that matters — the
// classifier reads a photo and sometimes calls an invoice a holiday snap, and
// until now that document simply never appeared anywhere in CYBills.
//
// So a reviewer can correct what a document is and file it by hand, and both go
// through the same paths the automatic hand-off uses.

const time = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export default function Whatsapp() {
  const { submissionId } = useParams();
  return submissionId ? <Thread submissionId={submissionId} /> : <ThreadList />;
}

function ThreadList() {
  const navigate = useNavigate();
  const organisation = useActiveOrganisation();
  const [{ threads, loading, error }] = useWhatsappThreads();
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const rows = q
    ? threads.filter((t) => `${t.subject} ${t.personName}`.toLowerCase().includes(q))
    : threads;

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">WhatsApp</h1>
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search groups"
            className="h-8 w-56 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Every message sent into {organisation?.name || 'this entity'}&rsquo;s collection groups, not only the documents that were picked out of them.
        Open a group to read the thread, correct anything the reader misjudged, and file it.
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">Group</th>
              <th className="px-3 py-2.5 font-medium">Collects for</th>
              <th className="px-3 py-2.5 font-medium">Last message</th>
              <th className="px-3 py-2.5 font-medium text-right">Messages</th>
              <th className="px-3 py-2.5 font-medium text-right">Files</th>
              <th className="px-3 py-2.5 font-medium text-right">Unfiled</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.submissionId}
                onClick={() => navigate(`/whatsapp/${encodeURIComponent(t.submissionId)}`)}
                className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40"
              >
                <td className="px-3 py-3 font-medium">
                  <span className="flex items-center gap-2">
                    <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    {t.subject || t.submissionId}
                  </span>
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  {t.entityWide ? 'Everyone in the group' : t.personName || <span className="text-amber-600">no longer on the roster</span>}
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  <span className="block">{time(t.lastMessageAt) || '—'}</span>
                  {t.lastMessagePreview && <span className="block max-w-[26rem] truncate text-xs">{t.lastMessagePreview}</span>}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{t.messages}</td>
                <td className="px-3 py-3 text-right tabular-nums">{t.attachments}</td>
                <td className="px-3 py-3 text-right">
                  {t.unfiled > 0 ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 tabular-nums">{t.unfiled}</span>
                  ) : (
                    <span className="text-muted-foreground tabular-nums">0</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  {error
                    ? error
                    : loading
                      ? 'Loading groups…'
                      : query
                        ? `No groups match “${query}”.`
                        : 'No collection groups yet — open one from a person’s page, or from Business settings → Connections.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {threads.length} groups</p>
      )}
    </AppShell>
  );
}

function Thread({ submissionId }) {
  const navigate = useNavigate();
  const [{ channel, messages, canManage, loading, error }, reload] = useWhatsappThread(submissionId);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  async function correct(id, category) {
    setBusy(id);
    setNote('');
    try {
      await setMessageCategory(id, category);
      await reload();
    } catch (err) {
      setNote(err.message);
    } finally {
      setBusy('');
    }
  }

  async function file(id) {
    setBusy(id);
    setNote('');
    try {
      const out = await fileMessageAsCost(id);
      setNote(out.already ? `Already filed as ${out.item_id}.` : `Filed as ${out.item_id} — reading it now.`);
      await reload();
    } catch (err) {
      setNote(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <AppShell>
      <button
        type="button"
        onClick={() => navigate('/whatsapp')}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> All groups
      </button>

      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">{channel?.subject || submissionId}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {channel
            ? channel.entityWide
              ? 'Collects for everyone in the group'
              : channel.personName
                ? `Collects for ${channel.personName}`
                : 'The person this group was opened for is no longer on the roster'
            : ''}
        </p>
      </div>

      {note && (
        <p className="mb-3 flex items-start gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          {note}
        </p>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading conversation…</p>}
      {error && !loading && <p className="text-sm text-muted-foreground">{error}</p>}

      {!loading && !error && messages.length === 0 && (
        <div className="rounded-lg border px-4 py-16 text-center text-sm text-muted-foreground">
          Nothing has arrived in this group yet.
        </div>
      )}

      <div className="space-y-2">
        {messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            canManage={canManage}
            busy={busy === m.id}
            onCorrect={(cat) => correct(m.id, cat)}
            onFile={() => file(m.id)}
          />
        ))}
      </div>
    </AppShell>
  );
}

function Message({ message: m, canManage, busy, onCorrect, onFile }) {
  const outbound = m.direction === 'out';
  const hasFile = Boolean(m.r2Key || m.fileUrl);
  return (
    <div className={cn('flex', outbound ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-2xl rounded-lg border px-3 py-2', outbound ? 'bg-muted/40' : 'bg-background')}>
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium">{m.senderName || (outbound ? 'Us' : m.sender) || 'Unknown'}</span>
          <span className="text-xs text-muted-foreground">{time(m.sentAt)}</span>
        </div>

        {hasFile && (
          <a
            href={m.fileUrl || undefined}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-2 text-sm transition-colors hover:bg-muted"
          >
            <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{m.fileName || m.msgType}</span>
          </a>
        )}

        {m.body && <p className="mt-1.5 whitespace-pre-wrap text-sm">{m.body}</p>}
        {m.translation && m.translation !== m.body && (
          <p className="mt-1 whitespace-pre-wrap text-sm italic text-muted-foreground">{m.translation}</p>
        )}

        {hasFile && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
            {/* The model's guess is shown as a guess. A reviewer opened the
                document; it only looked at a photo of it. */}
            <select
              value={m.docCategory || ''}
              disabled={!canManage || busy}
              onChange={(e) => onCorrect(e.target.value)}
              className="h-7 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <option value="">Unclassified</option>
              {DOC_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <span className="text-[11px] text-muted-foreground">
              {m.categorySource === 'manual' ? 'set here' : m.docCategory ? 'read automatically' : ''}
            </span>

            {m.billId ? (
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
                <FileText className="h-3.5 w-3.5" /> Filed as {m.billDisplayId || 'a cost'}
              </span>
            ) : (
              canManage && (
                <button
                  type="button"
                  onClick={onFile}
                  disabled={busy}
                  className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                  Add to Costs
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export { categoryLabel };
