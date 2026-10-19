import { useRef, useState } from 'react';
import { X, ChevronDown, Download, Upload, AlertTriangle } from 'lucide-react';
import { rolesFor, roleTier } from '@/lib/userStore';
import { useOrganisations, getActiveOrganisationId, isStandaloneOrg } from '@/lib/organisations';
import { cn } from '@/lib/utils';
import { mobileError } from '@/lib/mobile';

const blankPriv = () => ({ accessAll: false, createClaims: false, canPublish: false });
const blankRow = () => ({ firstName: '', lastName: '', email: '', mobile: '', role: 'Standard', privileges: blankPriv() });
const isFilled = (r) => r.firstName.trim() || r.lastName.trim() || r.email.trim();

// "Add multiple users" dialog — the roster workbook and/or an editable grid of
// rows. The workbook is the one Export to Excel writes, so there is one file
// format for the roster, not two: new people typed into it land in the grid
// below (where the invitation is still chosen here), and changes to people
// already on the roster go to the import preview (`onReview`) like any import.
// `onExport()` downloads it; `onImport(file)` resolves with planRosterImport's
// answer for it, asked with `adding`, or throws when it is not a workbook.
export default function AddMultipleUsersModal({ open, onClose, onAdd, onExport, onImport, onReview }) {
  const fileRef = useRef(null);
  const [rows, setRows] = useState([blankRow()]);
  const [imported, setImported] = useState(null); // { fileName, plan } | { fileName, failed: true }
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
    setImported(null);
    onClose();
  };
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let plan;
    try {
      plan = await onImport(file);
    } catch {
      setImported({ fileName: file.name, failed: true });
      return;
    }
    setImported({ fileName: file.name, plan });
    // New people join whatever has already been typed; the grid's blank
    // padding rows make way for them.
    const added = plan.additions.map(({ row: _row, ...p }) => ({ ...blankRow(), ...p }));
    if (added.length) setRows((r) => [...r.filter(isFilled), ...added]);
  };
  // A row somebody actually filled in. Blank rows are the grid's own padding.
  const filled = rows.filter(isFilled);
  // A blank mobile is fine — the number can be filled in later. A number that
  // has been TYPED has to be usable, or the bills that person sends in over
  // WhatsApp won't find them. Named per row rather than refused as a batch:
  // with twenty rows on screen, "some are invalid" is not a fix anybody can act
  // on.
  const badMobiles = filled
    .map((r, i) => ({ row: rows.indexOf(r) + 1, msg: mobileError(r.mobile) }))
    .filter((x) => x.msg);

  const commit = () => {
    // `notify` controls whether new users are emailed an invite — it is NOT the
    // login-access flag (that defaults to Yes on the server).
    if (filled.length && !badMobiles.length) onAdd(filled, notify, effectiveMessage, orgName);
    else if (badMobiles.length) return;
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
              Export the roster to Excel, add new people as rows at the bottom (leave User ID blank), then import the file.
              <br />
              Changes to people already on it are shown for you to review before anything is saved.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={onFile}
            />
            <div className="mt-3 flex justify-center gap-2">
              <button
                type="button"
                onClick={onExport}
                title="Download the roster as an Excel workbook — roles, direct managers, projects and privileges as dropdowns"
                className="inline-flex h-9 items-center gap-1.5 rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
              >
                <Download className="h-4 w-4" /> Export to Excel
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border px-4 text-sm font-medium transition-colors hover:bg-muted"
              >
                <Upload className="h-4 w-4" /> Import from Excel
              </button>
            </div>
          </div>

          {imported && <ImportSummary imported={imported} onReview={onReview} />}

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
                  // for them, mirroring the single "Add a user" dialog. A
                  // Reporting Officer is Standard by another name.
                  const isStandard = roleTier(r.role) === 'Standard';
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
                            {rolesFor(isStandaloneOrg(activeOrg), r.role).map((role) => (
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

        <div className="flex items-center justify-between gap-4 border-t px-6 py-4">
          {/* Which row, and what is wrong with it. */}
          {badMobiles.length ? (
            <p className="text-xs text-destructive">
              {badMobiles.length === 1
                ? `Row ${badMobiles[0].row}: ${badMobiles[0].msg}`
                : `${badMobiles.length} rows need a mobile number in full international format — rows ${badMobiles
                    .map((b) => b.row)
                    .join(', ')}.`}
            </p>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={commit}
            disabled={!filled.length || badMobiles.length > 0}
            className="inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// What the imported file did: who it added to the grid, who it would change
// (reviewed in the import preview, not here), and every row it skipped, by row
// number, so the fix is a matter of finding that row in Excel.
function ImportSummary({ imported, onReview }) {
  const { fileName, plan, failed } = imported;
  if (failed) {
    return (
      <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {fileName} couldn’t be read as an Excel workbook (.xlsx). Export the roster, edit that file, and import it again.
      </p>
    );
  }
  const { additions, changes, errors, unchanged, deferred } = plan;
  const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">{fileName}</span>
        {': '}
        {additions.length ? `${people(additions.length)} new, added to the list below.` : 'nobody new in this file.'}
        {unchanged ? ` ${people(unchanged)} already here unchanged.` : ''}
      </p>
      {additions.length > 0 && deferred.length > 0 && (
        <p className="text-muted-foreground">
          {deferred.join(', ')} for new people {deferred.length === 1 ? 'isn’t' : 'aren’t'} set when adding them. Import the same file
          again once they’re added and {deferred.length === 1 ? 'it is' : 'those are'} applied.
        </p>
      )}
      {changes.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2">
          <span>The file also changes {people(changes.length)} already on the roster.</span>
          <button
            type="button"
            onClick={() => onReview({ ...plan, errors: [] }, fileName)}
            className="inline-flex h-8 items-center rounded-md border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted"
          >
            Review changes
          </button>
        </div>
      )}
      {errors.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-50 p-3 text-amber-900">
          <p className="mb-1.5 flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4" /> Skipped — fix these rows in the file and import it again
          </p>
          <ul className="space-y-1">
            {errors.map((e, i) => (
              <li key={i}>
                {e.row ? <span className="tabular-nums">Row {e.row}</span> : null}
                {e.name ? <span className="font-medium"> {e.name}</span> : null}
                {e.row || e.name ? ': ' : ''}
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
