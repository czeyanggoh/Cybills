import { useEffect, useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

// A lightweight issue/request board (Support Desk + Feature Requests share it).
// Persistence is client-side localStorage — cybills has no domain-data backend
// yet, so screenshots are kept inline as data URLs. Swap `load`/`persist` for
// an API layer later without touching the UI.

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-SG', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const FILTERS = ['all', 'open', 'done', 'closed'];

const UNASSIGNED = '';

export default function RequestBoard({ title, intro, emptyLabel, composerPlaceholder, storageKey, viewToggle = null }) {
  const { user } = useAuth();
  const author = user?.name || user?.email || '';

  const [tickets, setTickets] = useState([]);
  const [assignees, setAssignees] = useState([]); // [{ id, email, name }]
  const [input, setInput] = useState('');
  const [pendingImgs, setPendingImgs] = useState([]); // [{ url, name }]
  const [drafts, setDrafts] = useState({});
  const [commentImgs, setCommentImgs] = useState({}); // { [id]: [{ url, name }] }
  const [filter, setFilter] = useState('all');
  const [lightbox, setLightbox] = useState(null);
  const [quotaError, setQuotaError] = useState(false);
  const fileRef = useRef(null);

  // Load persisted tickets once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setTickets(raw ? JSON.parse(raw) : []);
    } catch {
      setTickets([]);
    }
  }, [storageKey]);

  // Load the assignable-user roster (any signed-in user may read it). Best
  // effort — the dropdown just falls back to "Unassigned" if it can't load.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/org/assignees');
        if (!res.ok) return;
        const data = await res.json();
        if (alive && Array.isArray(data.assignees)) setAssignees(data.assignees);
      } catch {
        // Backend unreachable — leave the roster empty.
      }
    })();
    return () => { alive = false; };
  }, []);

  // Close the lightbox on Escape.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => { if (e.key === 'Escape') setLightbox(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // Write to state + localStorage together; flag quota overflow (big screenshots).
  function persist(next) {
    setTickets(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setQuotaError(false);
    } catch {
      setQuotaError(true);
    }
  }

  function submit() {
    if (!input.trim() && pendingImgs.length === 0) return;
    const ticket = {
      id: crypto.randomUUID(),
      text: input.trim(),
      screenshots: pendingImgs.map((p) => p.url),
      status: 'open',
      author,
      created_at: new Date().toISOString(),
      comments: [],
    };
    persist([ticket, ...tickets]);
    setInput('');
    setPendingImgs([]);
  }

  // ── Uploads ──────────────────────────────────────────────────
  async function uploadInto(files, add) {
    for (const f of files.filter((f) => f.type.startsWith('image/'))) {
      const url = await fileToDataUrl(f);
      add({ url, name: f.name || 'pasted image' });
    }
  }
  const addPending = (img) => setPendingImgs((prev) => [...prev, img]);
  const addCommentImg = (id) => (img) =>
    setCommentImgs((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), img] }));

  function removePending(idx) {
    setPendingImgs((prev) => prev.filter((_, i) => i !== idx));
  }
  function removeCommentImg(id, idx) {
    setCommentImgs((prev) => ({ ...prev, [id]: (prev[id] ?? []).filter((_, i) => i !== idx) }));
  }

  async function onFileChange(e, add) {
    const files = Array.from(e.target.files ?? []);
    if (files.length) await uploadInto(files, add);
    e.target.value = ''; // allow re-selecting the same file
  }
  async function onPasteImages(e, add) {
    const files = Array.from(e.clipboardData.items)
      .filter((i) => i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter(Boolean);
    if (files.length) { e.preventDefault(); await uploadInto(files, add); }
  }
  async function onDropImages(e, add) {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); await uploadInto(files, add); }
  }

  function setStatus(id, next) {
    persist(tickets.map((t) => (t.id === id ? { ...t, status: next } : t)));
  }
  function toggle(t) {
    setStatus(t.id, t.status === 'done' ? 'open' : 'done');
  }
  function remove(id) {
    persist(tickets.filter((t) => t.id !== id));
  }

  // Assign an item to a user (or clear it). Stored inline on the item — no
  // schema migration since items are a JSON blob.
  function setAssignee(id, assigneeId) {
    const picked = assigneeId ? assignees.find((a) => a.id === assigneeId) : null;
    persist(
      tickets.map((t) => {
        if (t.id !== id) return t;
        if (!picked) {
          // Preserve an already-set assignee that's missing from the roster.
          if (assigneeId && t.assignee?.id === assigneeId) return t;
          return { ...t, assignee: null };
        }
        return { ...t, assignee: { id: picked.id, name: picked.name } };
      })
    );
  }

  // Options for a given item: the roster, plus the item's current assignee if
  // they're no longer in the roster (so the value isn't silently dropped).
  function optionsFor(t) {
    const cur = t.assignee;
    if (cur?.id && !assignees.some((a) => a.id === cur.id)) {
      return [{ id: cur.id, name: cur.name || cur.id }, ...assignees];
    }
    return assignees;
  }

  function addComment(t) {
    const text = (drafts[t.id] ?? '').trim();
    const imgs = commentImgs[t.id] ?? [];
    if (!text && imgs.length === 0) return;
    const comment = {
      author, text, created_at: new Date().toISOString(),
      screenshots: imgs.map((i) => i.url),
    };
    persist(tickets.map((x) => (x.id === t.id ? { ...x, comments: [...(x.comments ?? []), comment] } : x)));
    setDrafts((d) => ({ ...d, [t.id]: '' }));
    setCommentImgs((prev) => ({ ...prev, [t.id]: [] }));
  }

  const shown = tickets.filter((t) => filter === 'all' || t.status === filter);
  const openCount = tickets.filter((t) => t.status !== 'done' && t.status !== 'closed').length;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <span className="text-sm text-muted-foreground">{openCount} open</span>
      </div>
      <div className="mb-4 mt-2 h-0.5 w-10 bg-foreground" />
      {viewToggle && <div className="mb-4">{viewToggle}</div>}
      <p className="mb-4 text-sm text-muted-foreground">{intro}</p>

      {quotaError && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Storage is full — this browser can’t save more screenshots. Remove some items or attach smaller images.
        </div>
      )}

      {/* Filter */}
      <div className="mb-4 flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-md px-3 py-1 text-sm transition-colors',
              filter === f ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-muted/70'
            )}
          >
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Ticket list */}
      <div className="mb-6 divide-y rounded-xl border">
        {shown.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No {emptyLabel} {filter !== 'all' ? `(${filter})` : 'yet'}.
          </div>
        ) : shown.map((t) => (
          <div key={t.id} className="flex items-start gap-3 p-4">
            <input
              type="checkbox"
              checked={t.status === 'done'}
              onChange={() => toggle(t)}
              className="mt-1 h-4 w-4"
              title="Mark done"
            />
            <div className="min-w-0 flex-1">
              <div className={cn('text-sm', t.status === 'done' || t.status === 'closed' ? 'text-muted-foreground line-through' : 'text-foreground')}>
                {t.text}
              </div>
              {(t.screenshots?.length ?? 0) > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.screenshots.map((url, i) => (
                    <img
                      key={i}
                      src={url}
                      alt={`screenshot ${i + 1}`}
                      title="Click to enlarge"
                      onClick={() => setLightbox(url)}
                      className="max-h-48 cursor-zoom-in rounded border hover:opacity-90"
                    />
                  ))}
                </div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>{t.author || '—'}{t.created_at ? ` · ${fmtTime(t.created_at)}` : ''}</span>
                {t.status === 'closed' && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">Closed</span>
                )}
                <label className="flex items-center gap-1">
                  <span className="sr-only">Assignee</span>
                  <select
                    value={t.assignee?.id ?? UNASSIGNED}
                    onChange={(e) => setAssignee(t.id, e.target.value)}
                    title="Assign to a colleague"
                    className="rounded-md border bg-background px-1.5 py-0.5 text-xs text-foreground focus:border-foreground/40 focus:outline-none"
                  >
                    <option value={UNASSIGNED}>Unassigned</option>
                    {optionsFor(t).map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Comment thread */}
              {(t.comments?.length ?? 0) > 0 && (
                <div className="mt-3 space-y-2 border-l-2 pl-3">
                  {t.comments.map((c, i) => (
                    <div key={i} className="text-sm">
                      {c.text && <div className="whitespace-pre-wrap text-foreground/80">{c.text}</div>}
                      {(c.screenshots?.length ?? 0) > 0 && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {c.screenshots.map((url, j) => (
                            <img
                              key={j}
                              src={url}
                              alt={`reply screenshot ${j + 1}`}
                              title="Click to enlarge"
                              onClick={() => setLightbox(url)}
                              className="max-h-40 cursor-zoom-in rounded border hover:opacity-90"
                            />
                          ))}
                        </div>
                      )}
                      <div className="mt-0.5 text-xs text-muted-foreground">↳ {c.author || 'Support'} · {fmtTime(c.created_at)}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add a reply (text and/or screenshots) */}
              <div className="mt-2" onDrop={(e) => onDropImages(e, addCommentImg(t.id))} onDragOver={(e) => e.preventDefault()}>
                {(commentImgs[t.id]?.length ?? 0) > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {commentImgs[t.id].map((img, i) => (
                      <div key={i} className="relative">
                        <img src={img.url} alt={img.name} title={img.name} className="h-14 w-14 rounded-md border object-cover" />
                        <button
                          type="button"
                          onClick={() => removeCommentImg(t.id, i)}
                          aria-label="Remove screenshot"
                          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-xs leading-none text-background shadow"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    value={drafts[t.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addComment(t); } }}
                    onPaste={(e) => onPasteImages(e, addCommentImg(t.id))}
                    placeholder="Reply with status or findings… paste or drop a screenshot. (⌘/Ctrl+Enter)"
                    rows={1}
                    className="flex-1 resize-none rounded-md border px-2 py-1 text-sm focus:border-foreground/40 focus:outline-none"
                  />
                  <label className="flex h-8 cursor-pointer select-none items-center rounded-md px-2 text-sm text-muted-foreground hover:text-foreground" title="Attach screenshot">
                    <Paperclip className="h-4 w-4" />
                    <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => onFileChange(e, addCommentImg(t.id))} />
                  </label>
                  <button
                    type="button"
                    onClick={() => addComment(t)}
                    disabled={!(drafts[t.id] ?? '').trim() && (commentImgs[t.id]?.length ?? 0) === 0}
                    className="rounded-md bg-foreground px-3 py-1 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
                  >
                    Comment
                  </button>
                </div>
              </div>
            </div>

            {/* Right-side actions */}
            <div className="flex flex-col items-end gap-1.5">
              <button type="button" onClick={() => remove(t.id)} title="Delete" className="text-sm text-muted-foreground hover:text-foreground">✕</button>
              {t.status === 'closed' ? (
                <button type="button" onClick={() => setStatus(t.id, 'open')} title="Reopen this case" className="whitespace-nowrap text-xs text-muted-foreground hover:text-foreground">Reopen</button>
              ) : (
                <button type="button" onClick={() => setStatus(t.id, 'closed')} title="Close this case — the requestor is done with it" className="whitespace-nowrap text-xs text-muted-foreground hover:text-foreground">Close case</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <div
        className="sticky bottom-4 rounded-xl border border-foreground bg-background p-3"
        onDrop={(e) => onDropImages(e, addPending)}
        onDragOver={(e) => e.preventDefault()}
      >
        {pendingImgs.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingImgs.map((img, i) => (
              <div key={i} className="relative">
                <img src={img.url} alt={img.name} title={img.name} className="h-16 w-16 rounded-md border object-cover" />
                <button
                  type="button"
                  onClick={() => removePending(i)}
                  aria-label="Remove screenshot"
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-xs leading-none text-background shadow"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          onPaste={(e) => onPasteImages(e, addPending)}
          placeholder={composerPlaceholder}
          rows={2}
          className="w-full resize-none bg-transparent text-sm focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <Paperclip className="h-4 w-4" /> Attach screenshot
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple onChange={(e) => onFileChange(e, addPending)} className="hidden" />
          <button
            type="button"
            onClick={submit}
            disabled={!input.trim() && pendingImgs.length === 0}
            className="rounded-md bg-foreground px-4 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>

      {/* Lightbox — view a screenshot in place instead of a new tab */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="screenshot full size" className="max-h-full max-w-full rounded shadow-lg" onClick={(e) => e.stopPropagation()} />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="Close"
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-lg leading-none text-black hover:bg-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
