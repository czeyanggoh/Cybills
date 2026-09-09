# CYBills user roles & privilege enforcement — spec (match Dext)

Status: **partly built** — gaps 1 (Access all documents), 2 (Create expense
claims) and 3 (Publishing permissions) all landed 9 Sep 2026, so every toggle in
the dialog now does what it says. Gaps 4 and 5 — the two that are about one ROLE
being able to act on another — are still proposed.
Owner: **boss** (roles/permissions area).
Written 2026-08-21 as an advisory spec so the enforcement can be added without a
two-session collision.

## Reality check: no Dext ↔ CYBills sync

CYBills is a standalone Dext-style app. It **cannot read privileges you set in
Dext** — there is no Dext API integration. "Edit in Dext → restrict in CYBills"
would require building a whole Dext sync that does not exist here.

This spec is about making **CYBills' own "Edit privileges" modal actually
enforce**, following Dext's documented role logic
(https://help.dext.com → Business roles: Business admin / User admin / Standard).

Privileges are stored on the user record as
`privileges = { accessAll, createClaims, canPublish }`
(`server/src/users.ts`, edited in `src/components/EditUserModal.jsx`).

## Roles (already implemented — keep)

`ROLES = ['Business Admin', 'User Admin', 'Standard']` in `src/lib/userStore.js`.

- **Business Admin** — full access: users, settings, all documents, subscriptions.
- **User Admin** — manage all documents + most account settings; create/manage
  Standard Users and other User Admins. **Cannot** edit/suspend/remove Business
  Admins, or manage subscriptions.
- **Standard** — view/edit only their own items by default; no Users page, no
  account settings. Optionally granted the per-user privileges below.

Already working: Standard users are nav-gated out of **Users** and **Business
settings**; Business settings = Business Admin only; email/connection routes are
Business-Admin-gated server-side (`server/src/mail.ts`).

## Gaps to build

### 1. Access all documents — `privileges.accessAll` (Standard only) — **DONE**
Built 9 Sep 2026. A Standard user sees their own submissions and their **direct
reports'** — the Direct manager column, which is the line a claim's approval
already travels up, so it is the org chart the app already holds. One level:
somebody who needs a whole tree gets `accessAll`, which is what the toggle is
for. Business Admin, User Admin and the practice's colleagues are unaffected.

- `seesEveryDocument` / `visibleOwnersFor` / `addressIn` in `server/src/users.ts`,
  next to the rows they read.
- Applied in `GET /api/costs/bills`, in `canReadBill` (which covers the by-id,
  file, file-meta, where and move-entity roads at once), and on the writes —
  PATCH / DELETE / unpublish — because a document somebody cannot see is not
  one they may change. 404 throughout, never 403.
- Claims follow the same line (`claimVisibleTo` in `server/src/claims.ts`), with
  one addition: a claim routed to somebody for a DECISION is visible to them
  whoever raised it, or the approval request arrives by email and leads to an
  empty list. That clause is the caller's alone, not their reports'.
- ⚠️ Owner-drift trap, avoided: an earlier owner-based filter was removed because
  it hid a person's own uploads when the editable "owner" field drifted. The set
  is matched against `createdBy` — the uploader's address, never rewritten — OR
  the owner, and the union is the point: their own upload can never be hidden
  from them, and a document reassigned TO somebody is still theirs to work on.
- Refined the same day, at Cze's request: a report's CLAIMS reach their approver
  (they have to decide them) but a report's COSTS do not. The one exception is a
  document already ON a claim, which the approver may READ but not edit — the
  claim PDF is assembled in the browser out of those files, so without it an
  approver is sent a decision they cannot see the evidence for.
- Covered by `npm test` in `server/` (`test/document-visibility.test.mts`).

### 2. Create expense claims — `privileges.createClaims` — **DONE**
Built 9 Sep 2026.

- `canCreateClaims` in `server/src/users.ts`, asked only of a STANDARD user, and
  answered on the membership payload as `createClaims`.
- Server: `mayCreateClaims` guards `POST /api/claims` and
  `POST /api/claims/:id/items`. Both halves, because a claim is assembled from
  its items — refusing one would leave somebody with an empty claim they could
  not fill. `items/remove` and `items/update` are deliberately NOT gated:
  undoing must stay open, or a claim somebody should not have been given becomes
  unfixable.
- UI (hidden, not disabled): the Costs toolbar's "Add to expense claim", both of
  the cost page's, "Create expense claim" on the claims list, and the claim
  page's "Add items" and **Move** — Move lands items on another claim, which is
  the same act as adding them to one.
- Covered by `npm test` in `server/` (`test/claim-create-privilege.test.mts`).

### 3. Publishing permissions — `privileges.canPublish` — **DONE**
Built 9 Sep 2026, keeping the stored BOOLEAN. The third Dext option
("expense claims only") was considered and deliberately not built: Cze asked for
the two options the dialog already offers to start working rather than for a new
one to be added. If it is ever wanted, `canPublish` becomes
`publish: 'all' | 'claims' | 'none'` and only `mayPublish` has to learn the
difference.

- `canPublishToXero` in `server/src/users.ts`, asked only of a STANDARD user:
  both admin tiers publish by role and are never shown the toggles, so a stale
  `false` on an admin row must not lock them out.
- Answered on the membership payload as `canPublish`, beside `admin` /
  `businessAdmin` / `canManageUsers`, so the browser never derives a different
  answer from the one the API enforces. `canPublishToXero` in
  `src/lib/userStore.js` reads it.
- Server: `mayPublish` guards `publish-bill`, `update-bill`, `publish-claim` and
  `update-claim` (`server/src/xero.ts`). UPDATING counts — it restates money in
  a live ledger. NOT inside `postBillToXero`: the cyworkspace payables hand-off
  shares it, proves itself with the inbound key and has no roster row, so a
  check there would refuse a payment run.
- UI: the buttons are HIDDEN rather than offered and refused —
  `src/pages/CostDetail.jsx` (publish + update), `src/pages/Costs.jsx` (the bulk
  toolbar), `src/pages/ExpenseClaimDetail.jsx` (publish + update), and the
  drawer's automatic publish-after-reading in
  `src/components/AddDocumentsDrawer.jsx`.
- Covered by `npm test` in `server/` (`test/publish-privilege.test.mts`).

### 4. User Admin cannot manage Business Admins
- When the signed-in user is **User Admin** and the target row is **Business
  Admin**: disable Edit privileges / Edit details (role) / Deactivate / Remove /
  Set password in the Users **Manage** menu (`src/pages/Users.jsx`).
- A User Admin cannot **promote** anyone to Business Admin.
- Enforce **server-side** in `PATCH /api/users/:id` (+ deactivate/remove): reject
  when the actor is not a Business Admin and the target is (or is being set to)
  Business Admin.

### 5. Direct route guards
Confirm that typing `/users` or `/settings` directly is blocked/redirected for a
non-admin (not merely hidden from the nav). The "Admin gate: stop Business
settings vanishing" work may already cover this — verify.

## Notes
- Standard-user privileges only apply to the **Standard** role; User/Business
  Admins have full rights by role and don't show the per-user toggles.
- The `privileges` object is already round-tripped by the server
  (`EDITABLE` includes `privileges`), so only the **reads/enforcement** are
  missing, plus the `canPublish` → `publish` shape change.
- The WhatsApp and Bank tabs show every document in the entity and are already
  Business Admin only, on the route and in the rail, so gap 1 does not reach
  them.
