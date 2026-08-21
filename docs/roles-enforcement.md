# CYBills user roles & privilege enforcement — spec (match Dext)

Status: **proposed** — enforcement not yet wired. Owner: **boss** (roles/permissions area).
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

### 1. Access all documents — `privileges.accessAll` (Standard only)
- OFF → the user sees **only their own** documents; ON → all.
- Enforce **server-side** in `GET /api/costs/bills` (`server/src/bills.ts`) and
  the claims list (`server/src/claims.ts`, extend `visibleClaimsFor`): filter to
  `createdBy === me` for a Standard user without `accessAll`.
- ⚠️ Owner-drift trap: an earlier owner-based filter was removed because it hid a
  person's own uploads when the editable "owner" field drifted (see the note in
  `bills.ts`). Key the filter on the **session user's email/id vs `createdBy`**,
  NOT the editable owner display field.

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
