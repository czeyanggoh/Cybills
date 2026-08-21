import { useRef, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { ROLES } from '@/lib/userStore';
import { cn } from '@/lib/utils';

const blankRow = () => ({ firstName: '', lastName: '', email: '', mobile: '', role: 'Standard' });

// Parse a simple CSV (First name, Last name, Email, Mobile, Role). A header row
// containing "first" is skipped.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (const line of lines) {
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    if (rows.length === 0 && /first/i.test(cols[0] || '')) continue; // header
    const [firstName = '', lastName = '', email = '', mobile = '', role = 'Standard'] = cols;
    if (firstName || lastName || email) {
      rows.push({ firstName, lastName, email, mobile, role: ROLES.includes(role) ? role : 'Standard' });
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

  if (!open) return null;

  const setCell = (i, k, v) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, [k]: v } : row)));
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
    if (valid.length) onAdd(valid, notify);
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
              <p className="mt-2 rounded-md border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
                “You&rsquo;ve been invited to CYBills for Red Alpha Cybersecurity. Click the link in this email
                to set your password and get started.”
              </p>
            )}
          </div>

          {/* Editable grid */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">First name</th>
                  <th className="pb-2 pr-3 font-medium">Last name</th>
                  <th className="pb-2 pr-3 font-medium">Email</th>
                  <th className="pb-2 pr-3 font-medium">Mobile number</th>
                  <th className="pb-2 font-medium">Role</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-3"><input value={r.firstName} onChange={(e) => setCell(i, 'firstName', e.target.value)} className={cell} /></td>
                    <td className="py-1 pr-3"><input value={r.lastName} onChange={(e) => setCell(i, 'lastName', e.target.value)} className={cell} /></td>
                    <td className="py-1 pr-3"><input value={r.email} onChange={(e) => setCell(i, 'email', e.target.value)} type="email" className={cell} /></td>
                    <td className="py-1 pr-3"><input value={r.mobile} onChange={(e) => setCell(i, 'mobile', e.target.value)} className={cell} /></td>
                    <td className="py-1">
                      <div className="relative">
                        <select value={r.role} onChange={(e) => setCell(i, 'role', e.target.value)} className="h-9 w-full appearance-none rounded-md border bg-background px-2.5 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {ROLES.map((role) => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      </div>
                    </td>
                  </tr>
                ))}
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
