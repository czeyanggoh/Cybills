import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Download, FileText, Info, Loader2, MessageCircle, Search, Sparkles, Tag, X } from 'lucide-react';
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
// reader looks at a photo and sometimes calls an invoice a holiday snap, and
// that document would otherwise appear nowhere in CYBills at all.
//
// It is deliberately built to look like the CYBot inbox on the CYWorkspace
// side: same tinted canvas, same bubbles, same file cards, same category chip.
// The two are windows onto ONE conversation, and somebody comparing them should
// not have to work out whether they are looking at the same thing.

const time = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
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
  const rows = q ? threads.filter((t) => `${t.subject} ${t.personName}`.toLowerCase().includes(q)) : threads;

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
      {rows.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Showing {rows.length} of {threads.length} groups</p>}
    </AppShell>
  );
}

function Thread({ submissionId }) {
  const navigate = useNavigate();
  const [{ channel, messages, canManage, loading, error }, reload] = useWhatsappThread(submissionId);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  // The attachment being looked at, or null. In-window rather than a new tab:
  // reading a bill is part of deciding what it is, and losing the thread behind
  // a browser tab to check a total is the wrong shape for that.
  const [preview, setPreview] = useState(null);

  async function run(id, fn) {
    setBusy(id);
    setNote('');
    try {
      const out = await fn();
      if (out) setNote(out);
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

      <div className="mb-3">
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

      {/* The same tinted canvas the CYBot inbox uses — this is the same
          conversation seen from the other end, and it should read as one. */}
      <div className="rounded-lg border bg-[#efeae2] p-3 sm:p-4">
        {loading && <p className="py-12 text-center text-sm text-gray-500">Loading conversation…</p>}
        {error && !loading && <p className="py-12 text-center text-sm text-gray-500">{error}</p>}
        {!loading && !error && messages.length === 0 && (
          <p className="py-12 text-center text-sm text-gray-500">Nothing has arrived in this group yet.</p>
        )}
        <div className="space-y-2">
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              m={m}
              canManage={canManage}
              busy={busy === m.id}
              onPreview={() => setPreview(m)}
              onCorrect={(cat) => run(m.id, async () => { await setMessageCategory(m.id, cat); })}
              onFile={() => run(m.id, async () => {
                const out = await fileMessageAsCost(m.id);
                return out.already ? `Already filed as ${out.item_id}.` : `Filed as ${out.item_id} — reading it now.`;
              })}
            />
          ))}
        </div>
      </div>

      {preview && <AttachmentPreview m={preview} onClose={() => setPreview(null)} />}
    </AppShell>
  );
}

// The attachment, in the window. Same shape as the receipt lightbox elsewhere
// in CYBills — an iframe for a PDF, an img for a picture — over the thread
// rather than in a tab of its own.
function AttachmentPreview({ m, onClose }) {
  const isPdf = (m.contentType || '').includes('pdf');
  const isImage = (m.contentType || '').startsWith('image/');
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/50" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.fileName || 'Document'}</span>
          <div className="flex shrink-0 items-center gap-3">
            {m.fileUrl && (
              <a href={m.fileUrl} download className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                <Download className="h-3.5 w-3.5" /> Download
              </a>
            )}
            <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-muted/30">
          {!m.fileUrl ? (
            <p className="p-12 text-center text-sm text-muted-foreground">
              This attachment has no readable link — it was mirrored without one.
            </p>
          ) : isImage ? (
            <img src={m.fileUrl} alt={m.fileName || 'attachment'} className="mx-auto max-h-[74vh] w-full object-contain" />
          ) : isPdf ? (
            <iframe src={m.fileUrl} title={m.fileName || 'Document'} className="h-[74vh] w-full" />
          ) : (
            // Neither renders in a frame reliably (a .docx, a .xlsx, an audio
            // note), so say so and offer the file rather than showing a blank
            // grey rectangle that looks like a broken viewer.
            <div className="p-12 text-center text-sm text-muted-foreground">
              <p>This file type can&rsquo;t be previewed here.</p>
              <a href={m.fileUrl} download className="mt-2 inline-flex items-center gap-1 text-blue-600 hover:underline">
                <Download className="h-3.5 w-3.5" /> Download {m.fileName || 'the file'}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ m, canManage, busy, onCorrect, onFile, onPreview }) {
  const isOut = m.direction === 'out';
  const hasFile = Boolean(m.r2Key || m.fileUrl);
  return (
    <div className={cn('flex', isOut ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[70%] rounded-lg px-3 py-2 text-sm shadow-sm', isOut ? 'bg-green-100 text-gray-900' : 'bg-white text-gray-900')}>
        {/* Name and the number to reply on. The raw WhatsApp id is NOT printed:
            a LID is 15 digits and reads as a second phone number beside the real
            one. It stays on the title, so it is still there to trace by. */}
        {!isOut && m.senderLabel && (
          <p className="mb-0.5 text-[11px] font-semibold text-green-700" title={m.senderId || undefined}>
            {m.senderLabel}
            {m.senderNumber && <span className="font-normal"> · {m.senderNumber}</span>}
          </p>
        )}

        {hasFile && <Attachment m={m} onPreview={onPreview} />}

        {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        {m.translation && m.translation !== m.body && (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-gray-500">{m.translation}</p>
        )}
        {!m.body && !hasFile && <p className="text-xs italic text-gray-400">[{m.msgType}]</p>}

        {hasFile && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {/* The same chip the CYBot inbox shows, and it reads the same way:
                a sparkle when the reader guessed (with how sure it was), a tag
                when a person decided. */}
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                m.docCategory ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-gray-200 bg-gray-50 text-gray-600',
              )}
            >
              {m.categorySource === 'manual' ? <Tag className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
              {m.docCategory ? categoryLabel(m.docCategory) : 'Unclassified'}
              {m.categorySource !== 'manual' && m.categoryConfidence ? ` · ${m.categoryConfidence}` : ''}
            </span>

            {canManage && (
              <select
                value={m.docCategory || ''}
                disabled={busy}
                onChange={(e) => onCorrect(e.target.value)}
                className="h-6 rounded-md border border-gray-200 bg-white px-1.5 text-[11px] text-gray-600 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                <option value="">Change…</option>
                {DOC_CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            )}

            {m.billId ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-600">
                <FileText className="h-3 w-3" /> Filed · {m.billDisplayId || 'cost'}
              </span>
            ) : (
              canManage && (
                <button
                  type="button"
                  onClick={onFile}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
                  Add to Costs
                </button>
              )
            )}
          </div>
        )}

        <p className={cn('mt-1 text-[10px] text-gray-400', isOut ? 'text-right' : 'text-right')}>{time(m.sentAt)}</p>
      </div>
    </div>
  );
}

// Image inline, PDF as the red card, anything else as a plain file row — the
// same three shapes the CYBot inbox uses. All three open the in-window preview.
function Attachment({ m, onPreview }) {
  const href = m.fileUrl || undefined;
  const type = m.contentType || '';

  if (type.startsWith('image/')) {
    return (
      <button type="button" onClick={onPreview} className="mb-1.5 block">
        <img src={href} alt={m.fileName || 'image'} className="max-h-56 max-w-full rounded-md object-cover" />
      </button>
    );
  }

  if (type === 'application/pdf') {
    return (
      <button
        type="button"
        onClick={onPreview}
        className="mb-1.5 flex w-full items-center gap-2.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-2.5 text-left transition-colors hover:bg-gray-100"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-red-100">
          <FileText className="h-5 w-5 text-red-600" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs text-gray-700">{m.fileName || 'Document'}</p>
          <p className="text-[10px] text-gray-400">PDF · tap to view</p>
        </div>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onPreview}
      className="mb-1.5 flex w-full items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-2 text-left transition-colors hover:bg-gray-100"
    >
      <FileText className="h-4 w-4 shrink-0 text-gray-400" />
      <span className="truncate text-xs text-gray-700">{m.fileName || m.msgType}</span>
    </button>
  );
}
