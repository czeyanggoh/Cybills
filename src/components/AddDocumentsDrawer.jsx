import { useState } from 'react';
import { X, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

// Slide-over "Add documents" panel mirroring Dext's, rendered black & white.
// Upload is a stub (no backend wiring yet) — the dropzone and options are UI.
const TABS = ['Costs', 'Sales', 'Bank', 'Supplier statements', 'Vault'];

const MODES = [
  { key: 'file', title: 'One document per file', hint: 'PDF, JPG, PNG, ZIP' },
  { key: 'page', title: 'One document per page', hint: 'PDF files only' },
  { key: 'split', title: 'Auto-splitting', hint: 'PDF files only (up to 1 hour)' },
];

function Dropzone({ hint = '6MB for images and PDFs, 100MB for ZIPs' }) {
  return (
    <div className="rounded-lg border-2 border-dashed border-border p-8 text-center">
      <p className="text-sm font-medium">Drag &amp; drop files to upload</p>
      <p className="my-2 text-xs text-muted-foreground">or</p>
      <button
        type="button"
        className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
      >
        Select files
      </button>
      <p className="mt-4 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">File limits</span> · {hint}
      </p>
    </div>
  );
}

function EmailRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 font-mono text-foreground">
        <span className="truncate">{value}</span>
        <Copy className="h-3.5 w-3.5 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground" />
      </span>
    </div>
  );
}

export default function AddDocumentsDrawer({ open, onClose }) {
  const [tab, setTab] = useState('Costs');
  const [mode, setMode] = useState('file');

  if (!open) return null;

  const isUpload = tab === 'Costs' || tab === 'Sales';

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Add documents</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex shrink-0 gap-5 border-b px-6">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                '-mb-px border-b-2 py-3 text-sm transition-colors',
                tab === t
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-6 overflow-auto p-6">
          <p className="text-sm text-muted-foreground">
            {tab === 'Costs' && 'Use this panel to add your bills, receipts and purchase invoices.'}
            {tab === 'Sales' && 'Use this panel to add your sales invoices.'}
            {tab === 'Bank' && 'Use this panel to add your bank statements.'}
            {tab === 'Supplier statements' &&
              'Use this panel to upload your supplier statements. PDF, JPG and PNG, one document per file.'}
            {tab === 'Vault' && 'Store any document for safekeeping — accessible for 10 years.'}
          </p>

          <div>
            <h3 className="mb-3 text-sm font-medium">Upload from computer</h3>

            {isUpload && (
              <>
                <label className="mb-4 flex items-center gap-3 text-sm">
                  <span className="w-32 text-muted-foreground">Document owner</span>
                  <div className="flex h-9 flex-1 items-center justify-between rounded-md border px-3 text-sm">
                    Astrid Yang
                    <span className="text-muted-foreground">▾</span>
                  </div>
                </label>
                <div className="mb-4 grid grid-cols-3 gap-2">
                  {MODES.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setMode(m.key)}
                      className={cn(
                        'rounded-md border p-3 text-left transition-colors',
                        mode === m.key ? 'border-foreground bg-muted' : 'hover:bg-muted'
                      )}
                    >
                      <span className="flex items-center gap-2 text-xs font-medium">
                        <span
                          className={cn(
                            'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                            mode === m.key ? 'border-foreground' : 'border-muted-foreground'
                          )}
                        >
                          {mode === m.key && <span className="h-1.5 w-1.5 rounded-full bg-foreground" />}
                        </span>
                        {m.title}
                      </span>
                      <span className="mt-1 block text-[11px] text-muted-foreground">{m.hint}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {tab === 'Bank' && (
              <label className="mb-4 flex items-center gap-3 text-sm">
                <span className="w-32 text-muted-foreground">Bank account</span>
                <div className="flex h-9 flex-1 items-center justify-between rounded-md border px-3 text-sm text-muted-foreground">
                  Select an account
                  <span>▾</span>
                </div>
              </label>
            )}

            <Dropzone
              hint={
                tab === 'Bank'
                  ? '50MB, minimum 200dpi scans'
                  : tab === 'Supplier statements'
                    ? '6MB for images, 40MB for PDFs'
                    : '6MB for images and PDFs, 100MB for ZIPs'
              }
            />
          </div>

          {isUpload && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Extract by Email</h3>
              <p className="mb-3 text-xs text-muted-foreground">
                Send digital documents to your dedicated extraction email address.
              </p>
              <div className="space-y-2 rounded-md border p-3">
                <EmailRow label="One document per file" value="astrid.yang.cybm@dext.cc" />
                <EmailRow label="One document per page" value="astrid.yang.cybm@multiple.dext.cc" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
