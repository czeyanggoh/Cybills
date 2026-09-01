import { useState } from 'react';
import { X, Mail, Copy, Check } from 'lucide-react';
import ConnectWhatsapp from '@/components/ConnectWhatsapp';

// The entity's GENERAL account — the row created with the organisation itself,
// which owns the paperwork nobody claimed.
//
// Deliberately NOT the Edit-details dialog a person gets. Nothing in that one
// applies here: it has no first and last name to correct, no login to grant, and
// no inbound handle to choose — its address is the entity's short form standing
// alone, which is set once in Business settings and belongs to the company
// rather than to this row. What is left is the two ways paperwork reaches it
// without anybody signing in, which is what this dialog is.
export default function GeneralAccountModal({ open, account, entityName, onClose }) {
  // The number is not saved from here, and there is no Save to press: connecting
  // stores it (see ConnectWhatsapp), which is the same rule a person's card
  // follows — the number IS the connection.
  const [mobile, setMobile] = useState(account?.mobile || '');
  const [copied, setCopied] = useState(false);

  if (!open || !account) return null;

  const who = entityName ? `${entityName}'s General account` : 'the General account';
  const copy = () => {
    if (!account.address) return;
    navigator.clipboard?.writeText(account.address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={onClose} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">General account</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-auto p-6">
          <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            Created with {entityName || 'the entity'} itself, and never a person. It owns the documents nobody
            claimed — anything a colleague adds without naming an owner belongs here. It can&rsquo;t sign in, be
            invited, or approve anything.
          </p>

          {/* Its address, which is the ENTITY's own rather than anybody's: the
              one to put on a supplier's file, or to point a shared mailbox at,
              where naming an employee is wrong the day they leave. Read-only —
              it is the short form, set once for the whole entity. */}
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Mail className="h-4 w-4" strokeWidth={1.75} /> Extract by email
            </div>
            {account.address ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Bills forwarded here belong to {entityName || 'the entity'} rather than to any one colleague, so
                  CYBills files them under this account.
                </p>
                <div className="flex items-center gap-2">
                  <div className="flex h-9 flex-1 items-center overflow-hidden rounded-md border bg-muted/30 px-3 text-sm">
                    {account.address}
                  </div>
                  <button
                    type="button"
                    onClick={copy}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                This address is the entity&rsquo;s short form standing alone, so there isn&rsquo;t one until a short
                form is set — Business settings → Extraction → Extract by Email.
              </p>
            )}
          </div>

          {/* The other road a bill travels, and the reason this dialog exists:
              every other entity's General account is reachable from its Users
              page, and the practice's own is reachable only from here. */}
          <ConnectWhatsapp
            user={account}
            mobile={mobile}
            setMobile={setMobile}
            owner={who}
            saveLabel="Connect"
            description={
              <>
                Opens a WhatsApp group for {who}. Everything sent into it is read and filed under this account,
                whoever sent it — a group for the entity&rsquo;s own paperwork rather than for one person&rsquo;s.
                The number is whoever should be in the group; connecting is what stores it.
              </>
            }
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button type="button" onClick={onClose} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
