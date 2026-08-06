import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { CheckCircle2, Clock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useOrganisations } from '@/lib/organisations';
import { joinCompany, ROLES } from '@/lib/userStore';

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'h-11 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

// Self-signup onboarding. A signed-in user who isn't yet an approved member fills
// in their details and picks the company (organisation) they belong to; the
// request goes to the admins for approval. Mirrors CYHR's join page in spirit,
// but collects only what a billing app needs — no NRIC / bank / payroll data.
export default function Join() {
  const { user, membership, signOut, refresh } = useAuth();
  const { data: organisations = [] } = useOrganisations();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [mobile, setMobile] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [role, setRole] = useState('Standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Already an approved member — nothing to do here.
  if (membership.status === 'active') return <Navigate to="/costs" replace />;

  const pending = membership.status === 'pending';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!firstName.trim() || !lastName.trim()) return setError('Please enter your first and last name.');
    if (!companyId && !companyName.trim()) return setError('Please select or enter your company.');
    setBusy(true);
    try {
      const picked = organisations.find((o) => o.id === companyId);
      await joinCompany({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        mobile: mobile.trim(),
        companyId,
        companyName: picked?.name || companyName.trim(),
        role,
      });
      await refresh(); // membership flips to 'pending' → renders the waiting state
    } catch {
      setError('Could not submit your request. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted/20">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-foreground text-background">$</span>
            CYBills
          </div>
          <button type="button" onClick={signOut} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Sign out
          </button>
        </div>

        {pending ? (
          <div className="rounded-2xl border bg-background p-8 text-center shadow-sm">
            <Clock className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">Request submitted</h1>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Thanks{user?.name ? `, ${user.name.split(' ')[0]}` : ''}. Your request to join
              {membership.user?.companyName ? ` ${membership.user.companyName}` : ' your company'} on CYBills is
              awaiting approval. You&apos;ll get access as soon as an admin approves it.
            </p>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Join your company on CYBills</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Your account{user?.email ? ` (${user.email})` : ''} isn&apos;t linked to a company yet. Fill in your
              details and pick your company below — an admin will review and approve your access.
            </p>

            <form onSubmit={submit} className="mt-6 rounded-2xl border bg-background p-6 shadow-sm sm:p-8">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="First Name">
                  <input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                </Field>
                <Field label="Last Name">
                  <input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} />
                </Field>
                <Field label="Contact Number">
                  <input className={inputCls} value={mobile} onChange={(e) => setMobile(e.target.value)} />
                </Field>
                <Field label="Requested Role">
                  <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Company">
                    {organisations.length > 0 ? (
                      <select className={inputCls} value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                        <option value="">Select your company…</option>
                        {organisations.map((o) => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={inputCls}
                        placeholder="Your company name"
                        value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
              </div>

              {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

              <div className="mt-6 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-11 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {busy ? 'Submitting…' : 'Request access'}
                </button>
                <span className="text-xs text-muted-foreground">An admin will review and approve your request.</span>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
