import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, FileCheck2, Info } from 'lucide-react';
import { formatDate } from '@/lib/date';
import { notifyBillsChanged } from '@/lib/bills';
import { codingDifferences, paperworkReason, recodeInstructions, recodeLocked, recodeLockedReason, txnNoun } from '@/lib/paperworkMatch';
import {
  invalidatePaperworkMatches,
  recodeXeroTransaction,
  refreshXeroTransaction,
  refreshPaperworkMatches,
  sendToXeroTransaction,
  unlinkXeroTransaction,
  usePaperworkMatches,
  xeroTxnUrl,
} from '@/lib/paperworkStore';
import { cn } from '@/lib/utils';

// Paperwork match on the document page — Dext's, and the reverse of Bank match.
// Xero ALREADY holds this money (a Spend Money coded off the card feed, a bill
// keyed in by hand), so publishing the document would post it a second time.
// Instead it is SENT there: the file is attached to that transaction and, when
// ticked, the transaction is recoded to what this document says. The coding on
// the two sides is laid out field by field first, because a recode rewrites a
// live ledger and the person pressing the button should see exactly what moves.
//
// Renders nothing for a document with no match and no link.

const money = (currency, n) => `${currency ? `${currency} ` : ''}${Math.abs(Number(n) || 0).toFixed(2)}`;
const actionCls =
  'inline-flex h-9 items-center rounded-md border-2 border-foreground px-4 text-sm font-semibold transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const linkCls = 'text-sm text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50';

function Summary({ txn, shortCode }) {
  const url = xeroTxnUrl(txn, shortCode);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 text-sm">
      <div className="min-w-0">
        <div className="font-medium">
          {txnNoun(txn)}
          {txn.contact ? ` to ${txn.contact}` : ''}
          {txn.number ? ` · ${txn.number}` : ''}
        </div>
        <div className="text-muted-foreground">
          {formatDate(txn.date)}
          {txn.bankAccount?.name ? ` · ${txn.bankAccount.name}` : ''}
          {txn.reconciled ? ' · reconciled' : ''}
          {txn.status && txn.kind === 'bill' ? ` · ${txn.status.toLowerCase()}` : ''}
        </div>
        {txn.reference ? <div className="break-all text-xs text-muted-foreground">Ref {txn.reference}</div> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-semibold tabular-nums">{money(txn.currency, txn.total)}</span>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
            Open in Xero <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function Differences({ diffs }) {
  if (!diffs.length) {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald-700">
        <Check className="h-4 w-4" /> Xero codes it the same way as this document.
      </p>
    );
  }
  return (
    <table className="mt-3 w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="pb-1 pr-3 font-medium">Coding differs</th>
          <th className="pb-1 pr-3 font-medium">This document</th>
          <th className="pb-1 font-medium">Xero now</th>
        </tr>
      </thead>
      <tbody>
        {diffs.map((d) => (
          <tr key={d.key} className="border-t align-top">
            <td className="py-1.5 pr-3 text-muted-foreground">{d.label}</td>
            <td className="py-1.5 pr-3 font-medium">{d.document}</td>
            <td className="py-1.5 text-amber-700">{d.xero}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// What to change by hand in Xero, for a transaction Xero will not let an app
// recode — named field by field, with the way in.
function ChangeInXero({ txn, diffs, shortCode }) {
  if (!diffs.length) return null;
  const url = xeroTxnUrl(txn, shortCode);
  return (
    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      <p>{recodeLockedReason(txn)} Change it in Xero instead{txn.kind === 'spend' ? ' (Options → Edit)' : ''}:</p>
      <ul className="mt-1 list-disc pl-5">
        {recodeInstructions(diffs).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline">
          Open it in Xero <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}

export default function PaperworkMatchPanel({ doc, mayPublish, xeroShortCode, onBeforeSend, onChanged }) {
  const linked = doc?.paperworkMatch || null;
  const pw = usePaperworkMatches({ enabled: Boolean(doc?.persisted) });
  const candidates = useMemo(() => (linked ? [] : pw.matches[doc?.id] || []), [linked, pw.matches, doc?.id]);
  const [recode, setRecode] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    setError('');
    setNote('');
  }, [doc?.id]);

  if (!doc?.persisted) return null;
  if (!linked && !candidates.length) return null;

  const hasCategory = Boolean(String(doc.category || '').trim()) && String(doc.category).toLowerCase() !== 'uncategorised';

  const run = async (key, fn) => {
    setBusy(key);
    setError('');
    setNote('');
    try {
      const out = await fn();
      invalidatePaperworkMatches();
      refreshPaperworkMatches();
      notifyBillsChanged();
      const bits = [];
      if (out?.attachment && !out.attachment.ok) bits.push(`The file was not attached: ${out.attachment.error || 'Xero refused it.'}`);
      if (out?.recode && !out.recode.ok) bits.push(`Xero did not take the new coding: ${out.recode.message || 'it refused.'}`);
      if (bits.length) setNote(bits.join(' '));
      await onChanged?.(out?.bill ?? null);
    } catch (err) {
      setError(err?.message || 'Something went wrong.');
      await onChanged?.(null);
    } finally {
      setBusy('');
    }
  };

  // ── Sent ────────────────────────────────────────────────────────────────────
  if (linked) {
    const diffs = codingDifferences(doc, linked, pw.trackingCategories.length ? pw.trackingCategories : trackingNamesOf(linked));
    const r = linked.recode;
    const locked = recodeLocked(linked);
    return (
      <div className="rounded-lg border bg-background p-4">
        <div className="mb-3 flex items-center gap-2 text-base font-semibold text-emerald-700">
          <FileCheck2 className="h-5 w-5" strokeWidth={1.75} />
          Sent to a transaction already in Xero
        </div>
        <Summary txn={linked} shortCode={xeroShortCode} />
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          <li>
            {linked.attachment?.ok
              ? 'File attached in Xero.'
              : linked.attachment
                ? `File not attached: ${linked.attachment.error || 'Xero refused it.'}`
                : 'No file to attach.'}
          </li>
          <li>
            {!r
              ? 'Coding left as Xero had it.'
              : r.ok
                ? `Recoded to this document on ${formatDate(String(r.at).slice(0, 10))}.`
                : locked
                  ? 'Not recoded — Xero does not let an app change it.'
                  : `Not recoded — ${r.message || 'Xero refused.'}`}
          </li>
        </ul>
        <Differences diffs={diffs} />
        {locked ? <ChangeInXero txn={linked} diffs={diffs} shortCode={xeroShortCode} /> : null}
        {note ? <p className="mt-2 text-xs text-amber-700">{note}</p> : null}
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        {mayPublish ? (
          <div className="mt-3 flex flex-wrap items-center gap-4">
            {/* After a hand edit in Xero, read the transaction again so the
                difference above stops being shown. Nothing is written. */}
            {diffs.length && locked ? (
              <button type="button" className={actionCls} disabled={Boolean(busy)} onClick={() => run('refresh', () => refreshXeroTransaction(doc.id))}>
                {busy === 'refresh' ? 'Checking…' : 'I’ve changed it — check Xero again'}
              </button>
            ) : null}
            {diffs.length && !locked ? (
              <button
                type="button"
                className={actionCls}
                disabled={Boolean(busy) || !hasCategory}
                title={hasCategory ? '' : 'Give the document a category first'}
                onClick={() =>
                  run('recode', async () => {
                    await onBeforeSend?.();
                    return recodeXeroTransaction(doc.id);
                  })
                }
              >
                {busy === 'recode' ? 'Recoding…' : 'Recode in Xero'}
              </button>
            ) : null}
            <button
              type="button"
              className={linkCls}
              disabled={Boolean(busy)}
              onClick={() => {
                if (!window.confirm('Unlink this document from the Xero transaction?\n\nIt goes back to the Costs list. Nothing changes in Xero — the attached file and the coding stay there.')) return;
                run('unlink', () => unlinkXeroTransaction(doc.id));
              }}
            >
              {busy === 'unlink' ? 'Unlinking…' : 'Unlink'}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  // ── Found ───────────────────────────────────────────────────────────────────
  const firm = candidates.filter((c) => c.confidence === 'firm');
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
        <p>
          {firm.length === 1
            ? 'Xero already has this payment. Publishing would post it a second time — send the receipt to that transaction instead.'
            : 'Xero has a transaction this could be the receipt for. If it is, send the receipt to it rather than publishing a second copy.'}
        </p>
      </div>
      {candidates.slice(0, 3).map((c) => {
        const diffs = codingDifferences(doc, c.txn, pw.trackingCategories);
        const locked = recodeLocked(c.txn);
        const wantRecode = !locked && (recode[c.txn.id] ?? (diffs.length > 0 && hasCategory));
        return (
          <div key={c.txn.id} className="rounded-lg border bg-background p-4">
            <div className={cn('mb-2 text-xs font-medium', c.confidence === 'firm' ? 'text-emerald-700' : 'text-muted-foreground')}>
              {c.confidence === 'firm' ? 'Paperwork match' : 'Possible match'} · {paperworkReason(c, doc)}
              {c.txn.hasAttachments ? ' · already has a file attached in Xero' : ''}
            </div>
            <Summary txn={c.txn} shortCode={xeroShortCode} />
            <Differences diffs={diffs} />
            {locked ? <ChangeInXero txn={c.txn} diffs={diffs} shortCode={xeroShortCode} /> : null}
            {mayPublish ? (
              <div className="mt-3 space-y-3">
                {diffs.length && !locked ? (
                  <label className={cn('flex items-start gap-2 text-sm', !hasCategory && 'opacity-60')}>
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={Boolean(wantRecode) && hasCategory}
                      disabled={!hasCategory}
                      onChange={(e) => setRecode((m) => ({ ...m, [c.txn.id]: e.target.checked }))}
                    />
                    <span>
                      Recode the Xero transaction to this document
                      <span className="block text-xs text-muted-foreground">
                        {hasCategory
                          ? 'Account, tax rate and tracking are rewritten to the left-hand column. The total stays the same.'
                          : 'Give the document a category first to recode it.'}
                      </span>
                    </span>
                  </label>
                ) : null}
                <button
                  type="button"
                  className={actionCls}
                  disabled={Boolean(busy)}
                  onClick={() => {
                    const doRecode = !locked && Boolean(wantRecode) && hasCategory && diffs.length > 0;
                    const what = doRecode ? 'attach this document and recode the transaction to it' : 'attach this document to it';
                    if (!window.confirm(`Send to the ${txnNoun(c.txn)} in Xero (${c.txn.contact || 'no contact'}, ${money(c.txn.currency, c.txn.total)} on ${formatDate(c.txn.date)})?\n\nThis will ${what}, and the document is set aside as done — it is not published.`)) return;
                    run(c.txn.id, async () => {
                      await onBeforeSend?.();
                      return sendToXeroTransaction(doc.id, c.txn, doRecode);
                    });
                  }}
                >
                  {busy === c.txn.id ? 'Sending…' : 'Send to Xero transaction'}
                </button>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Somebody who can publish to Xero sends it.</p>
            )}
          </div>
        );
      })}
      {note ? <p className="text-xs text-amber-700">{note}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// The tracking categories a stored transaction's lines name, in the order they
// appear — the fallback when the org's own list has not loaded.
function trackingNamesOf(txn) {
  const names = [];
  for (const l of txn?.lines || []) for (const t of l.tracking || []) if (t.category && !names.includes(t.category)) names.push(t.category);
  return names.slice(0, 2);
}
