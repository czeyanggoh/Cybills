import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronDown, Flag, FileText, Sparkles, CheckCircle2 } from 'lucide-react';
import AppShell from '@/components/AppShell';
import VaultSubnav from '@/components/VaultSubnav';
import ManageAccessModal from '@/components/ManageAccessModal';
import { useAuth } from '@/lib/auth';
import { useUsers } from '@/lib/userStore';
import {
  getVaultFileById,
  getVaultFiles,
  setVaultOverride,
  removeVaultFiles,
  moveVaultFiles,
  useVaultFolders,
  VAULT_CHANGED_EVENT,
} from '@/lib/vaultStore';
import { getVaultBlob } from '@/lib/vaultBlobs';
import { prepareUpload } from '@/lib/image';
import { getExtractionAccounts } from '@/lib/organisations';
import { displayItemId, sha256Hex, fetchExtract, addBill, notifyBillsChanged } from '@/lib/bills';
import { requestedProvider, useReaderName } from '@/lib/readerProvider';
import { cn } from '@/lib/utils';

function TopButton({ children, onClick = () => {}, subtle = false, danger = false, dropdown = false, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm transition-colors',
        subtle && 'border-transparent',
        danger && 'border-transparent text-destructive hover:bg-destructive/10',
        disabled ? 'cursor-not-allowed text-muted-foreground/50' : 'hover:bg-muted'
      )}
    >
      {children}
      {dropdown && <ChevronDown className="h-3.5 w-3.5" />}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[130px_1fr] sm:items-start">
      <div className="pt-2 text-sm text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}

function ReadonlyBox({ value }) {
  return <div className="min-h-10 rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">{value || '—'}</div>;
}
function TextField({ value, onChange, placeholder = '' }) {
  return (
    <input
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
function AreaField({ value, onChange, rows = 3 }) {
  return (
    <textarea
      value={value || ''}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Named after whichever reader the org picked, so "OpenAI declined" doesn't
// come back reading "Claude declined".
const extractErrors = (reader) => ({
  vision_not_configured: 'Auto-fill isn’t configured on the server yet.',
  invalid_image: 'That file type can’t be read — use a PDF or image.',
  refused: `${reader} declined to read that document.`,
  no_data: 'Couldn’t summarise that document.',
});

export default function VaultDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { visionEnabled } = useAuth();
  const readerName = useReaderName();
  const users = useUsers();
  const folders = useVaultFolders();
  const [file, setFile] = useState(() => getVaultFileById(id));
  const [tab, setTab] = useState('details');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewType, setPreviewType] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [aiError, setAiError] = useState('');
  const [copied, setCopied] = useState('');
  const [copying, setCopying] = useState(''); // 'cost' | 'sales' while a copy runs
  const [accessOpen, setAccessOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const summarisedRef = useRef('');

  // Keep the file in sync with store edits (overrides, moves, flag).
  useEffect(() => {
    const sync = () => setFile(getVaultFileById(id));
    sync();
    window.addEventListener(VAULT_CHANGED_EVENT, sync);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, sync);
  }, [id]);

  // Load the stored bytes for preview, and auto-fill Subject/Summary once.
  useEffect(() => {
    let live = true;
    let url = '';
    (async () => {
      const rec = await getVaultBlob(id);
      if (!live || !rec?.blob) return;
      const type = rec.type || rec.blob.type || '';
      url = URL.createObjectURL(rec.blob);
      setPreviewUrl(url);
      setPreviewType(type.includes('pdf') || /\.pdf$/i.test(rec.name || '') ? 'pdf' : type.startsWith('image/') ? 'image' : 'other');

      // Auto-fill Subject + Summary when Vision is on and not already filled.
      const current = getVaultFileById(id);
      if (visionEnabled && !current?.subject && summarisedRef.current !== id) {
        summarisedRef.current = id;
        const f = rec.blob.type ? rec.blob : new File([rec.blob], rec.name || 'document', { type });
        setExtracting(true);
        try {
          const { base64, mediaType } = await prepareUpload(f);
          const res = await fetch('/api/vault/summarize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64: base64, mediaType, provider: requestedProvider() }),
          });
          if (res.ok) {
            const { data } = await res.json();
            if (data && live) setVaultOverride(id, { subject: data.subject, summary: data.summary });
          } else {
            const body = await res.json().catch(() => ({}));
            if (live) setAiError(extractErrors(readerName)[body.error] || 'Auto-fill failed.');
          }
        } catch {
          if (live) setAiError('Could not read that file.');
        } finally {
          if (live) setExtracting(false);
        }
      }
    })();
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, visionEnabled]);

  if (!file) {
    return (
      <AppShell subnav={<VaultSubnav />}>
        <p className="text-sm text-muted-foreground">File not found.</p>
      </AppShell>
    );
  }

  const set = (patch) => setVaultOverride(id, patch);
  const all = getVaultFiles();
  const index = all.findIndex((f) => f.id === id);
  const go = (delta) => {
    const next = all[index + delta];
    if (next) navigate(`/vault/${next.id}`);
  };

  // Copy this document into the Costs or Sales inbox (auto-extracting when the
  // original bytes are available and Vision is on).
  const copyTo = async (kind) => {
    if (copying) return;
    setCopied('');
    setCopying(kind);
    try {
    const rec = await getVaultBlob(id);
    /** @type {any} */
    const payload = { fileName: file.name, kind };
    if (rec?.blob) {
      const type = rec.type || rec.blob.type || 'application/pdf';
      const f = rec.blob.type ? rec.blob : new File([rec.blob], file.name, { type });
      // Scope the dedup key by workspace so the same document can be copied to
      // both Costs and Sales (they're separate inboxes), while a repeat copy to
      // the same inbox is still caught as a duplicate.
      payload.fileHash = `${await sha256Hex(rec.blob)}:${kind}`;
      const { base64, mediaType } = await prepareUpload(f);
      payload.fileBase64 = base64;
      payload.mediaType = mediaType;
      if (visionEnabled) {
        try {
          const ex = await fetchExtract(base64, mediaType, await getExtractionAccounts());
          if (ex) Object.assign(payload, ex);
        } catch { /* best effort */ }
      }
    } else {
      payload.fileHash = `vault_${id}_${kind}`;
    }
      const result = await addBill(payload, { force: true });
      if (result?.ok || result?.bill) {
        notifyBillsChanged();
        setCopied(kind === 'sales' ? 'Copied to Sales inbox' : 'Copied to Costs inbox');
      } else {
        setCopied('Could not copy this file.');
      }
    } catch {
      setCopied('Could not copy this file.');
    } finally {
      setCopying('');
    }
  };

  const del = () => {
    if (window.confirm(`Delete ${file.name} from the Vault?`)) {
      removeVaultFiles([id]);
      navigate('/vault');
    }
  };

  const generalAccess = file.accessGeneral || 'Practice & Admin users only';
  const userAccess = file.userAccess || {};

  return (
    <AppShell subnav={<VaultSubnav />}>
      {/* Action bar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TopButton subtle onClick={() => navigate('/vault')}>
          <ChevronLeft className="h-4 w-4" /> Back
        </TopButton>
        <button
          type="button"
          onClick={() => set({ flagged: !file.flagged })}
          className="mx-1 flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          aria-label="Flag"
        >
          <Flag className={cn('h-4 w-4', file.flagged ? 'fill-foreground text-foreground' : 'text-muted-foreground')} />
        </button>
        <TopButton disabled={!!copying} onClick={() => copyTo('cost')}>
          {copying === 'cost' ? 'Copying…' : 'Copy to Costs'}
        </TopButton>
        <TopButton disabled={!!copying} onClick={() => copyTo('sales')}>
          {copying === 'sales' ? 'Copying…' : 'Copy to Sales'}
        </TopButton>
        <TopButton onClick={() => setAccessOpen(true)}>Manage access</TopButton>
        <TopButton danger onClick={del}>Delete</TopButton>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <button type="button" onClick={() => go(-1)} disabled={index <= 0} className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40">
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="tabular-nums text-muted-foreground">{index + 1} / {all.length}</span>
          <button type="button" onClick={() => go(1)} disabled={index >= all.length - 1} className="flex items-center gap-1 text-muted-foreground enabled:hover:text-foreground disabled:opacity-40">
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {copied && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> {copied}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left: document preview */}
        <div className="overflow-hidden rounded-lg border bg-muted/20">
          {previewUrl && previewType === 'pdf' ? (
            <iframe src={previewUrl} title={file.name} className="h-[640px] w-full" />
          ) : previewUrl && previewType === 'image' ? (
            <img src={previewUrl} alt={file.name} className="max-h-[640px] w-full object-contain" />
          ) : (
            <div className="flex h-[640px] flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
              <FileText className="h-10 w-10" strokeWidth={1.25} />
              <p className="text-sm font-medium">{file.name}</p>
              <p className="text-xs">No stored preview for this file.</p>
            </div>
          )}
        </div>

        {/* Right: details / history */}
        <div>
          <div className="mb-3 flex gap-6 border-b">
            {['details', 'history'].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  '-mb-px border-b-2 pb-3 pt-1 text-sm capitalize transition-colors',
                  tab === t ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'details' && (
            <div>
              {extracting && (
                <p className="mb-3 flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-xs text-foreground">
                  <Sparkles className="h-4 w-4" /> Reading document & filling in Subject and Summary…
                </p>
              )}
              {aiError && <p className="mb-3 rounded-md border px-3 py-2 text-xs text-muted-foreground">{aiError}</p>}

              <Field label="Folder">
                <div className="relative flex items-center gap-2">
                  <div className="flex h-10 flex-1 items-center gap-2 rounded-md border bg-muted px-3 text-sm text-muted-foreground">
                    <FileText className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{file.folder || 'CYBM Workspace'}</span>
                  </div>
                  <TopButton dropdown onClick={() => setFolderOpen((o) => !o)}>Change</TopButton>
                  {folderOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setFolderOpen(false)} aria-hidden="true" />
                      <div className="absolute right-0 top-11 z-20 w-48 overflow-hidden rounded-md border bg-background py-1 shadow-lg">
                        <button type="button" onClick={() => { moveVaultFiles([id], ''); setFolderOpen(false); }} className="flex w-full px-3 py-2 text-left text-sm hover:bg-muted">CYBM Workspace (root)</button>
                        {folders.map((f) => (
                          <button key={f} type="button" onClick={() => { moveVaultFiles([id], f); setFolderOpen(false); }} className="flex w-full px-3 py-2 text-left text-sm hover:bg-muted">📁 {f}</button>
                        ))}
                        {folders.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">No folders yet.</p>}
                      </div>
                    </>
                  )}
                </div>
              </Field>
              <Field label="File ID"><ReadonlyBox value={displayItemId(file.id)} /></Field>
              <Field label="File Name"><TextField value={file.name} onChange={(v) => set({ name: v })} /></Field>
              <Field label="Date added"><ReadonlyBox value={file.dateAdded} /></Field>
              <Field label="Submitted by"><ReadonlyBox value={file.creator} /></Field>
              <Field label="File size"><ReadonlyBox value={formatSize(file.size)} /></Field>
              <Field label="Subject"><AreaField value={file.subject} onChange={(v) => set({ subject: v })} rows={2} /></Field>
              <Field label="Summary"><AreaField value={file.summary} onChange={(v) => set({ summary: v })} rows={4} /></Field>
              <Field label="Due Date"><TextField value={file.dueDate} onChange={(v) => set({ dueDate: v })} placeholder="e.g. 05 Jan 2026" /></Field>
              <Field label="Note"><AreaField value={file.note} onChange={(v) => set({ note: v })} rows={2} /></Field>
              <Field label="Tags"><TextField value={file.tags} onChange={(v) => set({ tags: v })} placeholder="Comma-separated tags" /></Field>
            </div>
          )}

          {tab === 'history' && (
            <ul className="space-y-5 pt-1">
              <li className="flex gap-3">
                <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
                <div>
                  <p className="text-sm">This file was uploaded to the Vault <span className="text-muted-foreground">by {file.creator}</span></p>
                  <p className="text-xs text-muted-foreground">{file.dateAdded}</p>
                </div>
              </li>
              {file.subject && (
                <li className="flex gap-3">
                  <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-foreground" />
                  <div>
                    <p className="text-sm">Subject &amp; summary generated <span className="text-muted-foreground">by CYBills</span></p>
                    <p className="text-xs text-muted-foreground">{file.dateAdded}</p>
                  </div>
                </li>
              )}
              <li className="flex gap-3">
                <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-foreground" />
                <div>
                  <p className="text-sm">Viewed <span className="text-muted-foreground">by Astrid Yang</span></p>
                  <p className="text-xs text-muted-foreground">{file.dateAdded}</p>
                </div>
              </li>
            </ul>
          )}
        </div>
      </div>

      <ManageAccessModal
        open={accessOpen}
        fileName={file.name}
        generalAccess={generalAccess}
        userAccess={userAccess}
        users={users}
        onClose={() => setAccessOpen(false)}
        onGeneral={(v) => set({ accessGeneral: v, access: v.replace(' only', '') })}
        onUser={(uid, v) => set({ userAccess: { ...userAccess, [uid]: v } })}
      />
    </AppShell>
  );
}
