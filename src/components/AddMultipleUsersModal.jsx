import { useRef, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { ROLES } from '@/lib/userStore';
import { useOrganisations, getActiveOrganisationId } from '@/lib/organisations';
import { cn } from '@/lib/utils';

const blankPriv = () => ({ accessAll: false, createClaims: false, canPublish: false });
const blankRow = () => ({ firstName: '', lastName: '', email: '', mobile: '', role: 'Standard', privileges: blankPriv() });

// Parse a simple CSV (First name, Last name, Email, Mobile, Role). A header row
// containing "first" is skipped. Privileges aren't in the CSV — they default off
// and are set per row in the grid, same as the single "Add a user" dialog.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (const line of lines) {
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (rows.length === 0 && /first/i.test(cols[0] || '')) continue; // header
    const [firstName = '', lastName = '', email = '', mobile = '', role = 'Standard'] = cols;
    if (firstName || lastName || email) {
      rows.push({ firstName, lastName, email, mobile, role: ROLES.includes(role) ? role : 'Standard', privileges: blankPriv() });
    }
  }
  return rows;
}

function downloadTemplate() {
  const csv = 'First name,Last name,Email,Mobile number,Role\nJane,Doe,jane.doe@example.com,,Standard\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cybills-users-template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// "Add multiple users" dialog — CSV upload and/or an editable grid of rows.
export default function AddMultipleUsersModal({ open, onClose, onAdd }) {
  const fileRef = useRef(null);
  const [rows, setRows] = useState([blankRow()]);
  const [notify, setNotify] = useState(true);
  const [showEmail, setShowEmail] = useState(false);
  // The invite message is editable (different orgs word it differently) and
  // defaults to the ACTIVE organisation's name — not a hardcoded one.
  const { data: organisations = [] } = useOrganisations();
  const activeOrg = organisations.find((o) => o.id === getActiveOrganisationId()) || organisations[0];
  const orgName = activeOrg?.name || 'CYBills';
  const defaultMessage = `You've been invited to CYBills for ${orgName}. Click the link in this email to set your password and get started.`;
  const [message, setMessage] = useState(null);
  const effectiveMessage = message ?? defaultMessage;

  if (!open) return null;

  const setCell = (i, k, v) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, [k]: v } : row)));
  const setPriv = (i, k, v) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, privileges: { ...(row.privileges || {}), [k]: v } } : row)));
  const addRow = () => setRows((r) => [...r, blankRow()]);
  const close = () => {
    setRows([blankRow()]);
    onClose();
  };
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.length) setRows(parsed);
  };
  const commit = () => {
    const valid = rows.filter((r) => r.firstName.trim() || r.lastName.trim() || r.email.trim());
    // `notify` controls whether new users are emailed an invite — it is NOT the
    // login-access flag (that defaults to Yes on the server).
    if (valid.length) onAdd(valid, notify, effectiveMessage, orgName);
    close();
  };

  const cell = 'h-9 w-full rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-foreground/20" onClick={close} aria-hidden="true" />
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-base font-semibold tracking-tight">Add multiple users</h2>
          <button type="button" onClick={close} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-auto p-6">
          <div className="text-center text-sm">
            <p className="text-muted-foreground">
              You can add multiple users by uploading a CSV file. Please follow our{' '}
              <button type="button" onClick={downloadTemplate} className="font-medium text-foreground underline underline-offset-2">
                CSV file template
              </button>
              .
            </p>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="mt-3 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
            >
              Select file
            </button>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">Notify by email</span>
            <button type="button" onClick={() => setNotify((n) => !n)} className="flex items-center gap-2">
              <span className={cn('flex h-5 w-9 items-center rounded-full p-0.5 transition-colors', notify ? 'bg-foreground' : 'border')}>
                <span className={cn('h-4 w-4 rounded-full transition-transform', notify ? 'translate-x-4 bg-background' : 'bg-muted-foreground/50')} />
              </span>
              <span className="text-muted-foreground">{notify ? 'Yes' : 'No'}</span>
            </button>
          </div>
          <div>
            <button type="button" onClick={() => setShowEmail((s) => !s)} className="flex items-center gap-1 text-sm font-medium text-foreground">
              View email <ChevronDown className={cn('h-4 w-4 transition-transform', showEmail && 'rotate-180')} />
            </button>
            {showEmail && (
              <textarea
                rows={3}
                value={effectiveMessage}
                onChange={(e) => setMessage(e.target.value)}
                className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
          </div>

          {/* Editable grid */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">First name</th>
                  <th className="pb-2 pr-3 font-medium">Last name</th>
                  <th className="pb-2 pr-3 font-medium">Email</th>
                  <th className="pb-2 pr-3 font-medium">Mobile number</th>
                  <th className="pb-2 pr-3 font-medium">Role</th>
                  <th className="pb-2 pr-3 text-center font-medium" title="Access all documents in the account, not just their own">Access&nbsp;all</th>
                  <th className="pb-2 pr-3 text-center font-medium" title="Create expense claims">Create&nbsp;claims</th>
                  <th className="pb-2 text-center font-medium" title="Publish items and expense claims to accounting software">Can&nbsp;publish</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  // Privileges only apply to Standard users — admin roles already
                  // have full access, so the toggles are disabled (and shown on)
                  // for them, mirroring the single "Add a user" dialog.
                  const isStandard = r.role === 'Standard';
                  const priv = r.privileges || {};
                  const check = (k) => (
                    <input
                      type="checkbox"
                      checked={isStandard ? Boolean(priv[k]) : true}
                      disabled={!isStandard}
                      onChange={(e) => setPriv(i, k, e.target.checked)}
                      className="h-4 w-4 accent-black disabled:opacity-40"
                    />
                  );
                  return (
                    <tr key={i}>
                      <td className="py-1 pr-3"><input value={r.firstName} onChange={(e) => setCell(i, 'firstName', e.target.value)} className={cell} /></td>
                      <td className="py-1 pr-3"><input value={r.lastName} onChange={(e) => setCell(i, 'lastName', e.target.value)} className={cell} /></td>
                      <td className="py-1 pr-3"><input value={r.email} onChange={(e) => setCell(i, 'email', e.target.value)} type="email" className={cell} /></td>
                      <td className="py-1 pr-3"><input value={r.mobile} onChange={(e) => setCell(i, 'mobile', e.target.value)} className={cell} /></td>
                      <td className="py-1 pr-3">
                        <div className="relative">
                          <select value={r.role} onChange={(e) => setCell(i, 'role', e.target.value)} className="h-9 w-full appearance-none rounded-md border bg-background px-2.5 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            {ROLES.map((role) => (
                              <option key={role} value={role}>{role}</option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        </div>
                      </td>
                      <td className="py-1 pr-3 text-center">{check('accessAll')}</td>
                      <td className="py-1 pr-3 text-center">{check('createClaims')}</td>
                      <td className="py-1 text-center">{check('canPublish')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <button type="button" onClick={addRow} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted">
            + Add another user
          </button>
        </div>

        <div className="flex items-center justify-end border-t px-6 py-4">
          <button type="button" onClick={commit} className="inline-flex h-9 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90">
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
