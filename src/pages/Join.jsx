import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { CheckCircle2, Clock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { joinCompany, fetchJoinPeople, fetchJoinCompanies } from '@/lib/userStore';

// Self-signup asks for a simple role — an employee who submits, or an
// admin/approver who reviews. The (CY) admin can fine-tune the exact role
// (Business Admin vs User Admin) on approval. Values map onto the app's roles.
const JOIN_ROLES = [
  { value: 'Standard', label: 'Employee' },
  { value: 'Business Admin', label: 'Admin' },
];

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
  // Names only, from the join endpoint: the entity list proper is served to
  // people who are on a roster, and somebody joining is not yet.
  const [organisations, setOrganisations] = useState([]);
  useEffect(() => {
    let live = true;
    fetchJoinCompanies().then((list) => { if (live) setOrganisations(list); });
    return () => { live = false; };
  }, []);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [mobile, setMobile] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [role, setRole] = useState('Standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Whoever the admin has already added to the chosen company and who has never
  // signed in. Picking yourself here attaches this request to THAT row, so your
  // name, your role and the documents already filed under you stay yours —
  // rather than a second row for the same person, spelled slightly differently.
  const [people, setPeople] = useState([]);
  const [claimId, setClaimId] = useState('');

  useEffect(() => {
    let live = true;
    setClaimId('');
    if (!companyId) {
      setPeople([]);
      return undefined;
    }
    fetchJoinPeople(companyId).then((list) => { if (live) setPeople(list); });
    return () => { live = false; };
  }, [companyId]);

  const claimed = people.find((p) => p.id === claimId) || null;
  const roleLabel = (v) => JOIN_ROLES.find((r) => r.value === v)?.label || 'Employee';

  // Already an approved member — nothing to do here.
  if (membership.status === 'active') return <Navigate to="/costs" replace />;

  const pending = membership.status === 'pending';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!companyId && !companyName.trim()) return setError('Please select or enter your company.');
    // A claimed row already carries both — they're the admin's to set, not
    // this form's to ask for again.
    if (!claimed && (!firstName.trim() || !lastName.trim())) {
      return setError('Please enter your first and last name.');
    }
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
        claimId,
      });
      await refresh(); // membership flips to 'pending' → renders the waiting state
    } catch (err) {
      // Say what actually went wrong. "Please try again" was all this could ever
      // report, so a request the server was refusing outright looked like a blip
      // worth retrying — which it never was.
      setError(err?.message ? `Could not submit your request — ${err.message}` : 'Could not submit your request. Please try again.');
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
                {/* Company first: it decides whose list of people to offer. */}
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

                {people.length > 0 && (
                  <div className="sm:col-span-2">
                    <Field label="Are you one of these people?">
                      <select className={inputCls} value={claimId} onChange={(e) => setClaimId(e.target.value)}>
                        <option value="">I&apos;m not on this list</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </Field>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Your admin may have added you already. Picking yourself keeps the name, role and
                      documents that are already yours.
                    </p>
                  </div>
                )}

                {claimed ? (
                  <>
                    {/* Set by the admin when they added this person — shown, not
                        asked for. Typing them again is what creates a second row
                        for the same human. */}
                    <Field label="Name">
                      <p className="flex h-11 items-center text-sm font-medium">{claimed.name}</p>
                    </Field>
                    <Field label="Role">
                      <p className="flex h-11 items-center text-sm">
                        {roleLabel(claimed.role)}
                        <span className="ml-2 text-xs text-muted-foreground">set by your admin</span>
                      </p>
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="First Name">
                      <input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} />
                    </Field>
                    <Field label="Last Name">
                      <input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} />
                    </Field>
                  </>
                )}

                <Field label="Contact Number">
                  <input className={inputCls} value={mobile} onChange={(e) => setMobile(e.target.value)} />
                </Field>

                {!claimed && (
                  <Field label="Requested Role">
                    <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
                      {JOIN_ROLES.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  </Field>
                )}
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
