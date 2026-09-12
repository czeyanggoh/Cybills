import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ExternalLink, FileText, Info, Link2, Loader2, Mail, Paperclip, Search } from 'lucide-react';
import AppShell from '@/components/AppShell';
import { cn } from '@/lib/utils';
import { useActiveOrganisation } from '@/lib/organisations';
import { useMailThreads, useMailThread, fetchMessageLinks } from '@/lib/mailbox';

// What arrived by email, threaded by the person it was addressed to.
//
// Costs answers "what did we get out of the mail". This page answers the one
// Costs cannot: what was SENT and became nothing — an invoice that was a link
// rather than an attachment, a file of a kind the reader cannot take, a portal
// login n8n could not complete. Those deliveries appeared nowhere in CYBills at
// all, so "I emailed that last week" had no answer here.
//
// Deliberately the same two-level shape as the WhatsApp tab: a list of pipes,
// each opening into what came down it. An inbound address and a collection
// group are the same thing under two names.

const time = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-SG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export default function Email() {
  const { userId } = useParams();
  return userId ? <Thread userId={userId} /> : <ThreadList />;
}

function ThreadList() {
  const navigate = useNavigate();
  const organisation = useActiveOrganisation();
  const [{ threads, messages, unfiled, loading, error }] = useMailThreads();
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const rows = q
    ? threads.filter((t) => `${t.personName} ${t.address} ${t.lastSubject}`.toLowerCase().includes(q))
    : threads;

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Email</h1>
        {unfiled > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            {unfiled} filed nothing
          </span>
        )}
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search mailboxes"
            className="h-8 w-56 rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Every message delivered to {organisation?.name || 'this entity'}&rsquo;s CYBills addresses, not only the ones that
        became documents. Open a mailbox to read what was sent, what was filed from it, and why anything wasn&rsquo;t.
      </p>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b bg-muted/40 text-left">
            <tr className="text-muted-foreground">
              <th className="px-3 py-2.5 font-medium">Mailbox</th>
              <th className="px-3 py-2.5 font-medium">Address</th>
              <th className="px-3 py-2.5 font-medium">Last message</th>
              <th className="px-3 py-2.5 font-medium text-right">Messages</th>
              <th className="px-3 py-2.5 font-medium text-right">Documents</th>
              <th className="px-3 py-2.5 font-medium text-right">Filed nothing</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.userId}
                onClick={() => navigate(`/email/${encodeURIComponent(t.userId)}`)}
                className="cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40"
              >
                <td className="px-3 py-3 font-medium">
                  <span className="flex items-center gap-2">
                    <Mail className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    {t.personName || t.address || t.userId}
                    {/* The entity's own address — the short form standing alone
                        — is not a person's, and the row should not read as one. */}
                    {t.general && (
                      <span className="rounded-full border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                        general account
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  {t.address || <span className="text-amber-600">no longer on the roster</span>}
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  <span className="block">{time(t.lastMessageAt) || '—'}</span>
                  {t.lastSubject && <span className="block max-w-[26rem] truncate text-xs">{t.lastSubject}</span>}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{t.messages}</td>
                <td className="px-3 py-3 text-right tabular-nums">{t.documents}</td>
                <td className="px-3 py-3 text-right">
                  {t.unfiled > 0 ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 tabular-nums">
                      {t.unfiled}
                    </span>
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
                      ? 'Loading mailboxes…'
                      : query
                        ? `No mailbox matches “${query}”.`
                        : 'Nothing has been emailed in yet — a person’s address is on their Edit details page, under Extract by Email.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing {rows.length} of {threads.length} mailboxes · {messages} messages
        </p>
      )}
    </AppShell>
  );
}

function Thread({ userId }) {
  const navigate = useNavigate();
  const [{ person, messages, linkFetchEnabled, loading, error }, reload] = useMailThread(userId);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  async function fetchLinks(id) {
    setBusy(id);
    setNote('');
    try {
      const out = await fetchMessageLinks(id);
      // A fetch that found nothing is an ANSWER, not a failure: n8n's own words
      // are what tell a reviewer whether to fix the workflow or the login.
      setNote(out.documents?.length ? `${out.note} — reading ${out.documents.length === 1 ? 'it' : 'them'} now.` : out.note);
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
        onClick={() => navigate('/email')}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> All mailboxes
      </button>

      <div className="mb-3">
        <h1 className="text-xl font-semibold tracking-tight">{person?.personName || 'Mailbox'}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {person?.address || 'The person this mail was addressed to is no longer on the roster'}
          {person?.general ? ' · the entity’s own address' : ''}
        </p>
      </div>

      {note && (
        <p className="mb-3 flex items-start gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          {note}
        </p>
      )}

      {loading && <p className="py-12 text-center text-sm text-muted-foreground">Loading messages…</p>}
      {error && !loading && <p className="py-12 text-center text-sm text-muted-foreground">{error}</p>}
      {!loading && !error && messages.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">Nothing has arrived at this address yet.</p>
      )}

      <div className="space-y-3">
        {messages.map((m) => (
          <Message
            key={m.id}
            m={m}
            linkFetchEnabled={linkFetchEnabled}
            busy={busy === m.id}
            onFetch={() => fetchLinks(m.id)}
          />
        ))}
      </div>
    </AppShell>
  );
}

function Message({ m, linkFetchEnabled, busy, onFetch }) {
  const filed = m.documents?.length > 0;
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2.5">
        <span className="font-medium">{m.subject || '(no subject)'}</span>
        <span className="text-sm text-muted-foreground">{m.from}</span>
        <span className="ml-auto text-xs text-muted-foreground">{time(m.sentAt || m.receivedAt)}</span>
      </div>

      <div className="space-y-3 px-4 py-3">
        {m.text && (
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">{m.text}</p>
        )}

        {/* What it produced. A document links straight through to its own page —
            this row is usually the answer to "where did that go?". */}
        {filed && (
          <div className="flex flex-wrap gap-2">
            {m.documents.map((d) => (
              <Link
                key={d.billId}
                to={`/costs/${encodeURIComponent(d.displayId)}`}
                className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-muted/60"
              >
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="max-w-[16rem] truncate">{d.fileName || d.displayId}</span>
                <span className="text-muted-foreground">{d.via === 'link' ? 'from a link' : d.displayId}</span>
              </Link>
            ))}
          </div>
        )}

        {/* An attachment that was NOT filed. The commonest reason a mail
            "arrived and nothing happened", and it was invisible until now. */}
        {m.attachments?.filter((a) => a.skipped).map((a) => (
          <p key={a.fileName} className="flex items-center gap-1.5 text-xs text-amber-700">
            <Paperclip className="h-3.5 w-3.5 shrink-0" />
            {a.fileName} — {a.skipped}
          </p>
        ))}

        {/* The links, whatever became of them. Shown even where n8n is switched
            off or found nothing: a link somebody can open themselves is better
            than a dead end. */}
        {m.links?.length > 0 && (
          <div className="space-y-1">
            {m.links.slice(0, 5).map((href) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline"
              >
                <Link2 className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[32rem] truncate">{href}</span>
                <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
              </a>
            ))}
            {m.links.length > 5 && (
              <p className="text-xs text-muted-foreground">and {m.links.length - 5} more</p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t px-4 py-2">
        <span className={cn('text-xs', filed ? 'text-muted-foreground' : 'text-amber-700')}>{m.summary}</span>
        {m.linkNote && m.linkNote !== m.summary && (
          <span className="text-xs text-muted-foreground">{m.linkNote}</span>
        )}
        {m.links?.length > 0 && linkFetchEnabled && (
          <button
            type="button"
            onClick={onFetch}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted/60 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
            {filed ? 'Fetch again' : 'Fetch the document'}
          </button>
        )}
      </div>
    </div>
  );
}
