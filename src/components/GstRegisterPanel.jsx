import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchGstCheck, postGstCheck } from '@/lib/bills';
import { IRAS_TERMS_URL, irasNotice } from '@/lib/gstRegisterCheck';

// What IRAS's GST register said about this cost's supplier, under the tax code.
// The practice's own team only: the server answers `visible: false` to anybody
// else, and this draws nothing.
const SOURCE = {
  paper: 'the number printed on this document',
  rule: 'the number on a supplier rule or an earlier check',
  memory: 'the number read from an earlier document',
  name: 'the supplier’s name, looked up in ACRA',
  contact: 'the GST number on the Xero contact',
};

function summary(c) {
  if (c.skipped === 'contact_has_number') return { tone: 'muted', text: 'Not checked: the Xero contact already holds a GST number.' };
  if (!c.matched) return { tone: 'warn', text: 'No business of this exact name was found in ACRA, so nothing was checked.' };
  if (c.verdict === 'registered') return { tone: 'ok', text: 'GST-registered on the invoice date.' };
  if (c.verdict === 'not_registered') {
    return {
      tone: 'bad',
      text: c.hold
        ? 'Not GST-registered on the invoice date: held at No Tax.'
        : 'The business found by this name was not GST-registered on the invoice date.',
    };
  }
  return { tone: 'warn', text: 'IRAS’s answer does not settle whether the supplier was registered on the invoice date.' };
}

const TONE = { ok: 'text-emerald-700', bad: 'text-destructive', warn: 'text-amber-700', muted: 'text-muted-foreground' };

export default function GstRegisterPanel({ billId, revision, supplier }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    let live = true;
    fetchGstCheck(billId).then((r) => { if (live) setState(r); });
    return () => { live = false; };
  }, [billId]);
  // Again when the document changes, and once more a little later: the check
  // runs behind an upload or an edit.
  useEffect(() => {
    setError('');
    const stop = load();
    const t = setTimeout(load, 6000);
    return () => { stop(); clearTimeout(t); };
  }, [load, revision]);

  if (!state?.visible) return null;
  const c = state.check;

  const act = async (action) => {
    setBusy(action || 'check');
    setError('');
    try {
      const r = await postGstCheck(billId, action);
      setState(r);
      // The check can put the document to No Tax: show what it now says.
      if (r.changed) window.location.reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const s = c ? summary(c) : null;
  // Offered only where a NUMBER gave a different name, for the supplier still here.
  const renameTo = c?.registeredName && c.source !== 'name' && c.supplier === supplier ? c.registeredName : '';
  const rename = async () => {
    const ok = window.confirm(
      `Rename “${supplier}” to its registered name, “${renameTo}”?\n\n` +
        'The contact in Xero is renamed, so past bills there show the new name; its bank details and history stay. ' +
        'This company’s documents, supplier rule and billing plans in CYBills move with it.'
    );
    if (!ok) return;
    setBusy('rename');
    setError('');
    try {
      await postGstCheck(billId, 'rename');
      // Supplier rules and lists were changed on the server: read them afresh.
      window.location.reload();
    } catch (e) {
      setError(e.message);
      setBusy('');
    }
  };
  const button = 'rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50';

  return (
    <div className="mt-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">IRAS GST register</span>
        <button type="button" className={button} disabled={Boolean(busy)} onClick={() => act('')}>
          {busy === 'check' ? <Loader2 className="h-3 w-3 animate-spin" /> : c ? 'Check again' : 'Check now'}
        </button>
      </div>
      {!c && <p className="mt-1 text-muted-foreground">Not checked.</p>}
      {c && <p className={`mt-1 ${TONE[s.tone]}`}>{s.text}</p>}
      {c?.matched && c.irasName && (
        <p className="mt-1 text-muted-foreground">
          {c.irasName} · GST no. {c.gstRegNo || '—'}
          {c.registeredFrom ? ` · registered ${c.registeredFrom}${c.registeredTo ? ` to ${c.registeredTo}` : ''}` : ''}
          <br />
          Checked by {SOURCE[c.source] || c.source}.
        </p>
      )}
      {c?.matched && c.irasName && !c.nameMatches && (
        <p className="mt-1 text-amber-700">IRAS’s name differs from the supplier’s ({c.supplier}). Confirm it is the same business.</p>
      )}
      {c?.saved && (
        <p className="mt-1 text-muted-foreground">
          {c.saved.fields?.length
            ? `Saved to the Xero contact on ${c.saved.at.slice(0, 10)}.`
            : 'The Xero contact already holds its numbers; nothing was replaced.'}
        </p>
      )}
      {c && !c.saved && c.autoSave && (
        <p className="mt-1 text-muted-foreground">Will be saved to the Xero contact when this is published.</p>
      )}
      {c && !c.saved && c.confirmable && (
        <div className="mt-2">
          <button type="button" className={button} disabled={Boolean(busy)} onClick={() => act('save')}>
            {busy === 'save' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save to Xero contact'}
          </button>
          {c.source === 'name' && <span className="ml-2 text-muted-foreground">Re-read afterwards to claim the GST.</span>}
        </div>
      )}
      {renameTo && (
        <div className="mt-2">
          <p className="text-muted-foreground">Registered name: <span className="font-medium">{renameTo}</span></p>
          <button type="button" className={`mt-1 ${button}`} disabled={Boolean(busy)} onClick={rename}>
            {busy === 'rename' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Use registered name'}
          </button>
        </div>
      )}
      {(error || c?.saveError) && <p className="mt-1 text-destructive">{error || c.saveError}</p>}
      {c?.matched && c.outcome && (
        <p className="mt-2 text-[10px] leading-snug text-muted-foreground/80">
          {irasNotice(c.checkedAt)}{' '}
          <a href={IRAS_TERMS_URL} target="_blank" rel="noreferrer" className="underline">Terms</a>
        </p>
      )}
    </div>
  );
}
