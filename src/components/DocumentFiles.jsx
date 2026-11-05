import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { fetchDocumentFiles, setDocumentFiles } from '@/lib/mailbox';

// The Files tab: which files stand as this document's proof.
//
// A mail often carries more than the invoice — a booking's terms and
// conditions beside its e-ticket — and the wrong one can end up on the document.
// Tick what belongs, in the order wanted; one file is used as it is, several are
// joined into one PDF. The email itself is always on offer, since it can be the
// proof. The choice replaces the file on THIS document only.

export default function DocumentFiles({ billId, envelope, onChanged }) {
  const [state, setState] = useState({ loading: true, files: [], inXero: false, error: '' });
  const [picked, setPicked] = useState([]); // keys, in the order they were ticked
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await fetchDocumentFiles(billId);
      setState({ loading: false, files: data.files || [], inXero: Boolean(data.inXero), error: '' });
      setPicked((data.files || []).filter((f) => f.current).map((f) => f.key));
    } catch (err) {
      setState({ loading: false, files: [], inXero: false, error: err.message });
    }
  }, [billId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (key) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  const unchanged = picked.length === 1 && state.files.find((f) => f.key === picked[0])?.current;

  async function apply() {
    const names = picked.map((k) => state.files.find((f) => f.key === k)?.fileName || k).join('\n• ');
    const msg =
      picked.length > 1
        ? `Combine these into one PDF and use it as this document's file?\n\n• ${names}`
        : `Use this as this document's file?\n\n• ${names}`;
    if (!window.confirm(`${msg}\n\nThe file attached now is removed.`)) return;
    setBusy(true);
    setNote('');
    try {
      await setDocumentFiles({ billId, keys: picked, envelope });
      setNote('Done — the document now carries this file.');
      await onChanged?.();
      await load();
    } catch (err) {
      setNote(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (state.loading) return <p className="text-sm text-muted-foreground">Loading files…</p>;
  if (state.error) return <p className="text-sm text-red-600">{state.error}</p>;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Tick the files that prove this document, in the order you want them. One file is used as it is; several are
        combined into a single PDF.
      </p>
      <ul className="divide-y rounded-md border">
        {state.files.map((f) => {
          const n = picked.indexOf(f.key) + 1;
          return (
            <li key={f.key}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
                <input type="checkbox" checked={n > 0} onChange={() => toggle(f.key)} disabled={state.inXero || busy} />
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{f.fileName}</span>
                  <span className="block text-xs text-muted-foreground">{f.label}</span>
                </span>
                {n > 0 && picked.length > 1 && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{n}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      {state.inXero ? (
        <p className="text-xs text-muted-foreground">
          This document is already in Xero with its file, so the file can’t be changed here.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={apply}
            disabled={busy || !picked.length || unchanged}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {picked.length > 1 ? `Combine ${picked.length} files into one PDF` : 'Use this file'}
          </button>
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
      )}
    </div>
  );
}
