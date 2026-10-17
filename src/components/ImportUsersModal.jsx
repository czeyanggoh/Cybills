import { useState } from 'react';
import { X, AlertTriangle, ArrowRight } from 'lucide-react';
import { updateUsers } from '@/lib/userStore';
import { fieldLabel } from '@/lib/rosterSheet';

// What an edited roster spreadsheet would change, shown before anything is
// saved. Every change is a row here — person, field, from, to — and every row of
// the sheet that will NOT be applied is named with its row number and why, so a
// fix is a matter of finding that row in Excel rather than guessing.
//
// `plan` is planRosterImport's answer; `fileName` is what was uploaded.
export default function ImportUsersModal({ plan, fileName, onClose, onApplied }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState([]); // [{ name, error }]

  if (!plan) return null;
  const { changes, errors, unchanged } = plan;
  const fieldCount = changes.reduce((n, c) => n + c.diffs.length, 0);

  const apply = async () => {
    setBusy(true);
    setFailed([]);
    const results = await updateUsers(
      changes.map((c) => ({ id: c.user.id, patch: c.patch })),
      (done) => setProgress(done)
    );
    setBusy(false);
    const nameOf = Object.fromEntries(changes.map((c) => [c.user.id, c.user.name]));
    const bad = results.filter((r) => !r.ok).map((r) => ({ name: nameOf[r.id], error: r.error }));
    const okCount = results.length - bad.length;
    // A refusal is the server's to explain (the last Business Admin can't be
    // demoted, for one), so the dialog stays open on it rather than closing on a
    // toast that says "some failed".
    if (bad.length) setFailed(bad);
    else onClose();
    onApplied?.(okCount, bad.length);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Import users from Excel</h2>
            {fileName && <p className="mt-0.5 text-xs text-muted-foreground">{fileName}</p>}
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-auto p-6 text-sm">
          <p className="text-muted-foreground">
            {changes.length
              ? `${changes.length} ${changes.length === 1 ? 'person' : 'people'} will be updated (${fieldCount} ${fieldCount === 1 ? 'change' : 'changes'}).`
              : 'Nothing in this file differs from the roster.'}
            {unchanged ? ` ${unchanged} unchanged.` : ''}
            {errors.length ? ` ${errors.length} ${errors.length === 1 ? 'row' : 'rows'} will be skipped.` : ''} Nothing is saved
            until you apply it.
          </p>

          {failed.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <p className="mb-1.5 font-medium text-destructive">These weren’t saved:</p>
              <ul className="space-y-1 text-destructive">
                {failed.map((f, i) => (
                  <li key={i}>
                    <span className="font-medium">{f.name}</span> — {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {errors.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-50 p-3 text-amber-900">
              <p className="mb-1.5 flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-4 w-4" /> Skipped — fix these rows in the file and import it again
              </p>
              <ul className="space-y-1">
                {errors.map((e, i) => (
                  <li key={i}>
                    {e.row ? <span className="tabular-nums">Row {e.row}</span> : null}
                    {e.name ? <span className="font-medium"> {e.name}</span> : null}
                    {e.row || e.name ? ': ' : ''}
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {changes.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Field</th>
                    <th className="px-3 py-2 font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.flatMap((c) =>
                    c.diffs.map((d, i) => (
                      <tr key={`${c.user.id}-${d.field}`} className="border-b last:border-0">
                        <td className="px-3 py-2 font-medium">{i === 0 ? c.user.name : ''}</td>
                        <td className="px-3 py-2 text-muted-foreground">{fieldLabel(d.field)}</td>
                        <td className="px-3 py-2">
                          <span className="text-muted-foreground line-through decoration-muted-foreground/50">{d.from}</span>
                          <ArrowRight className="mx-1.5 inline h-3.5 w-3.5 text-muted-foreground" />
                          <span className="font-medium">{d.to}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
          {busy && (
            <span className="mr-auto text-xs text-muted-foreground tabular-nums">
              Saving {progress} of {changes.length}…
            </span>
          )}
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50">
            {failed.length ? 'Close' : 'Cancel'}
          </button>
          {!failed.length && (
            <button
              type="button"
              onClick={apply}
              disabled={busy || !changes.length}
              className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : `Apply ${changes.length ? `${changes.length} ` : ''}${changes.length === 1 ? 'update' : 'updates'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
