import { useRef, useState } from 'react';
import { X, Copy, FileText, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import {
  sha256Hex,
  fetchExtract,
  addBill,
  notifyBillsChanged,
  describeDuplicate,
  VISION_MEDIA,
} from '@/lib/bills';
import { prepareUpload } from '@/lib/image';

// Slide-over "Add documents" panel mirroring Dext's, rendered black & white.
// Costs/Sales tabs are wired to the real upload pipeline: hash → (Vision
// extract) → duplicate check → persist. The other tabs remain UI-only.
const TABS = ['Costs', 'Sales', 'Bank', 'Supplier statements', 'Vault'];

const MODES = [
  { key: 'file', title: 'One document per file', hint: 'PDF, JPG, PNG, ZIP' },
  { key: 'page', title: 'One document per page', hint: 'PDF files only' },
  { key: 'split', title: 'Auto-splitting', hint: 'PDF files only (up to 1 hour)' },
];

let uid = 0;

function Dropzone({ hint = '6MB for images and PDFs, 100MB for ZIPs', onFiles }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const take = (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length) onFiles(files);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        take(e.dataTransfer.files);
      }}
      className={cn(
        'rounded-lg border-2 border-dashed p-8 text-center transition-colors',
        dragging ? 'border-foreground bg-muted' : 'border-border'
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
        className="hidden"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = '';
        }}
      />
      <p className="text-sm font-medium">Drag &amp; drop files to upload</p>
      <p className="my-2 text-xs text-muted-foreground">or</p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
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

// One row per uploaded file, reflecting its place in the pipeline.
function UploadItem({ item, onForce, onSkip }) {
  const { status, file, error, duplicate } = item;
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-3">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
        {status === 'extracting' && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading…
          </span>
        )}
        {status === 'uploading' && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
          </span>
        )}
        {status === 'added' && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <CheckCircle2 className="h-3.5 w-3.5" /> Added
          </span>
        )}
        {status === 'skipped' && <span className="text-xs text-muted-foreground">Skipped</span>}
        {status === 'error' && (
          <span className="flex items-center gap-1.5 text-xs text-foreground">
            <AlertTriangle className="h-3.5 w-3.5" /> {error || 'Failed'}
          </span>
        )}
      </div>

      {status === 'duplicate' && (
        <div className="mt-2 rounded-md border border-foreground/30 bg-muted px-3 py-2">
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-medium">Possible duplicate. </span>
              {describeDuplicate(duplicate)}
            </span>
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onForce(item.id)}
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Add anyway
            </button>
            <button
              type="button"
              onClick={() => onSkip(item.id)}
              className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-background"
            >
              Skip
            </button>
          </div>
        </div>
      )}
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
  const { visionEnabled } = useAuth();
  const [tab, setTab] = useState('Costs');
  const [mode, setMode] = useState('file');
  const [items, setItems] = useState([]);

  if (!open) return null;

  const isUpload = tab === 'Costs' || tab === 'Sales';

  const patch = (id, next) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...next } : it)));

  // Per file: hash → optional Vision extract → duplicate check → persist. The
  // extracted fields are kept on the item so "Add anyway" can reuse them without
  // re-running extraction.
  const onFiles = (files) => {
    const created = files.map((file) => ({ id: ++uid, file, status: 'pending', fields: {} }));
    setItems((prev) => [...created, ...prev]);

    created.forEach((it) => {
      void (async () => {
        try {
          // Dedup on the ORIGINAL file bytes; store a downscaled copy so large
          // photos stay under the server body limit.
          const fileHash = await sha256Hex(it.file);
          const { base64: fileBase64, mediaType } = await prepareUpload(it.file);
          let fields = {};
          if (visionEnabled && VISION_MEDIA.includes(mediaType)) {
            patch(it.id, { status: 'extracting' });
            try {
              const ex = await fetchExtract(fileBase64, mediaType);
              if (ex) fields = ex;
            } catch {
              // Extraction is best-effort — still store + dedup-check the file.
            }
          }

          const payload = {
            fileHash,
            fileName: it.file.name,
            fileBase64,
            mediaType,
            ...fields,
          };
          patch(it.id, { status: 'uploading', payload });
          const result = await addBill(payload);
          if (result.duplicate) {
            patch(it.id, { status: 'duplicate', duplicate: result.duplicate });
          } else {
            patch(it.id, { status: 'added', bill: result.bill });
            notifyBillsChanged();
          }
        } catch {
          patch(it.id, { status: 'error', error: 'Upload failed' });
        }
      })();
    });
  };

  const onForce = async (id) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    patch(id, { status: 'uploading' });
    try {
      // Reuse the payload built on the first attempt (hash, bytes, fields) so
      // "Add anyway" doesn't re-hash or re-extract.
      const payload = it.payload ?? (await (async () => {
        const { base64, mediaType } = await prepareUpload(it.file);
        return { fileHash: await sha256Hex(it.file), fileName: it.file.name, fileBase64: base64, mediaType };
      })());
      const result = await addBill(payload, { force: true });
      patch(id, { status: 'added', bill: result.bill });
      notifyBillsChanged();
    } catch {
      patch(id, { status: 'error', error: 'Upload failed' });
    }
  };

  const onSkip = (id) => patch(id, { status: 'skipped' });

  const close = () => {
    setItems([]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col bg-background shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <h2 className="text-base font-semibold tracking-tight">Add documents</h2>
          <button
            type="button"
            onClick={close}
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

            {tab === 'Vault' && (
              <div className="mb-4 flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">Upload destination</span>
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">📁 Red Alpha Cybersecurity</span>
                  <button
                    type="button"
                    className="rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted"
                  >
                    Change
                  </button>
                </div>
              </div>
            )}

            {isUpload ? (
              <Dropzone onFiles={onFiles} />
            ) : (
              <Dropzone
                onFiles={() => {}}
                hint={
                  tab === 'Bank'
                    ? '50MB, minimum 200dpi scans'
                    : tab === 'Supplier statements'
                      ? '6MB for images, 40MB for PDFs'
                      : '100MB max per file'
                }
              />
            )}

            {isUpload && !visionEnabled && (
              <p className="mt-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                Field extraction is off (no <span className="font-mono">ANTHROPIC_API_KEY</span>). Files
                are still stored and checked for exact-file duplicates.
              </p>
            )}

            {isUpload && items.length > 0 && (
              <div className="mt-4 space-y-2">
                {items.map((it) => (
                  <UploadItem key={it.id} item={it} onForce={onForce} onSkip={onSkip} />
                ))}
              </div>
            )}
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

          {tab === 'Vault' && (
            <div className="space-y-4">
              <div>
                <h3 className="mb-1 text-sm font-medium">Vault storage usage</h3>
                <p className="mb-2 text-xs text-muted-foreground">Used 1 MB of 500 MB</p>
                <div className="h-1.5 w-full rounded-full bg-muted">
                  <div className="h-full w-[1%] rounded-full bg-foreground" />
                </div>
              </div>
              <div>
                <h3 className="mb-1 text-sm font-medium">Vault AI credits usage</h3>
                <p className="text-xs text-muted-foreground">Used 0 of 5 credits</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
