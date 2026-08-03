import { useRef, useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { X, FileText, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import {
  sha256Hex,
  fetchExtract,
  addBill,
  updateBill,
  finalizeBill,
  notifyBillsChanged,
  describeDuplicate,
  VISION_MEDIA,
} from '@/lib/bills';
import { prepareUpload } from '@/lib/image';
import { getExtractionAccounts } from '@/lib/organisations';
import { getCustomerRule } from '@/lib/customerRules';
import { addVaultFiles } from '@/lib/vaultStore';
import { useUsers } from '@/lib/userStore';

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

// After an upload is saved it sits in "Processing" (fields being read); a moment
// later it auto-advances into the inbox — Dext-style, for both Costs and Sales.
// Module-scoped so the timer still fires if the drawer is closed meanwhile.
function scheduleMoveToInbox(bill) {
  if (!bill?.id) return;
  window.setTimeout(() => {
    updateBill(bill.id, { status: 'new' })
      .then(() => notifyBillsChanged())
      .catch(() => {});
  }, 1500);
}

function Dropzone({ hint = '6MB for images and PDFs, 100MB for ZIPs', onFiles, accept = 'image/png,image/jpeg,image/webp,image/gif,application/pdf' }) {
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
        accept={accept || undefined}
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
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Receiving…
          </span>
        )}
        {status === 'added' && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <CheckCircle2 className="h-3.5 w-3.5" /> Added
          </span>
        )}
        {status === 'skipped' && <span className="text-xs text-muted-foreground">Skipped</span>}
        {status === 'rejected' && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" /> Rejected
          </span>
        )}
        {status === 'error' && (
          <span className="flex items-center gap-1.5 text-xs text-foreground">
            <AlertTriangle className="h-3.5 w-3.5" /> {error || 'Failed'}
          </span>
        )}
      </div>

      {(status === 'uploading' || status === 'extracting') && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
          <span>Received — it’s in Processing while Claude reads it, and moves to your inbox when done.</span>
        </p>
      )}

      {status === 'rejected' && (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>This exact file already exists in this account. Add it anyway to put a fresh copy in the inbox, or skip it.</span>
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

// Which drawer tab matches the workspace the user opened the drawer from.
const TAB_FOR_PATH = { '/sales': 'Sales', '/customers': 'Sales', '/bank': 'Bank', '/vault': 'Vault' };
function tabForPath(pathname) {
  if (pathname.startsWith('/supplier-statements')) return 'Supplier statements';
  const key = Object.keys(TAB_FOR_PATH).find((p) => pathname.startsWith(p));
  return key ? TAB_FOR_PATH[key] : 'Costs';
}

export default function AddDocumentsDrawer({ open, onClose }) {
  const { visionEnabled, user } = useAuth();
  const { pathname } = useLocation();
  const users = useUsers();
  const [tab, setTab] = useState('Costs');
  const [mode, setMode] = useState('file');
  const [items, setItems] = useState([]);
  const [vaultItems, setVaultItems] = useState([]);
  // Who the uploaded documents are attributed to — a real dropdown now (it used
  // to be a dead label). Defaults to the signed-in user.
  const [owner, setOwner] = useState('');
  useEffect(() => {
    if (!owner && user?.email) setOwner(user.email);
  }, [owner, user]);

  // Default the tab to the workspace the drawer was opened from (Sales page →
  // Sales tab, etc.) each time it opens.
  useEffect(() => {
    if (open) setTab(tabForPath(pathname));
  }, [open, pathname]);

  if (!open) return null;

  // Vault stores any file (metadata) client-side — no OCR / dedup, just save it
  // so it shows in the Vault list.
  const onVaultFiles = (files) => {
    const added = addVaultFiles(files);
    setVaultItems((prev) => [...added.map((f) => ({ id: f.id, name: f.name })), ...prev]);
  };

  const isUpload = tab === 'Costs' || tab === 'Sales';

  const patch = (id, next) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...next } : it)));

  // Per file: hash → optional Vision extract → duplicate check → persist. The
  // extracted fields are kept on the item so "Add anyway" can reuse them without
  // re-running extraction.
  const onFiles = (files) => {
    const created = files.map((file) => ({ id: ++uid, file, status: 'pending', fields: {} }));
    setItems((prev) => [...created, ...prev]);

    // Resolve the categorisation chart once for the whole batch (live Xero
    // accounts when connected, else the bundled standard chart).
    const accountsPromise = getExtractionAccounts();

    created.forEach((it) => {
      void (async () => {
        try {
          // Dedup on the ORIGINAL file bytes; store a downscaled copy so large
          // photos stay under the server body limit.
          const fileHash = await sha256Hex(it.file);
          const { base64: fileBase64, mediaType } = await prepareUpload(it.file);

          // 1) Accept the document immediately — create it in "Processing" before
          //    reading, so it lands on the Processing page right away (received).
          //    Claude Vision then reads it in the background (boss's request).
          /** @type {any} */
          const payload = {
            fileHash,
            fileName: it.file.name,
            fileBase64,
            mediaType,
            kind: tab === 'Sales' ? 'sales' : 'cost',
            status: 'processing',
            ...(owner ? { owner } : {}),
          };
          patch(it.id, { status: 'uploading', payload });
          const result = await addBill(payload);
          if (result.rejected) {
            // Byte-identical file already in the account — hard reject, no override.
            patch(it.id, { status: 'rejected', duplicate: result.duplicate });
            return;
          }
          if (result.duplicate) {
            patch(it.id, { status: 'duplicate', duplicate: result.duplicate });
            return;
          }
          const bill = result.bill;
          notifyBillsChanged(); // now visible on the Processing page

          // 2) Read with Claude Vision in the background, fill the fields, then
          //    re-check for a duplicate now that supplier/amount/date are known
          //    (the create-time check only had the file hash). A duplicate row
          //    is removed and offered as "Add anyway / Skip".
          if (visionEnabled && VISION_MEDIA.includes(mediaType)) {
            patch(it.id, { status: 'extracting', bill });
            try {
              const ex = await fetchExtract(fileBase64, mediaType, await accountsPromise);
              if (ex) {
                /** @type {any} */
                const fieldPatch = { ...ex };
                if (tab === 'Sales') {
                  const rule = getCustomerRule(ex.supplier);
                  if (rule) {
                    if (rule.currency) fieldPatch.currency = rule.currency;
                    if (rule.category) fieldPatch.category = rule.category;
                  }
                }
                const fin = await finalizeBill(bill.id, fieldPatch);
                if (fin?.duplicate) {
                  await updateBill(bill.id, { status: 'deleted' }).catch(() => {});
                  notifyBillsChanged();
                  patch(it.id, { status: 'duplicate', duplicate: fin.duplicate });
                  return;
                }
                notifyBillsChanged();
              }
            } catch {
              // Extraction is best-effort — the document is already saved.
            }
          }
          patch(it.id, { status: 'added', bill });
          scheduleMoveToInbox(bill);
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
      if (result.rejected) {
        patch(id, { status: 'rejected', duplicate: result.duplicate });
        return;
      }
      const bill = result.bill;
      notifyBillsChanged(); // in Processing
      // Read in the background, then advance (same as a fresh upload).
      if (visionEnabled && payload.fileBase64 && VISION_MEDIA.includes(payload.mediaType)) {
        patch(id, { status: 'extracting', bill });
        try {
          const ex = await fetchExtract(payload.fileBase64, payload.mediaType, await getExtractionAccounts());
          if (ex) {
            await updateBill(bill.id, { ...ex }).catch(() => {});
            notifyBillsChanged();
          }
        } catch {
          // best-effort
        }
      }
      patch(id, { status: 'added', bill });
      scheduleMoveToInbox(bill);
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
                  <div className="relative flex-1">
                    <select
                      value={owner}
                      onChange={(e) => setOwner(e.target.value)}
                      className="h-9 w-full appearance-none rounded-md border bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {!users.some((u) => u.email === owner) && owner && (
                        <option value={owner}>{user?.name || user?.email || owner}</option>
                      )}
                      {users.map((u) => (
                        <option key={u.id} value={u.email}>{u.name || u.email}</option>
                      ))}
                    </select>
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">▾</span>
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
            ) : tab === 'Vault' ? (
              // Vault accepts any file type (store anything for safekeeping).
              <Dropzone onFiles={onVaultFiles} accept="" hint="100MB max per file" />
            ) : (
              <Dropzone
                onFiles={() => {}}
                hint={
                  tab === 'Bank'
                    ? '50MB, minimum 200dpi scans'
                    : '6MB for images, 40MB for PDFs'
                }
              />
            )}

            {tab === 'Vault' && vaultItems.length > 0 && (
              <div className="mt-4 space-y-2">
                {vaultItems.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 rounded-md border p-3">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{it.name}</span>
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Added to Vault
                    </span>
                  </div>
                ))}
              </div>
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
