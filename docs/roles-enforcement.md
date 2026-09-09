# CYBills user roles & privilege enforcement — spec (match Dext)

Status: **partly built** — gap 1 (Access all documents) landed 9 Sep 2026; gaps
2-5 are still proposed. Owner: **boss** (roles/permissions area).
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
- Covered by `npm test` in `server/` (`test/document-visibility.test.mts`).

### 2. Create expense claims — `privileges.createClaims` (Standard only)
- OFF → hide/disable **"Add to expense claim"** (`src/pages/Costs.jsx`,
  `src/pages/CostDetail.jsx`) and **"Create expense claim"**
  (`src/pages/ExpenseClaims.jsx`).
- Server: reject `POST /api/claims` and `POST /api/claims/:id/items` for a
  Standard user without the privilege.

### 3. Publishing permissions — Dext has **3 options**; CYBills stores a boolean
Change `canPublish` (boolean) → `publish: 'all' | 'claims' | 'none'`.
- `none` → hide every "Publish to Xero".
- `claims` → only expense-claim publish allowed.
- `all` → cost items + claims.
- Enforce in UI (`src/pages/CostDetail.jsx` + `src/pages/ExpenseClaimDetail.jsx`
  publish buttons, and the drawer's auto-publish in
  `src/components/AddDocumentsDrawer.jsx`) **and** server-side:
  `publish-bill` requires `all`; `publish-claim` requires `all` or `claims`
  (`server/src/xero.ts`).

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
