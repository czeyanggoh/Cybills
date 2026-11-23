import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Info, Paperclip } from 'lucide-react';
import { costPath, declineSupportingDocs, fetchSupporting, linkSupportingDocs, notifyBillsChanged, unlinkSupportingDocs } from '@/lib/bills';
import { getActiveOrganisationId } from '@/lib/organisations';
import { reasonText } from '@/lib/supportingDocs';
import { formatDate } from '@/lib/date';
import { cn } from '@/lib/utils';

// Supporting documents on the document page, from either side
// (src/lib/supportingDocs.js). On a SUPPORTING document: the invoice it is
// backup for, with Undo. On an invoice: the documents behind it, and the ones
// that arrived with it that look like its backup, to confirm or keep separate.
// Renders nothing for a document that is neither, which is most of them.

const money = (currency, n) => `${currency ? `${currency} ` : ''}${(Number(n) || 0).toFixed(2)}`;
const actionCls =
  'inline-flex h-9 items-center rounded-md border-2 border-foreground px-4 text-sm font-semibold transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';
const linkCls = 'text-sm text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50';

function Frame({ done, title, note, error, children }) {
  return (
    <div className="space-y-3">
      {note ? (
        <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
          <p>{note}</p>
        </div>
      ) : null}
      <div className="rounded-lg border bg-background p-4">
        <div className={cn('mb-3 flex items-center gap-2 text-base font-semibold', done ? 'text-emerald-700' : 'text-amber-600')}>
          {done ? <Check className="h-5 w-5" /> : <Paperclip className="h-5 w-5" strokeWidth={1.75} />}
          {title}
        </div>
        {children}
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

function Row({ row, onOpen, children }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <div className="min-w-0">
        <button type="button" onClick={() => onOpen(row.id)} className="text-left hover:underline">
          <span className="font-medium">{row.supplier || 'Unknown supplier'}</span>
          <span className="text-muted-foreground">
            {row.displayId ? ` · #${row.displayId}` : ''}
            {row.date ? ` · ${formatDate(row.date)}` : ''}
          </span>
        </button>
        {row.reasons?.length ? <p className="text-xs text-muted-foreground">{reasonText(row) || 'Arrived with this invoice'}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="tabular-nums">{money(row.currency, row.total)}</span>
        {children}
      </div>
    </div>
  );
}

async function sendToXero(billId) {
  const org = getActiveOrganisationId();
  const res = await fetch(`/api/xero/organisations/${org}/attach-supporting`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org },
    body: JSON.stringify({ billId }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, message: data?.message || 'The files could not be sent to Xero.' };
  return data;
}

export default function SupportingDocsPanel({ doc, onChanged }) {
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');
  const depends = [doc?.id, doc?.total, doc?.status, doc?.supportingFor?.billId || '', (doc?.supportingDocs || []).join(',')].join('|');

  useEffect(() => {
    let alive = true;
    if (!doc?.id) return undefined;
    fetchSupporting(doc.id).then((out) => { if (alive) setInfo(out?.ok ? out : null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depends]);

  if (!info) return null;
  const open = (id) => navigate(costPath(id));

  const run = async (fn, after = '') => {
    setBusy(true);
    setError('');
    setSaid('');
    const out = await fn().catch(() => ({ ok: false, message: 'That could not be done.' }));
    if (!out?.ok) setError(out?.message || 'That could not be done.');
    else {
      setSaid(typeof after === 'function' ? after(out) : after);
      notifyBillsChanged();
      const next = await fetchSupporting(doc.id);
      setInfo(next?.ok ? next : null);
      await onChanged?.();
    }
    setBusy(false);
  };

  // --- a supporting document -------------------------------------------------------
  if (info.kind === 'support') {
    return (
      <Frame
        done
        title="Supporting document"
        note="This document is the paperwork behind an invoice that already carries its money, so it is set aside and not published on its own. Its file goes to Xero with the invoice."
        error={error}
      >
        <div className="space-y-3">
          {info.main ? <Row row={info.main} onOpen={open} /> : <p className="text-sm text-muted-foreground">The invoice it supports is not one you can open.</p>}
          <p className="text-xs text-muted-foreground">
            {info.link?.auto ? 'Linked automatically: ' : 'Linked by hand'}
            {info.link?.auto ? reasonText(info.link) || 'it arrived in the same email and ties to the invoice' : ''}.
          </p>
          <button type="button" disabled={busy} onClick={() => run(() => unlinkSupportingDocs(doc.id))} className={linkCls}>
            This is a cost of its own, undo
          </button>
        </div>
      </Frame>
    );
  }

  const supports = info.supports || [];
  const suggestions = info.suggestions || [];
  if (!supports.length && !suggestions.length) return null;
  const ids = suggestions.map((s) => s.id);

  return (
    <div className="space-y-3">
      {supports.length ? (
        <Frame done title={`${supports.length} supporting document${supports.length === 1 ? '' : 's'}`} error={suggestions.length ? '' : error}>
          <div className="space-y-2">
            {supports.map((s) => (
              <Row key={s.id} row={s} onOpen={open}>
                <button type="button" disabled={busy} onClick={() => run(() => unlinkSupportingDocs(doc.id, [s.id]))} className={linkCls}>
                  Undo
                </button>
              </Row>
            ))}
            <p className="pt-1 text-xs text-muted-foreground">
              Set aside, so the same spending is not published twice.{' '}
              {info.inXero
                ? 'This invoice is already in Xero, so their files have to be sent there now.'
                : 'Their files are attached to the bill in Xero when this invoice is published.'}
            </p>
            {info.inXero ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(
                    () => sendToXero(doc.id),
                    (out) => {
                      const s = out.supporting || {};
                      const failed = (s.failed || []).map((f) => `#${f.displayId}: ${f.error}`).join(' ');
                      return `${s.attached || 0} file${s.attached === 1 ? '' : 's'} sent to Xero.${failed ? ` Not sent: ${failed}` : ''}`;
                    }
                  )
                }
                className={actionCls}
              >
                Send their files to Xero
              </button>
            ) : null}
            {said ? <p className="text-xs text-muted-foreground">{said}</p> : null}
          </div>
        </Frame>
      ) : null}
      {suggestions.length ? (
        <Frame
          title={`${suggestions.length === 1 ? 'A document' : `${suggestions.length} documents`} that arrived with this invoice may be its supporting paperwork`}
          note="If these are the receipts or reports this invoice recharges, publishing them as well would post the same spending twice. Confirm, and they are set aside and sent to Xero with this invoice."
          error={error}
        >
          <div className="space-y-2">
            {suggestions.map((s) => (
              <Row key={s.id} row={s} onOpen={open} />
            ))}
            <div className="flex flex-wrap items-center gap-4 pt-2">
              <button type="button" disabled={busy} onClick={() => run(() => linkSupportingDocs(doc.id, ids))} className={actionCls}>
                Yes, supporting documents
              </button>
              <button type="button" disabled={busy} onClick={() => run(() => declineSupportingDocs(doc.id, ids))} className={linkCls}>
                Keep separate
              </button>
            </div>
          </div>
        </Frame>
      ) : null}
    </div>
  );
}
