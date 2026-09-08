import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Link2, RotateCcw, Info, RefreshCw, EyeOff, ExternalLink, AlertTriangle } from 'lucide-react';
import { useCostsDocs } from '@/lib/costsData';
import { costPath } from '@/lib/bills';
import { formatDate } from '@/lib/date';
import { useActiveOrganisation, useXeroAccounts } from '@/lib/organisations';
import { fetchBankOutstanding, matchBankLine, undoBankMatch, dismissBankLine, restoreBankLine } from '@/lib/bankStore';
import { bankMatches, lineKey, suggestionFor, isMoneyOut, docAmountFor } from '@/lib/bankMatch';
import { cn } from '@/lib/utils';

// Bank match, the way Dext does it.
//
// CYWorkspace's auto bank reconciliation settles each unreconciled statement
// line against the Xero bill it pays; what it could not settle comes here. Most
// of those lines pay a document that is still only in CYBills — read, coded,
// never published — so the page suggests the document each line pays
// (src/lib/bankMatch.js) and "Match" publishes it AUTHORISED and records the
// payment from that bank account on the statement date, which is what makes
// the line clear in Xero's own reconciliation.

const money = (amount, currency) => {
  const n = Number(amount) || 0;
  return `${n < 0 ? '−' : '+'}${currency ? `${currency} ` : ''}${Math.abs(n).toFixed(2)}`;
};

function Badge({ tone = 'muted', children }) {
  const tones = {
    firm: 'bg-emerald-100 text-emerald-800',
    possible: 'bg-amber-100 text-amber-800',
    matched: 'bg-foreground text-background',
    muted: 'bg-muted text-muted-foreground',
    dismissed: 'bg-muted text-muted-foreground line-through',
  };
  return <span className={cn('inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}

// One document, as the "pays" column names it.
function DocRef({ doc, line }) {
  const amount = docAmountFor(doc, line);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <Link to={costPath(doc)} className="font-medium hover:underline">{doc.supplier}</Link>
      <span className="text-xs text-muted-foreground">
        #{doc.displayId} · {formatDate(doc.date)}
        {amount != null ? ` · ${line.currency || doc.currency} ${amount.toFixed(2)}` : ''}
        {doc.xeroInvoiceId ? ' · in Xero' : ''}
        {doc.paid ? ' · marked paid' : ''}
      </span>
    </span>
  );
}

export default function BankMatch() {
  const organisation = useActiveOrganisation();
  const { allDocs, reload: reloadDocs } = useCostsDocs();
  const { data: accounts = [] } = useXeroAccounts(organisation?.tenantId ? organisation.id : '');
  const bankAccounts = useMemo(
    () => (accounts || []).filter((a) => String(a.type).toUpperCase() === 'BANK'),
    [accounts]
  );

  const [state, setState] = useState({ loading: true, lines: [], records: [], error: '', code: '', retrievedAt: '', reports: [], tenant: null });
  const [acct, setAcct] = useState('all');
  const [showDone, setShowDone] = useState(false);
  // Per line: the document a person picked (when several were possible), the
  // bank account they picked (where CYWS resolved none), and what is happening.
  const [picked, setPicked] = useState({}); // key -> doc id
  const [pickedAccount, setPickedAccount] = useState({}); // key -> account code
  const [busy, setBusy] = useState({}); // key -> true
  const [errors, setErrors] = useState({}); // key -> message
  const [bulk, setBulk] = useState(null); // { done, total, failed } while matching all

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const out = await fetchBankOutstanding();
      setState({
        loading: false,
        lines: out.lines || [],
        records: out.records || [],
        error: out.ok ? '' : out.message || 'CYWorkspace could not be asked.',
        code: out.ok ? '' : out.error || '',
        retrievedAt: out.retrieved_at || '',
        reports: out.reports || [],
        tenant: out.tenant || null,
      });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message, code: err.code || '' }));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, organisation?.id]);

  // What has been done to each line, by key.
  const recordByKey = useMemo(() => {
    const m = new Map();
    for (const r of state.records) m.set(r.key, r);
    return m;
  }, [state.records]);

  // Suggestions over the lines still open, against the documents that could pay
  // one. `bankMatches` claims each document for one line.
  const openLines = useMemo(() => state.lines.filter((l) => !recordByKey.has(l.key)), [state.lines, recordByKey]);
  const matches = useMemo(() => bankMatches(openLines, allDocs), [openLines, allDocs]);
  const docById = useMemo(() => new Map(allDocs.map((d) => [d.id, d])), [allDocs]);

  // Matched lines CYWS no longer lists are still shown under "done": they are
  // payments in a live ledger, and the undo lives here.
  const rows = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const line of state.lines) {
      seen.add(line.key);
      out.push({ line, record: recordByKey.get(line.key) || null });
    }
    for (const r of state.records) {
      if (!seen.has(r.key) && r.kind === 'match') out.push({ line: r.line, record: r, gone: true });
    }
    return out;
  }, [state.lines, state.records, recordByKey]);

  const accountNames = useMemo(() => {
    const names = new Set();
    for (const { line } of rows) if (line.bank_account_name) names.add(line.bank_account_name);
    return Array.from(names);
  }, [rows]);

  const visible = rows.filter(({ line, record }) => {
    if (acct !== 'all' && line.bank_account_name !== acct) return false;
    if (!showDone && record) return false;
    return true;
  });

  const counts = useMemo(() => {
    let firm = 0;
    let possible = 0;
    let none = 0;
    for (const line of openLines) {
      const cands = matches.get(line.key) || [];
      if (suggestionFor(cands)) firm += 1;
      else if (cands.length) possible += 1;
      else none += 1;
    }
    return { firm, possible, none, matched: state.records.filter((r) => r.kind === 'match').length, dismissed: state.records.filter((r) => r.kind === 'dismissed').length };
  }, [openLines, matches, state.records]);

  // The document a line will be matched to: the person's pick, else the one
  // suggestion. A line with several possibilities and no pick has none.
  const chosenFor = (line) => {
    const cands = matches.get(line.key) || [];
    const id = picked[line.key];
    if (id) return cands.find((c) => c.doc.id === id)?.doc || docById.get(id) || null;
    return suggestionFor(cands)?.doc || null;
  };

  const lineToSend = (line) => (line.bank_account_id ? line : { ...line, bank_account_code: pickedAccount[line.key] || '' });

  // Settle one line. Answers whether it went through, for the bulk road.
  const match = async (line, doc) => {
    if (!doc) return false;
    setBusy((b) => ({ ...b, [line.key]: true }));
    setErrors((e) => ({ ...e, [line.key]: '' }));
    try {
      const out = await matchBankLine(doc.id, lineToSend(line));
      setState((s) => ({ ...s, records: [...s.records.filter((r) => r.id !== out.match?.id), out.match].filter(Boolean) }));
      reloadDocs();
      return true;
    } catch (err) {
      setErrors((e) => ({ ...e, [line.key]: err.message }));
      return false;
    } finally {
      setBusy((b) => ({ ...b, [line.key]: false }));
    }
  };

  const undo = async (record) => {
    setBusy((b) => ({ ...b, [record.key]: true }));
    setErrors((e) => ({ ...e, [record.key]: '' }));
    try {
      await undoBankMatch(record.id);
      setState((s) => ({ ...s, records: s.records.filter((r) => r.id !== record.id) }));
      reloadDocs();
    } catch (err) {
      setErrors((e) => ({ ...e, [record.key]: err.message }));
    } finally {
      setBusy((b) => ({ ...b, [record.key]: false }));
    }
  };

  const dismiss = async (line) => {
    setBusy((b) => ({ ...b, [line.key]: true }));
    try {
      const out = await dismissBankLine(line);
      setState((s) => ({ ...s, records: [...s.records, out.record] }));
    } catch (err) {
      setErrors((e) => ({ ...e, [line.key]: err.message }));
    } finally {
      setBusy((b) => ({ ...b, [line.key]: false }));
    }
  };

  const restore = async (record) => {
    setBusy((b) => ({ ...b, [record.key]: true }));
    try {
      await restoreBankLine(record.id);
      setState((s) => ({ ...s, records: s.records.filter((r) => r.id !== record.id) }));
    } catch (err) {
      setErrors((e) => ({ ...e, [record.key]: err.message }));
    } finally {
      setBusy((b) => ({ ...b, [record.key]: false }));
    }
  };

  // Every line with exactly one firm suggestion, one after another — each is a
  // publish and a payment into a live ledger, so it asks first and reports the
  // shortfall by line rather than stopping at the first refusal.
  const matchAllFirm = async () => {
    const todo = openLines
      .map((line) => ({ line, doc: suggestionFor(matches.get(line.key) || [])?.doc }))
      .filter(({ line, doc }) => doc && (line.bank_account_id || pickedAccount[line.key]));
    if (!todo.length) return;
    const ok = window.confirm(
      `Match ${todo.length} statement line${todo.length === 1 ? '' : 's'} to the document${todo.length === 1 ? '' : 's'} suggested? Each document not yet in Xero is published as Awaiting payment, and a payment is recorded against it from the bank account on the statement date.`
    );
    if (!ok) return;
    let done = 0;
    let failed = 0;
    setBulk({ done, total: todo.length, failed });
    for (const { line, doc } of todo) {
      // One at a time: each is a publish and a payment against the same tenant's
      // rate limit, and a refusal is reported beside its own line.
      // eslint-disable-next-line no-await-in-loop
      const ok = await match(line, doc);
      done += 1;
      if (!ok) failed += 1;
      setBulk({ done, total: todo.length, failed });
    }
  };

  const firmReady = openLines.filter((line) => suggestionFor(matches.get(line.key) || []) && (line.bank_account_id || pickedAccount[line.key])).length;

  if (organisation && !organisation.tenantId) {
    return (
      <div className="rounded-lg border bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
        “{organisation.name}” isn’t connected to Xero, so there is no bank to reconcile here.
      </div>
    );
  }

  return (
    <>
      <div className="mb-4 flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
        <p>
          <span className="font-medium text-foreground">Where these lines come from.</span>{' '}
          CYWorkspace’s auto bank reconciliation reads {state.tenant?.name ? <>{state.tenant.name}’s</> : 'this entity’s'} Xero bank
          reconciliation report and settles each statement line against the bill it pays. These are the lines it could not settle —
          usually because the bill is still only here. <span className="font-medium text-foreground">Match</span> publishes the
          document (Awaiting payment) and records the payment from that bank account on the statement date, so the line clears in Xero.
          {state.retrievedAt ? <> Retrieved {formatDate(state.retrievedAt.slice(0, 10))}{state.reports.length ? ` from ${state.reports.map((r) => r.name).join(', ')}` : ''}.</> : null}
        </p>
      </div>

      {state.error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">
              {state.code === 'route_missing' ? 'CYWorkspace needs updating before lines can be retrieved.' : 'CYWorkspace could not be asked for the outstanding lines.'}
            </p>
            <p className="text-xs">{state.error}</p>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 border-b pb-3">
        {[{ id: 'all', label: 'All accounts' }, ...accountNames.map((n) => ({ id: n, label: n }))].map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setAcct(a.id)}
            className={cn('rounded-md px-3 py-1.5 text-sm transition-colors', acct === a.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}
          >
            {a.label}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {counts.firm} suggested · {counts.possible} to choose · {counts.none} unmatched · {counts.matched} matched
          </span>
          <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show matched &amp; ignored
          </label>
          <button type="button" onClick={load} disabled={state.loading} title="Ask CYWorkspace again" className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors hover:bg-muted disabled:opacity-50">
            <RefreshCw className={cn('h-3.5 w-3.5', state.loading && 'animate-spin')} /> Refresh
          </button>
          <button
            type="button"
            onClick={matchAllFirm}
            disabled={!firmReady || Boolean(bulk && bulk.done < bulk.total)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Link2 className="h-3.5 w-3.5" /> Match all suggested{firmReady ? ` (${firmReady})` : ''}
          </button>
        </div>
      </div>

      {bulk && (
        <p className="mb-3 text-xs text-muted-foreground">
          {bulk.done < bulk.total ? `Matching ${bulk.done + 1} of ${bulk.total}…` : `Matched ${bulk.total - bulk.failed} of ${bulk.total}.${bulk.failed ? ' The rest say why beside the line.' : ''}`}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-2.5 font-medium">Date</th>
              <th className="px-3 py-2.5 font-medium">Bank account</th>
              <th className="px-3 py-2.5 font-medium">Statement line</th>
              <th className="px-3 py-2.5 text-right font-medium">Amount</th>
              <th className="px-3 py-2.5 font-medium">Pays</th>
              <th className="px-3 py-2.5 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ line, record, gone }) => {
              const key = line.key || lineKey(line);
              const cands = record ? [] : matches.get(key) || [];
              const suggestion = suggestionFor(cands);
              const chosen = record ? docById.get(record.billId) : chosenFor(line);
              const isBusy = Boolean(busy[key]);
              const needsAccount = !record && !line.bank_account_id;
              const canMatch = Boolean(chosen) && (!needsAccount || pickedAccount[key]);
              return (
                <tr key={record?.id || key} className={cn('border-b align-top last:border-0', record?.kind === 'match' && 'bg-emerald-50/50', record?.kind === 'dismissed' && 'opacity-60')}>
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{formatDate(line.date)}</td>
                  <td className="px-3 py-3">
                    {line.bank_account_name || (needsAccount ? (
                      <select
                        value={pickedAccount[key] || ''}
                        onChange={(e) => setPickedAccount((p) => ({ ...p, [key]: e.target.value }))}
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                      >
                        <option value="">Pick an account…</option>
                        {bankAccounts.map((a) => (
                          <option key={a.code} value={a.code}>{a.name}</option>
                        ))}
                      </select>
                    ) : '—')}
                  </td>
                  <td className="px-3 py-3">
                    <div>{line.description || line.reference || <span className="italic text-muted-foreground">No description</span>}</div>
                    {line.reference && line.reference !== line.description ? <div className="text-xs text-muted-foreground">{line.reference}</div> : null}
                    {line.contact ? <div className="text-xs text-muted-foreground">CYWorkspace read the payee as {line.contact}</div> : null}
                  </td>
                  <td className={cn('whitespace-nowrap px-3 py-3 text-right tabular-nums', !isMoneyOut(line) && 'text-emerald-700')}>{money(line.amount, line.currency)}</td>
                  <td className="px-3 py-3">
                    {record?.kind === 'match' ? (
                      chosen ? <DocRef doc={chosen} line={line} /> : <span className="text-muted-foreground">Document #{record.billId}</span>
                    ) : record?.kind === 'dismissed' ? (
                      <span className="text-xs italic text-muted-foreground">Ignored — not a cost</span>
                    ) : !isMoneyOut(line) ? (
                      <span className="text-xs italic text-muted-foreground">Money in — not a cost</span>
                    ) : cands.length === 0 ? (
                      <span className="text-xs italic text-muted-foreground">No document at this amount</span>
                    ) : (
                      <div className="space-y-1">
                        {suggestion && !picked[key] ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="firm">Suggested</Badge>
                            <DocRef doc={suggestion.doc} line={line} />
                          </div>
                        ) : null}
                        {cands.length > 1 || !suggestion ? (
                          <select
                            value={picked[key] || (suggestion ? suggestion.doc.id : '')}
                            onChange={(e) => setPicked((p) => ({ ...p, [key]: e.target.value }))}
                            className="h-8 max-w-full rounded-md border bg-background px-2 text-sm"
                          >
                            {!suggestion ? <option value="">Choose which document this pays…</option> : null}
                            {cands.map((c) => (
                              <option key={c.doc.id} value={c.doc.id}>
                                {c.confidence === 'firm' ? '★ ' : ''}{c.doc.supplier} · #{c.doc.displayId} · {formatDate(c.doc.date)}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </div>
                    )}
                    {errors[key] ? <p className="mt-1 text-xs text-destructive">{errors[key]}</p> : null}
                    {gone ? <p className="mt-1 text-xs text-muted-foreground">No longer listed by CYWorkspace — reconciled in Xero.</p> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right">
                    {record?.kind === 'match' ? (
                      <span className="inline-flex items-center gap-2">
                        <Badge tone="matched"><Check className="h-3 w-3" /> Matched</Badge>
                        {record.invoiceId ? (
                          <a href={`/costs/${encodeURIComponent(chosen?.displayId || record.billId)}`} title="Open the document" className="text-muted-foreground hover:text-foreground">
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : null}
                        <button type="button" onClick={() => undo(record)} disabled={isBusy} title="Undo — delete the payment in Xero" className="text-muted-foreground hover:text-foreground disabled:opacity-50">
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ) : record?.kind === 'dismissed' ? (
                      <button type="button" onClick={() => restore(record)} disabled={isBusy} className="inline-flex h-8 items-center rounded-md border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50">
                        Offer again
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        {isMoneyOut(line) ? (
                          <button
                            type="button"
                            onClick={() => match(line, chosen)}
                            disabled={!canMatch || isBusy}
                            title={!chosen ? 'Choose the document this line pays' : needsAccount && !pickedAccount[key] ? 'Pick the bank account' : 'Publish and record the payment'}
                            className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
                          >
                            {isBusy ? 'Matching…' : 'Match'}
                          </button>
                        ) : null}
                        <button type="button" onClick={() => dismiss(line)} disabled={isBusy} title="Not a cost — stop offering this line" className="inline-flex h-8 items-center rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50">
                          <EyeOff className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center text-sm text-muted-foreground">
                  {state.loading ? 'Asking CYWorkspace…' : state.error ? 'Nothing to show.' : openLines.length ? 'Nothing for this account.' : 'Nothing outstanding — every statement line CYWorkspace retrieved has been settled.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        A line is offered against a document only when the money agrees to the cent in the bank’s currency and the date sits in the window a payment lands in; a suggestion also names the supplier or the document number in the bank text. Ignore a line that is not a cost — a transfer, a fee, payroll — and it stops being offered.
      </p>
    </>
  );
}
