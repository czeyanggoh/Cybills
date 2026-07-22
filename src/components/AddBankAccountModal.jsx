import { useRef, useState } from 'react';
import { X, ChevronDown, Info, UploadCloud } from 'lucide-react';
import {
  addBankAccount,
  addRequestedBank,
  getAllBanks,
  CURRENCY_OPTIONS,
} from '@/lib/bankAccounts';
import { cn } from '@/lib/utils';

// Two-node progress header ("Account type" → "Add bank account").
function Stepper({ step }) {
  const nodes = ['Account type', 'Add bank account'];
  return (
    <div className="flex items-center justify-center gap-0 px-6 pb-2 pt-4">
      {nodes.map((label, i) => (
        <div key={label} className="flex items-center">
          <div className="flex flex-col items-center">
            <span
              className={cn(
                'h-3.5 w-3.5 rounded-full',
                i <= step ? 'bg-foreground' : 'border-2 border-muted-foreground/40 bg-background'
              )}
            />
            <span className={cn('mt-1.5 text-xs', i === step ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              {label}
            </span>
          </div>
          {i === 0 && <span className={cn('mx-3 mb-5 h-0.5 w-28', step >= 1 ? 'bg-foreground' : 'bg-muted')} />}
        </div>
      ))}
    </div>
  );
}

function Select({ value, onChange, placeholder = 'Select', children }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-10 w-full appearance-none rounded-md border bg-background px-3 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
          !value && 'text-muted-foreground'
        )}
      >
        <option value="">{placeholder}</option>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

function LabelRow({ label, required = false, children }) {
  return (
    <label className="grid grid-cols-1 gap-1 sm:grid-cols-[140px_1fr] sm:items-start">
      <span className="pt-2.5 text-sm text-muted-foreground">
        {label} {required && <span className="text-destructive">*</span>}
      </span>
      <div>{children}</div>
    </label>
  );
}

// "Request to add your bank" — bank name + a sample statement upload.
function RequestBankModal({ open, onClose, onRequested }) {
  const [name, setName] = useState('');
  const [files, setFiles] = useState([]);
  const inputRef = useRef(null);
  if (!open) return null;

  const onPick = (list) => setFiles(Array.from(list || []).map((f) => f.name));
  const submit = () => {
    if (!name.trim()) return;
    addRequestedBank(name);
    onRequested?.(name.trim());
    setName('');
    setFiles([]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Request to add your bank</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <p className="text-sm text-muted-foreground">
            Enter the full name of your bank including the State and Country (if applicable) and
            upload a sample bank statement containing transactions.
          </p>
          <LabelRow label="Bank name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </LabelRow>

          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onPick(e.dataTransfer.files); }}
            className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed py-8 text-center transition-colors hover:bg-muted/40"
          >
            <UploadCloud className="mb-2 h-7 w-7 text-muted-foreground" strokeWidth={1.5} />
            <p className="text-sm font-medium">Drag &amp; drop files to upload</p>
            <p className="my-1 text-xs text-muted-foreground">or</p>
            <span className="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium">Select files</span>
            <p className="mt-3 text-xs text-muted-foreground">File limits &nbsp;|&nbsp; 50 MB of PDF or TIFF files</p>
            <input ref={inputRef} type="file" accept="application/pdf,image/tiff" multiple className="hidden" onChange={(e) => onPick(e.target.files)} />
          </div>
          {files.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {files.map((f) => <li key={f}>• {f}</li>)}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
          <button type="button" onClick={submit} disabled={!name.trim()} className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">Submit</button>
        </div>
      </div>
    </div>
  );
}

// "Add a bank account" — Dext's two-step wizard: choose how to add it, then the
// account details. Integrations are noted but only the manual path is wired.
export default function AddBankAccountModal({ open, onClose, onAdded }) {
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState('');
  const [bank, setBank] = useState('');
  const [name, setName] = useState('');
  const [reference, setReference] = useState('');
  const [currency, setCurrency] = useState('SGD');
  const [requestOpen, setRequestOpen] = useState(false);
  const [banks, setBanks] = useState(() => getAllBanks());
  if (!open) return null;

  const reset = () => {
    setStep(0); setMethod(''); setBank(''); setName(''); setReference(''); setCurrency('SGD');
  };
  const close = () => { reset(); onClose(); };
  const canFinish = bank && name.trim() && reference.trim() && currency;

  const finish = () => {
    const acct = addBankAccount({ bank, name, reference, currency });
    if (!acct) return;
    onAdded?.(acct);
    reset();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative w-full max-w-xl overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex h-14 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Add a bank account</h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <Stepper step={step} />

        {step === 0 ? (
          <div className="space-y-4 p-6">
            <p className="font-medium">How would you like to add this account?</p>
            <button
              type="button"
              onClick={() => setMethod('manual')}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border px-4 py-3.5 text-left text-sm transition-colors',
                method === 'manual' ? 'border-foreground bg-muted/40' : 'hover:bg-muted/40'
              )}
            >
              <span className={cn('flex h-4 w-4 items-center justify-center rounded-full border-2', method === 'manual' ? 'border-foreground' : 'border-muted-foreground/50')}>
                {method === 'manual' && <span className="h-2 w-2 rounded-full bg-foreground" />}
              </span>
              Manually
            </button>
            <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              Bank accounts from integrations are added and synced automatically.
            </p>
          </div>
        ) : (
          <div className="space-y-4 p-6">
            <p className="text-sm font-medium">
              Add your bank account so that you can store and organise your bank statements.
            </p>
            <LabelRow label="Bank" required>
              <Select value={bank} onChange={setBank}>
                {banks.map((b) => <option key={b} value={b}>{b}</option>)}
              </Select>
              <button type="button" onClick={() => setRequestOpen(true)} className="mt-1 text-xs font-medium text-emerald-600 hover:underline">
                Request your bank
              </button>
            </LabelRow>
            <LabelRow label="Account name" required>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Business checking" className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
            </LabelRow>
            <LabelRow label="Reference" required>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Last four digits" className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
            </LabelRow>
            <LabelRow label="Currency" required>
              <Select value={currency} onChange={setCurrency} placeholder="Select currency">
                {CURRENCY_OPTIONS.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
              </Select>
            </LabelRow>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          {step === 0 ? (
            <button type="button" onClick={() => method && setStep(1)} disabled={!method} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              Continue
            </button>
          ) : (
            <>
              <button type="button" onClick={close} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">Cancel</button>
              <button type="button" onClick={finish} disabled={!canFinish} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
                Continue
              </button>
            </>
          )}
        </div>
      </div>

      <RequestBankModal
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        onRequested={(reqName) => { setBanks(getAllBanks()); setBank(reqName); }}
      />
    </div>
  );
}
