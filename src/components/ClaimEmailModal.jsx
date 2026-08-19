import { useState } from 'react';
import { X, ChevronDown, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

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

// "Send by email" dialog. This is a UI mock — CYBills has no mail backend, so
// nothing is actually transmitted; on send we just confirm to the user.
export default function ClaimEmailModal({ open, onClose, defaultName = '' }) {
  const [name, setName] = useState(defaultName);
  const [toName, setToName] = useState('');
  const [toEmail, setToEmail] = useState('');
  const [message, setMessage] = useState('');
  const [detail, setDetail] = useState('summary');
  const [format, setFormat] = useState('dext');
  const [sent, setSent] = useState(false);

  if (!open) return null;

  const valid = toName.trim() && /.+@.+\..+/.test(toEmail);
  const close = () => {
    setSent(false);
    onClose();
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
            <p className="text-sm font-medium">Email queued to {toName}</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              This is a demo build — no message was actually sent.
            </p>
            <button type="button" onClick={close} className="mt-2 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-5 overflow-auto p-6">
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
                <Field label="CSV format">
                  <Select value={format} onChange={setFormat} options={[{ value: 'dext', label: 'CYBills default' }]} />
                </Field>
                <p className="text-xs text-muted-foreground">
                  We&rsquo;ll send an email with links to download a CSV and PDF of the selected items.
                  Those links will expire after 30 days.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
              <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
                Cancel
              </button>
              <button
                type="button"
                disabled={!valid}
                onClick={() => setSent(true)}
                className={cn(
                  'inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90',
                  !valid && 'opacity-50'
                )}
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
