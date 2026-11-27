// A person may have several direct managers, and a claim of theirs is sent to
// ONE of them, picked when it is submitted. Pure: shared by the claim dialogs,
// the roster pages and the roster spreadsheet. The server's copy is
// `managerIdsOf` / `directManagersFor` in server/src/users.ts.

// The ids on a roster row. One saved before there could be several carries only
// `managerId`.
export function managerIdsOf(user) {
  if (Array.isArray(user?.managerIds)) return [...new Set(user.managerIds.filter(Boolean))];
  return user?.managerId ? [user.managerId] : [];
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Who a claim for `claimantName` may be sent to. Somebody deactivated cannot
// sign in to decide anything, so they are offered only where there is nobody
// else.
export function directManagersFor(users, claimantName) {
  const claimant = (users || []).find((u) => norm(u.name) === norm(claimantName));
  const found = managerIdsOf(claimant)
    .map((id) => (users || []).find((u) => u.id === id))
    .filter(Boolean);
  const active = found.filter((u) => !u.deactivated);
  return active.length ? active : found;
}

// The manager a submission starts out pointing at: the only one there is, else
// the one this claim was last sent to. '' means somebody has to choose.
export function defaultApproverId(claim, managers) {
  if (managers.length === 1) return managers[0].id;
  const email = norm(claim?.approverEmail);
  const name = norm(claim?.approver);
  const last =
    (email && managers.find((m) => norm(m.email) === email)) || (name && managers.find((m) => norm(m.name) === name));
  return last ? last.id : '';
}
