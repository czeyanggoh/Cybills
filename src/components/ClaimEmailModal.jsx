import { useState } from 'react';
import { X, ChevronDown, CheckCircle2, AlertTriangle, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useEmailStatus,
  sendClaimEmail,
  emailErrorMessage,
  buildClaimEmailText,
  copyText,
} from '@/lib/email';

function Field({ label, required = false, children }) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <span className="w-40 shrink-0 pt-2 text-muted-foreground">
        {label} {required && <span className="text-destructive">*</span>}
      </span>
      <div className="flex-1">{children}</div>
    </label>
  );
}

function Select({ value, onChange, options }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

// "Send by email" dialog. The message is sent by the server as VA01@cy-bm.sg
// via Microsoft Graph — this form only collects structured fields (recipient,
// note, detail level); the server reads the claim from its own store and
// renders the HTML body itself.
//
// When the mailer isn't configured, or Microsoft rejects the message, the
// dialog degrades to a Copy button so the user can paste the summary into
// Outlook rather than being stuck.
export default function ClaimEmailModal({ open, onClose, claim, defaultName = 'Astrid Yang' }) {
  const [name, setName] = useState(defaultName);
  const [toName, setToName] = useState('');
  const [toEmail, setToEmail] = useState('');
  const [message, setMessage] = useState('');
  const [detail, setDetail] = useState('summary');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const { enabled, missing, loaded } = useEmailStatus();

  if (!open) return null;

  const valid = toName.trim() && /.+@.+\..+/.test(toEmail);
  const close = () => {
    setSent(false);
    setError('');
    setCopied(false);
    onClose();
  };

  const copySummary = async () => {
    const ok = await copyText(
      buildClaimEmailText(claim, { detailLevel: detail, message, senderName: name })
    );
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  };

  const send = async () => {
    setSending(true);
    setError('');
    try {
      await sendClaimEmail(claim.id, {
        toName: toName.trim(),
        toEmail: toEmail.trim(),
        message,
        detailLevel: detail,
        senderName: name.trim(),
      });
      setSent(true);
    } catch (err) {
      setError(emailErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const input = 'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Send 1 item via email</h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {sent ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <CheckCircle2 className="h-10 w-10" strokeWidth={1.5} />
            <p className="text-sm font-medium">Email sent to {toName}</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Sent from VA01@cy-bm.sg. Replies come back to you.
            </p>
            <button type="button" onClick={close} className="mt-2 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-5 overflow-auto p-6">
              {loaded && !enabled && (
                <div className="flex gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                  <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-amber-600" strokeWidth={1.75} />
                  <div className="space-y-1">
                    <p className="font-medium">Email isn&rsquo;t set up on this server yet.</p>
                    <p className="text-muted-foreground">
                      Use <span className="font-medium">Copy summary</span> below and paste it into Outlook.
                      {missing.length > 0 && ` (Server still needs: ${missing.join(', ')}.)`}
                    </p>
                  </div>
                </div>
              )}
              {error && (
                <div className="flex gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                  <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-destructive" strokeWidth={1.75} />
                  <p>{error}</p>
                </div>
              )}
              <div className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email details</p>
                <Field label="Your first and last name" required>
                  <input value={name} onChange={(e) => setName(e.target.value)} className={input} />
                </Field>
                <Field label="Recipient name" required>
                  <input value={toName} onChange={(e) => setToName(e.target.value)} className={input} />
                </Field>
                <Field label="Recipient email" required>
                  <input value={toEmail} onChange={(e) => setToEmail(e.target.value)} type="email" className={input} />
                </Field>
                <Field label="Custom message">
                  <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                </Field>
              </div>
              <div className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Export options</p>
                <Field label="Detail level">
                  <Select value={detail} onChange={setDetail} options={[{ value: 'summary', label: 'Report summary' }, { value: 'items', label: 'Itemised line items' }]} />
                </Field>
                <p className="text-xs text-muted-foreground">
                  The email is sent from VA01@cy-bm.sg with the claim summary in the body and a
                  CSV of the selected detail attached. Replies come back to you.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 border-t px-6 py-4">
              <button
                type="button"
                onClick={copySummary}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy summary'}
              </button>
              <div className="flex items-center gap-2">
                <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!valid || sending || !enabled}
                  title={enabled ? undefined : 'Email is not configured on the server'}
                  onClick={send}
                  className={cn(
                    'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90',
                    (!valid || sending || !enabled) && 'opacity-50'
                  )}
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
