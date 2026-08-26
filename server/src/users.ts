import { Router, type Request, type Response } from 'express';
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId } from './workspace.js';
import { getOrganisation, primaryOrgId, listOrganisations, dataScopeForOrg } from './organisations.js';
import { setSession, readSession } from './auth.js';
import { env, googleEnabled } from './env.js';
import { sendMail, inviteEmail, passwordResetEmail, passwordChangedEmail } from './mailer.js';
import { reassignPerson } from './store.js';

// Password login (non-Google), so staff on Google Workspace accounts that Google
// blocks can still sign in. Passwords are salted + scrypt-hashed (Node built-in,
// no native dep). An admin (already signed in) sets a user's password; the user
// then logs in with email + password, getting the same session cookie as Google.
function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const orig = Buffer.from(hash, 'hex');
  const test = scryptSync(pw, salt, 64);
  return orig.length === test.length && timingSafeEqual(orig, test);
}

// Invitation / password-reset links. The raw token only ever exists in the
// email (and in the response to the admin who triggered it) — the row keeps a
// SHA-256 so the stored copy is useless on its own. One live token per user:
// issuing a new link silently invalidates the previous one.
const TOKEN_TTL_MS = env.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
const tokenHash = (raw: string) => createHash('sha256').update(raw).digest('hex');

function issueToken(user: User, kind: 'invite' | 'reset'): string {
  const raw = randomBytes(32).toString('hex');
  user.resetTokenHash = tokenHash(raw);
  user.resetTokenExpires = Date.now() + TOKEN_TTL_MS;
  user.resetTokenKind = kind;
  return raw;
}

function clearToken(user: User) {
  delete user.resetTokenHash;
  delete user.resetTokenExpires;
  delete user.resetTokenKind;
}

// The public origin to build emailed links from. Prefer an explicitly-set
// APP_ORIGIN, but when it's left at the localhost default, derive the real
// origin from the incoming request (behind nginx: X-Forwarded-Proto/Host) so
// invite/reset links point at the domain the app is actually served from —
// no env footgun.
export function appOrigin(req: Request): string {
  const configured = (env.APP_ORIGIN || '').replace(/\/+$/, '');
  if (configured && !configured.includes('localhost')) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : (configured || 'http://localhost:5173');
}

// The page the emailed link lands on, where the recipient chooses a password.
const resetUrl = (req: Request, raw: string) => `${appOrigin(req)}/set-password?token=${raw}`;

function findByToken(items: User[], raw: string): User | undefined {
  if (!raw) return undefined;
  const h = tokenHash(raw);
  return items.find((u) => u.resetTokenHash === h && !u.removed && (u.resetTokenExpires ?? 0) > Date.now());
}

// Server-backed users, shared across the workspace (same JSON-store pattern as
// claims). This is the company's people list + approver roster + Users-page
// data — now central and shared instead of per-browser localStorage.

export type User = {
  id: string;
  workspaceId: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  login: 'Yes' | 'No';
  role: string;
  mobile: string;
  privileges: Record<string, unknown>;
  lastLogin: string;
  deactivated: boolean;
  removed: boolean;
  // Self-signup: a user who joined via /join is `pending` until an admin
  // approves them, and is tied to the company (organisation) they picked.
  pending: boolean;
  // The organisation (linked Xero tenant) this row belongs to. Users are
  // tenant-specific: the Users page lists only the selected organisation's
  // people, and a new user is created under whichever one is selected. Empty
  // only while no organisation is linked yet.
  organisationId: string;
  // The entity's GENERAL account — created with the organisation itself, and
  // never a person. It owns the documents nobody claimed: anything a practice
  // colleague adds to this client lands here unless they name one of the
  // client's own people as the owner. It has no real address, so it can't sign
  // in, be invited, or approve anything.
  general: boolean;
  companyId: string;
  companyName: string;
  // --- Practice membership ---------------------------------------------------
  // A colleague is a member of the practice (CYBM) rather than an employee of a
  // client entity: they don't belong to one tenant, they work across the ones
  // they're given client access to. `practice` is what the two rosters split on
  // — Users lists the selected entity's employees, Colleagues lists the practice.
  practice: boolean;
  // Owner / Practice Admin run the practice itself (the Colleagues page and the
  // client list); Standard colleagues just work on their assigned clients.
  practiceRole: string;
  // The client entities (organisation ids) this colleague may open. They are a
  // Business Admin inside each one — that's the point of being on the practice
  // team. Ignored for client employees, who are confined to their own entity.
  clientAccess: string[];
  // Access to every linked client, including ones added later.
  allClients: boolean;
  // The user's direct manager (another user's id) — the approver a claim is
  // auto-routed to when this person submits it for approval.
  managerId?: string;
  // The Xero project / PIC tracking option assigned to this user. New documents
  // they upload are auto-allocated to it.
  project?: string;
  // Inbound email ("Extract by email"). Each user gets a short handle, so their
  // address is `<emailHandle>@cybills.sg`; a supplier (or the user) forwards
  // bills there and CYBills files them under this person. Unique per workspace.
  emailHandle?: string;
  // A Gmail forwarding-confirmation link CYBills caught at this user's address
  // and is holding for them to click (so nobody needs to read a mailbox). Set by
  // the inbound endpoint; cleared once the user confirms.
  pendingForward?: { url: string; code: string; from: string; at: string } | null;
  passwordHash?: string; // set by an admin; never returned to the client
  // Single-use invitation / password-reset link. Only the SHA-256 of the token
  // is stored, so a leaked data file can't be replayed into an account.
  resetTokenHash?: string;
  resetTokenExpires?: number; // epoch ms
  resetTokenKind?: 'invite' | 'reset';
  invitedAt?: string; // ISO timestamp of the last invitation sent
};

// Public shape sent to the client — never leak the password hash or the reset
// token; expose only whether a password has been set.
export function publicUser(u: User) {
  const { passwordHash, resetTokenHash, resetTokenExpires, resetTokenKind, ...rest } = u;
  // The general account's address is an internal identity (what a document
  // stores as its owner), not a mailbox anyone can write to — so the roster
  // reports it as having none, and the UI treats it accordingly: nothing to
  // invite, nothing to reset.
  const email = u.general || isInternalAddress(rest.email) ? '' : rest.email;
  return { ...rest, email, hasPassword: Boolean(passwordHash) };
}

const COLLECTION = 'users';
const load = () => loadCollection<User>(COLLECTION);
export const save = (items: User[]) => saveCollection(COLLECTION, items);

// The real company employees (matching the CYHR/Talenox records). Seeded once
// per workspace so the list is never empty.
const SEED: Array<Partial<User>> = [
  { id: 'astrid', name: 'Astrid Yang', email: 'astridy2004@gmail.com', login: 'Yes', role: 'Business Admin' },
  { id: 'cze', name: 'Cze Yang Goh', email: 'czeyang.goh@cy-bm.sg', login: 'Yes', role: 'Business Admin' },
  { id: 'yeoh', name: 'Yeoh Lay Ean', email: 'joanne_yle@yahoo.com', login: 'Yes', role: 'Standard' },
  { id: 'yuyu', name: 'Yu Yu', email: 'yuyu@cy-bm.sg', login: 'Yes', role: 'Standard' },
];

const norm = (s: string) => String(s ?? '').trim().toLowerCase();
// The intended one-email-per-teammate identity, from the seed (each person's
// real address that both their login and CYHR use).
const SEED_EMAIL_BY_NAME = new Map(SEED.map((s) => [norm(String(s.name)), norm(String(s.email))]));
const SEED_IDS = new Set(SEED.map((s) => s.id));

export function full(u: Partial<User>, ws: string): User {
  const name = (u.name || `${u.firstName || ''} ${u.lastName || ''}`).trim() || 'New user';
  return {
    id: u.id || `nu_${randomUUID().slice(0, 8)}`,
    workspaceId: ws,
    name,
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    email: u.email || '',
    login: u.login === 'No' ? 'No' : 'Yes',
    role: u.role || 'Standard',
    mobile: u.mobile || '',
    privileges: u.privileges || {},
    lastLogin: u.lastLogin || '—',
    deactivated: Boolean(u.deactivated),
    removed: Boolean(u.removed),
    pending: Boolean(u.pending),
    practice: Boolean(u.practice),
    practiceRole: currentPracticeRole(u.practiceRole),
    clientAccess: Array.isArray(u.clientAccess) ? u.clientAccess.filter(Boolean) : [],
    allClients: Boolean(u.allClients),
    organisationId: u.organisationId || '',
    general: Boolean(u.general),
    companyId: u.companyId || '',
    companyName: u.companyName || '',
    project: u.project || '',
    emailHandle: u.emailHandle || '',
    pendingForward: u.pendingForward ?? null,
  };
}

// --- Inbound email handles ---------------------------------------------------
// The domain user addresses live on (Cloudflare-managed). Every user's inbound
// address is `<emailHandle>@INBOUND_MAIL_DOMAIN`.
export const INBOUND_MAIL_DOMAIN = process.env.INBOUND_MAIL_DOMAIN || 'cybills.sg';

// A friendly, unique-per-workspace handle base from the person's name (falling
// back to their email local-part). "Yakson Ong" -> "yakson"; collisions get a
// numeric suffix.
function handleBase(u: Partial<User>): string {
  const raw = String(u.firstName || u.name || (u.email ? u.email.split('@')[0] : '') || 'user');
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return slug || 'user';
}

// Assign a handle to every real (non-general, non-removed) user in `ws` that
// lacks one, unique across the workspace. Returns true if anything changed.
function ensureEmailHandles(items: User[], ws: string): boolean {
  const taken = new Set(
    items.filter((u) => u.workspaceId === ws && u.emailHandle).map((u) => String(u.emailHandle).toLowerCase())
  );
  let changed = false;
  for (const u of items) {
    if (u.workspaceId !== ws || u.removed || u.general || u.emailHandle) continue;
    const base = handleBase(u);
    let handle = base;
    let n = 1;
    while (taken.has(handle)) { n += 1; handle = `${base}${n}`; }
    u.emailHandle = handle;
    taken.add(handle);
    changed = true;
  }
  return changed;
}

// Clean a hand-typed handle into something that can actually be the local-part
// of an address: lowercase, letters/digits with dots or hyphens between them,
// nothing leading or trailing, and short enough to be a real mailbox name.
// Returns '' when nothing usable is left, which the caller refuses rather than
// storing — an address of "@cybills.sg" would swallow mail for everyone.
export function normaliseHandle(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .split('@')[0] // tolerate someone pasting the whole address back in
    .replace(/[^a-z0-9.-]+/g, '')
    .replace(/[.-]{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
}

// Resolve an inbound address' local-part (handle) to its user, ignoring any
// `+suffix` and case. Workspace-wide (the inbound mailbox is one for all).
export function userByEmailHandle(handle: string): User | null {
  const h = String(handle || '').split('+')[0].trim().toLowerCase();
  if (!h) return null;
  return load().find((u) => !u.removed && !u.general && String(u.emailHandle || '').toLowerCase() === h) || null;
}

// Store / clear the Gmail forwarding confirmation CYBills is holding for a user.
export function setPendingForward(userId: string, data: { url: string; code: string; from: string }): User | null {
  const items = load();
  const u = items.find((x) => x.id === userId && !x.removed);
  if (!u) return null;
  u.pendingForward = { url: data.url, code: data.code, from: data.from, at: new Date().toISOString() };
  save(items);
  return u;
}
export function clearPendingForward(userId: string): User | null {
  const items = load();
  const u = items.find((x) => x.id === userId && !x.removed);
  if (!u) return null;
  u.pendingForward = null;
  save(items);
  return u;
}

// --- Tenancy -----------------------------------------------------------------
// Every roster row belongs to one organisation (a linked Xero tenant), so the
// Users page is that client entity's own people list rather than one list shared
// across every entity. The client names the selected organisation with the same
// X-Org-Id header the bills API uses; an absent or unknown value falls back to
// the primary organisation, so a caller that predates the picker still lands
// somewhere sensible. Before the first organisation is linked the scope is '' —
// every row shares it, and the roster behaves exactly as it did.
export function orgScope(req: Request): string {
  const ws = workspaceId(req);
  const requested = (req.header('X-Org-Id') || '').trim();
  const me = memberForSession(req);
  if (requested && getOrganisation(ws, requested) && canAccessOrg(me, requested)) return requested;
  return defaultOrgFor(ws, me);
}

const inOrg = (u: User, org: string) => (u.organisationId || '') === org;

// --- The entity's general account --------------------------------------------
// Every linked organisation gets one row that isn't a person: the account the
// client's unclaimed paperwork belongs to. It exists so that a colleague doing
// the client's books never has to own the client's documents — what they add
// lands here unless they name one of the client's own people. Created with the
// organisation (and backfilled onto organisations linked before this existed),
// so the Users list is never empty for a freshly-linked client.
export const GENERAL_USER_NAME = 'General';

// The row needs an address because a document's owner is stored as one, but
// nothing is ever sent to it: it's derived from the organisation id (unique by
// construction), on a domain that doesn't resolve, and the UI shows the row as
// having no email at all.
const generalEmailFor = (orgId: string) => `${orgId}.general@cybills.local`;

// The same trick, for a person who has no mailbox.
//
// Plenty of people on a client's roster are never going to sign in — the ST
// Engineering staff claiming through a bridge entity are the case that forced
// this. A document's owner is always an EMAIL, and the directory that resolves
// owners skips anyone without one, so a person added with a blank address
// existed on the roster and could own nothing: they never appeared in the
// Document owner picker, and no claim could be made out to them.
//
// So they get an identity instead of a mailbox: derived from their name, on a
// domain that doesn't resolve, hidden by publicUser and never written to.
const INTERNAL_DOMAIN = '@cybills.local';
export const isInternalAddress = (email: string) => norm(email).endsWith(INTERNAL_DOMAIN);

function internalEmailFor(orgId: string, name: string, taken: Set<string>): string {
  const slug = norm(name).replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'person';
  const base = `${slug}.${orgId || 'workspace'}`;
  let candidate = `${base}${INTERNAL_DOMAIN}`;
  let n = 1;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${base}.${n}${INTERNAL_DOMAIN}`;
  }
  taken.add(candidate);
  return candidate;
}

const isGeneralRow = (u: User, ws: string, org: string) =>
  u.workspaceId === ws && !u.removed && u.general && inOrg(u, org);

// A practice colleague working on an entity from OUTSIDE it — the case the
// general account exists for. Deliberately not "is on the practice team": the
// practice's own entity is a client like any other, and the colleagues who
// belong to it are its own people there, so their own company's paperwork keeps
// their name on it.
const isOutsider = (u: User | undefined, org: string) => Boolean(u?.practice) && !inOrg(u as User, org);

// The general account for one entity, or null before any organisation is linked.
export function generalUserFor(ws: string, org: string): User | null {
  if (!org) return null;
  return ensure(ws).find((u) => isGeneralRow(u, ws, org)) ?? null;
}

// Give every linked organisation its general account. Runs on load, so an
// organisation linked before this existed gets one too, and deleting the row
// simply brings it back — it's part of the entity, not a person someone added.
function ensureGeneralUsers(items: User[], ws: string): boolean {
  let changed = false;
  for (const org of listOrganisations(ws)) {
    if (items.some((u) => isGeneralRow(u, ws, org.id))) continue;
    items.push(
      full(
        {
          name: GENERAL_USER_NAME,
          email: generalEmailFor(org.id),
          login: 'No',
          role: 'Standard',
          general: true,
          organisationId: org.id,
          companyId: org.id,
          companyName: org.name,
          practice: false,
        },
        ws
      )
    );
    changed = true;
  }
  return changed;
}

// Called when an organisation is linked. ensure() creates the row for every
// linked organisation, so all this has to do is run after the new one is stored.
export function ensureGeneralUser(ws: string, orgId: string): User | null {
  return generalUserFor(ws, orgId);
}

// --- Who can own a document here ---------------------------------------------
// Attribution is not the roster. The Users page is one client entity's own
// people (`!u.practice`), which is right for managing them — but a document in
// that entity is very often uploaded by a COLLEAGUE working on it, and a name
// the app cannot resolve falls back to the raw email local-part ("czeyang.goh"
// next to "Cze Yang Goh", the same person twice). So the directory below is the
// wider set: the entity's people PLUS the practice colleagues with access to
// it, each entry saying which it is. Names, emails and those flags only, and
// only for an entity the caller can open.
export function peopleForOrg(
  ws: string,
  org: string
): Array<{ email: string; name: string; external: boolean; general: boolean; deactivated: boolean }> {
  return ensure(ws)
    .filter((u) => u.workspaceId === ws && !u.removed && (inOrg(u, org) || (u.practice && canAccessOrg(u, org))))
    .filter((u) => Boolean(u.email))
    .map((u) => ({
      email: u.email,
      name: u.name || u.email,
      // What each entry IS here, because the two questions differ: a colleague
      // from outside is never OFFERED as a document's owner (that's the general
      // account's job), but their name must still resolve on the documents they
      // uploaded.
      external: isOutsider(u, org),
      general: Boolean(u.general),
      // Same split again, for someone who has left: their old documents must go
      // on reading as a person, but nothing new should be handed to an account
      // that can no longer sign in.
      deactivated: Boolean(u.deactivated),
    }));
}

// Resolve whatever a caller called a person — their email, or the display name
// an older document stored — to the ONE email that identifies them. '' when
// nobody matches, or when a name is ambiguous: a guess here mislabels a
// document, and the field is better left following the uploader.
export function emailForPerson(ws: string, org: string, value: string): string {
  const want = norm(value);
  if (!want) return '';
  const people = peopleForOrg(ws, org);
  const byEmail = people.find((p) => norm(p.email) === want);
  if (byEmail) return byEmail.email;
  const byName = people.filter((p) => norm(p.name) === want);
  return byName.length === 1 ? byName[0].email : '';
}

// Who a document in this entity actually belongs to, given what the client
// asked for (`requested`) and who is putting it there (`uploader`, an email;
// pass '' when nobody is uploading, e.g. an edit). The practice's rule:
//
//   * one of the client's own people was named → that person owns it;
//   * a COLLEAGUE FROM OUTSIDE this entity was named, or one of them uploaded
//     without naming anyone → the entity's general account owns it. A colleague
//     does the client's books; the paperwork is still the client's;
//   * an address the directory can't place → kept as given (a real person we
//     simply don't know here);
//   * nothing named, uploaded by the client's own person → left empty, which
//     is how a document keeps following its uploader.
export function ownerForOrg(ws: string, org: string, requested: string, uploader: string): string {
  const items = ensure(ws);
  const rowFor = (email: string) => {
    const want = norm(email);
    return want ? items.find((u) => u.workspaceId === ws && !u.removed && norm(u.email) === want) : undefined;
  };
  const generalEmail = () => items.find((u) => isGeneralRow(u, ws, org))?.email || '';

  const raw = String(requested ?? '').trim();
  const resolved = raw ? emailForPerson(ws, org, raw) || (raw.includes('@') ? raw : '') : '';
  if (resolved) return isOutsider(rowFor(resolved), org) ? generalEmail() : resolved;
  return isOutsider(rowFor(uploader), org) ? generalEmail() : '';
}

// Whose row the caller can act on from where. A client entity's people are
// reachable from that entity; your own row is always reachable (editing your
// profile can't depend on which client you have open); and a colleague's row
// belongs to the practice, so it is reachable to whoever runs the practice
// wherever they happen to be working.
function reachable(u: User, req: Request): boolean {
  const me = memberForSession(req);
  if (me && u.id === me.id) return true;
  if (u.practice) return !readSession(req) || canManagePractice(me);
  return inOrg(u, orgScope(req));
}

// --- Practice membership + client access -------------------------------------
// CYBills is run by a practice (CYBM) for its clients. Two kinds of person are
// on the roster, and they are not variations of one another:
//
//   * a client employee — belongs to exactly one client entity, never sees
//     another one, and carries the role their own admin gave them;
//   * a colleague — a member of the practice, who belongs to no single entity
//     and instead holds "client access" to the entities they work on. Inside
//     one of those they act as a Business Admin, because doing the client's
//     books is the job.
//
// Everything below answers the two questions that follow from that: which
// entities may this person open, and what may they do once inside one.

export const PRACTICE_ROLES = ['Owner', 'Practice Admin', 'Standard'];

// Collapse a stored practice role onto the three current ones.
function currentPracticeRole(role: string | undefined): string {
  if (role === 'Owner') return 'Owner';
  if (role === 'Practice Admin' || role === 'Admin') return 'Practice Admin';
  return 'Standard';
}

// --- Locking yourself out -----------------------------------------------------
// Two ways the roster can be left with nobody able to fix it, both of which have
// happened here: deactivating your OWN account (Astrid's practice row went off
// during a duplicate cleanup and her whole nav vanished until Cze put it back),
// and removing the LAST practice Owner (nobody left who can restore one, because
// restoring one is a thing only an Owner can do).
//
// Checked in one place because three routes can cause it — DELETE, the active
// toggle, and a PATCH carrying `deactivated` or a demotion out of Owner.
// Returns the sentence to refuse with, or '' when the change is safe.
type AccessChange = { removed?: boolean; deactivated?: boolean; practiceRole?: string };

export function lockoutRisk(ws: string, target: User, change: AccessChange, actorId: string): string {
  const goingAway = change.removed === true || change.deactivated === true;

  // Your own account. Someone else with the rights can always do it for you —
  // what must not happen is doing it to yourself and losing the way back.
  if (goingAway && actorId && actorId === target.id) {
    return change.removed
      ? 'You can’t delete your own account. Ask another admin to do it.'
      : 'You can’t deactivate your own account — you would lose access with no way to undo it. Ask another admin.';
  }

  // The last Owner of the practice. Demotion counts: an Owner moved to Practice
  // Admin is no longer an Owner, and if they were the only one there is now no
  // way to appoint another.
  const demoted = typeof change.practiceRole === 'string' && currentPracticeRole(change.practiceRole) !== 'Owner';
  if (!goingAway && !demoted) return '';
  if (!target.practice || currentPracticeRole(target.practiceRole) !== 'Owner') return '';
  const otherOwners = ensure(ws).filter(
    (u) =>
      u.workspaceId === ws &&
      !u.removed &&
      !u.deactivated &&
      u.practice &&
      u.id !== target.id &&
      currentPracticeRole(u.practiceRole) === 'Owner'
  );
  if (otherOwners.length) return '';
  const what = change.removed
    ? 'delete them'
    : demoted
      ? 'move them out of Owner'
      : 'deactivate them';
  return `${target.name || 'This colleague'} is the only Owner of the practice, so you can’t ${what} — there would be nobody left who can appoint another. Make someone else an Owner first.`;
}

// Run the practice itself — the Colleagues roster and the client list. Owners
// and Practice Admins only; a Standard colleague does client work.
export function canManagePractice(u: User | null | undefined): boolean {
  if (!u || u.removed || u.deactivated || !u.practice) return false;
  const role = currentPracticeRole(u.practiceRole);
  return role === 'Owner' || role === 'Practice Admin';
}

// May this person open this client entity? A null user is the session-less
// mock/dev context, which stays open like the rest of the app.
export function canAccessOrg(u: User | null | undefined, orgId: string): boolean {
  if (!u) return true;
  if (!orgId) return true; // nothing linked yet — one implicit scope everyone shares
  if (u.practice) return Boolean(u.allClients) || (u.clientAccess || []).includes(orgId);
  return (u.organisationId || '') === orgId;
}

// The entities this person may open, in the order the client should offer them.
export function accessibleOrgIds(ws: string, u: User | null | undefined): string[] {
  const all = listOrganisations(ws).map((o) => o.id);
  if (!u) return all;
  return all.filter((id) => canAccessOrg(u, id));
}

// Where someone lands when they haven't named an entity (or named one they
// can't open): their first accessible client, else the primary organisation so
// a caller with no roster row behaves exactly as it did before client access.
function defaultOrgFor(ws: string, u: User | null | undefined): string {
  if (!u) return primaryOrgId();
  const mine = accessibleOrgIds(ws, u);
  if (!mine.length) return u.practice ? '' : u.organisationId || '';
  const primary = primaryOrgId();
  return mine.includes(primary) ? primary : mine[0];
}

// What this person may do INSIDE a given entity. A colleague with access is a
// Business Admin there; everyone else carries their own stored role.
export function effectiveRoleFor(u: User | null | undefined, orgId: string): string {
  if (!u) return 'Business Admin';
  if (u.practice) return canAccessOrg(u, orgId) ? 'Business Admin' : 'Standard';
  return currentRole(u.role);
}

// The caller's role in the entity they currently have selected.
export function effectiveRole(req: Request): string {
  return effectiveRoleFor(memberForSession(req), orgScope(req));
}

// Give every row an organisation it can actually be found under. Two cases:
// rows that predate tenant scoping (a self-signup already picked their company
// on /join, so honour that when it names a linked organisation; the seed and
// anyone an admin added belong to the primary organisation, where the account's
// data has always lived), and rows whose organisation was later unlinked, which
// would otherwise be invisible in every tenant. Does nothing until an
// organisation exists to assign them to — '' still matches '', so an unlinked
// account keeps working — and runs on every load, so rows created before the
// first organisation was linked are adopted as soon as one is.
function assignOrganisations(items: User[], ws: string): boolean {
  const primary = primaryOrgId();
  if (!primary) return false;
  let changed = false;
  for (const u of items) {
    if (u.workspaceId !== ws) continue;
    if (u.organisationId && getOrganisation(ws, u.organisationId)) continue;
    u.organisationId = u.companyId && getOrganisation(ws, u.companyId) ? u.companyId : primary;
    u.companyName = getOrganisation(ws, u.organisationId)?.name || u.companyName || '';
    changed = true;
  }
  return changed;
}

// Collapse duplicate rows for the same person (same name) into a single row, so
// every teammate has exactly one email. Idempotent — runs on every load so a
// roster that drifted (a person added twice under two addresses) self-heals.
// Prefers the row whose email is the teammate's canonical seed address; else one
// that can log in (has a password); else the original seed row; else the first.
// Any password on a discarded duplicate is carried onto the keeper so sign-in
// keeps working. Returns true if anything changed.
function normalizeRoster(items: User[], ws: string): boolean {
  const groups = new Map<string, User[]>();
  for (const u of items) {
    if (u.workspaceId !== ws || u.removed) continue;
    // The general account is not a person, so it is never somebody's duplicate.
    // Without this, a client with an employee actually named "General" would
    // lose the row to them on load and have it recreated on the next one, for
    // ever.
    if (u.general) continue;
    const name = norm(u.name);
    if (!name) continue;
    // Keyed by organisation as well: the same name under two client entities is
    // two different people, not a duplicate to collapse.
    const key = `${u.organisationId || ''}|${name}`;
    const g = groups.get(key);
    if (g) g.push(u);
    else groups.set(key, [u]);
  }
  let changed = false;
  for (const [key, dups] of groups) {
    if (dups.length < 2) continue; // already one row — nothing to unify
    const seedEmail = SEED_EMAIL_BY_NAME.get(key.slice(key.indexOf('|') + 1));
    const keeper =
      (seedEmail ? dups.find((d) => norm(d.email) === seedEmail) : undefined) ||
      dups.find((d) => d.passwordHash) ||
      dups.find((d) => SEED_IDS.has(d.id)) ||
      dups[0];
    if (!keeper.passwordHash) {
      const withPw = dups.find((d) => d.passwordHash);
      if (withPw) {
        keeper.passwordHash = withPw.passwordHash;
        changed = true;
      }
    }
    for (const d of dups) {
      if (d !== keeper && !d.removed) {
        d.removed = true;
        changed = true;
      }
    }
  }
  return changed;
}

// The account owners: the seeded admins (Astrid, Cze) plus anyone listed in
// OWNER_EMAILS. The env list is the break-glass for an owner whose roster row
// carries neither the seed email nor the seed name — nothing in the code can
// recognise them, so the operator names them in server/.env instead.
function ownerEmails(): Set<string> {
  const emails = SEED.filter((s) => isBusinessAdminRole(String(s.role))).map((s) => norm(String(s.email)));
  for (const e of env.OWNER_EMAILS.split(',')) {
    const v = norm(e);
    if (v) emails.push(v);
  }
  return new Set(emails);
}
function ownerNames(): Set<string> {
  return new Set(SEED.filter((s) => isBusinessAdminRole(String(s.role))).map((s) => norm(String(s.name))));
}

// Guarantee the account owners keep Business Admin — the only tier that can open
// Business settings. Their row can drift to a lesser role, e.g. re-created via
// the /join self-signup flow, which always sets 'Standard', silently locking the
// owner out of Users and Business settings. Runs on every load so it self-heals.
// Matches by email OR name, so an owner who signed up under a different address
// than the seed email is still recovered, and promotes EVERY matching row rather
// than just the first — an owner with a second row (a /join signup alongside the
// seed row) was previously left as Standard whenever the already-admin row came
// first. Only ever promotes owners; never touches other users or demotes anyone.
// A consequence worth knowing: an owner can't be parked at User Admin — being an
// owner means Business Admin, or the lockout this guards against comes back.
function reconcileSeedAdmins(items: User[], ws: string): boolean {
  const emails = ownerEmails();
  const names = ownerNames();
  let changed = false;
  for (const u of items) {
    if (u.workspaceId !== ws || u.removed) continue;
    if (isBusinessAdminRole(u.role)) continue;
    if (!emails.has(norm(u.email)) && !names.has(norm(u.name))) continue;
    u.role = 'Business Admin';
    changed = true;
  }
  return changed;
}

// Recognise a row that predates the practice/client split as one of the firm's
// own people: the seeded team (matched by id, canonical email, or name — two of
// them sign in with personal addresses), anyone named in OWNER_EMAILS, and any
// address on the practice's own domain. Only ever consulted once per row; after
// that, membership is whatever the Colleagues page says.
function looksLikePracticeMember(u: User): boolean {
  if (SEED_IDS.has(u.id)) return true;
  const email = norm(u.email);
  if (!email) return false;
  if (ownerEmails().has(email)) return true;
  if (SEED_EMAIL_BY_NAME.get(norm(u.name)) === email) return true;
  const domain = norm(env.PRACTICE_DOMAIN);
  return Boolean(domain) && email.endsWith(`@${domain}`);
}

// Backfill practice membership + client access onto rows written before either
// existed, and keep the account owners able to run the practice. Runs on every
// load, but decides membership for a given row exactly once (`practice` becomes
// a boolean and is then left alone) so an admin's later "this person is a client
// employee, not a colleague" is never undone. Migrated colleagues keep working
// on the entity they were already in; owners get every client, present and
// future, which is also the guard against locking the practice out of itself.
function assignPractice(items: User[], ws: string): boolean {
  const owners = ownerEmails();
  let changed = false;
  for (const u of items) {
    if (u.workspaceId !== ws || u.removed) continue;
    if (typeof u.practice !== 'boolean') {
      u.practice = looksLikePracticeMember(u);
      changed = true;
    }
    if (!u.practice) {
      if (u.clientAccess?.length || u.allClients) {
        u.clientAccess = [];
        u.allClients = false;
        changed = true;
      }
      continue;
    }
    if (!u.practiceRole) {
      u.practiceRole = isBusinessAdminRole(u.role) ? 'Owner' : 'Standard';
      changed = true;
    }
    if (!Array.isArray(u.clientAccess)) {
      u.clientAccess = u.organisationId ? [u.organisationId] : [];
      changed = true;
    }
    if (typeof u.allClients !== 'boolean') {
      u.allClients = currentPracticeRole(u.practiceRole) === 'Owner';
      changed = true;
    }
    // Break-glass, same spirit as reconcileSeedAdmins: an account owner is
    // always a practice Owner with every client, so no edit can leave the
    // practice with nobody able to manage it.
    if (owners.has(norm(u.email))) {
      if (u.practiceRole !== 'Owner') {
        u.practiceRole = 'Owner';
        changed = true;
      }
      if (!u.allClients) {
        u.allClients = true;
        changed = true;
      }
    }
  }
  return changed;
}

// Return the workspace's users, seeding the real employees on first use and
// keeping the roster de-duplicated (one email per teammate).
export function ensure(ws: string): User[] {
  const items = load();
  let changed = false;
  if (!items.some((u) => u.workspaceId === ws)) {
    // The seed IS the practice's own staff, so they're seeded as colleagues
    // rather than as some client's employees: the account owners with every
    // client, everyone else with the practice's own entity to start from.
    // (assignPractice can't infer this later — `full` writes a concrete
    // `practice: false`, which it then rightly leaves alone.)
    const org = primaryOrgId();
    items.push(
      ...SEED.map((s) => {
        const owner = isBusinessAdminRole(String(s.role));
        return full(
          {
            ...s,
            organisationId: org,
            practice: true,
            practiceRole: owner ? 'Owner' : 'Standard',
            allClients: owner,
            clientAccess: org ? [org] : [],
          },
          ws
        );
      })
    );
    changed = true;
  }
  if (assignOrganisations(items, ws)) changed = true;
  if (ensureGeneralUsers(items, ws)) changed = true;
  if (normalizeRoster(items, ws)) changed = true;
  if (normalizeRoles(items, ws)) changed = true;
  if (reconcileSeedAdmins(items, ws)) changed = true;
  if (assignPractice(items, ws)) changed = true;
  if (ensureEmailHandles(items, ws)) changed = true;
  if (changed) save(items);
  return items;
}

// The roster member for the signed-in caller (by session email), or null in a
// session-less (mock/dev) context. Used for role-based access control.
// Deliberately NOT tenant-scoped: identity and access are account-wide, so an
// admin whose row lives under one organisation keeps their role while working in
// another. Only the roster itself (listing and managing people) is per-tenant.
// Resolve an email to its roster row for this workspace, PREFERRING a practice
// colleague over an entity-employee row when the same email is on both. A
// person's practice identity is their primary one, so a duplicate entity row
// (e.g. one created by mistake) never shadows their colleague login.
export function memberByEmail(ws: string, emailNorm: string): User | null {
  const matches = ensure(ws).filter((u) => u.workspaceId === ws && !u.removed && norm(u.email) === emailNorm);
  if (!matches.length) return null;
  return matches.find((u) => u.practice) ?? matches[0];
}

// Let one person open one client entity.
//
// Client access is an explicit list, so an entity that did not exist when the
// list was written is invisible to everyone but an allClients colleague — the
// person who just CREATED it included. They add "Red Alpha - ST Engineering",
// the dialog closes, and nothing appears in the switcher, with no error to
// explain it. Whoever makes an entity can open it.
//
// Narrow on purpose: it grants exactly the one entity, only to a practice
// colleague (a client employee belongs to their own entity and has no such
// list), and no-ops for anyone who can already open it.
export function grantClientAccess(ws: string, emailNorm: string, orgId: string): boolean {
  if (!emailNorm || !orgId) return false;
  const items = load();
  const user = items.find((u) => u.workspaceId === ws && !u.removed && norm(u.email) === emailNorm && u.practice);
  if (!user || user.allClients) return false;
  const list = Array.isArray(user.clientAccess) ? user.clientAccess : [];
  if (list.includes(orgId)) return false;
  user.clientAccess = [...list, orgId];
  save(items);
  return true;
}

// Is this the entity's general account rather than a person? The general
// account exists to OWN what nobody claimed — a company's own paperwork. Money
// cannot be paid back to it, so a claim made out to it is a claim payable to
// nobody.
export function isGeneralPerson(ws: string, org: string, value: string): boolean {
  const want = norm(value);
  if (!want) return false;
  if (want === norm(GENERAL_USER_NAME)) return true;
  return ensure(ws).some((u) => isGeneralRow(u, ws, org) && (norm(u.name) === want || norm(u.email) === want));
}

export function memberForSession(req: Request): User | null {
  const s = readSession(req);
  if (!s?.email) return null;
  return memberByEmail(workspaceId(req), norm(s.email));
}

// Any admin tier — the coarse "not a Standard user" check. Prefer the two
// specific predicates below wherever a surface belongs to one of them.
export function isAdminRole(role: string | undefined): boolean {
  return currentRole(role) !== 'Standard';
}

// Change account-wide settings (Business settings). Business Admin only.
export function isBusinessAdminRole(role: string | undefined): boolean {
  return currentRole(role) === 'Business Admin';
}

// Add, suspend and edit people (the Users roster). Both admin tiers.
export function canManageUsersRole(role: string | undefined): boolean {
  return isAdminRole(role);
}

// Collapse any legacy role onto the three current ones (Business Admin / User
// Admin / Standard) so the UI only ever shows a valid role. The interim 'Admin'
// tier had full access, so it maps to Business Admin — a migration should never
// quietly take away access someone already has. Anything else (Approver,
// Bookkeeper, blank, …) → Standard.
function currentRole(role: string | undefined): string {
  if (role === 'Business Admin' || role === 'Admin') return 'Business Admin';
  if (role === 'User Admin') return 'User Admin';
  return 'Standard';
}

// Rewrite stored roles to the current three-role scheme in place. Runs on load
// so old rosters self-heal to Business Admin / User Admin / Standard.
function normalizeRoles(items: User[], ws: string): boolean {
  let changed = false;
  for (const u of items) {
    if (u.workspaceId !== ws || u.removed) continue;
    const next = currentRole(u.role);
    if (u.role !== next) {
      u.role = next;
      changed = true;
    }
  }
  return changed;
}

const EDITABLE: (keyof User)[] = ['name', 'firstName', 'lastName', 'email', 'login', 'role', 'mobile', 'privileges', 'deactivated', 'pending', 'organisationId', 'companyId', 'companyName', 'managerId', 'project', 'emailHandle'];

// Who is on the practice team, what they may run, and which clients they may
// open. Only whoever manages the practice may touch these — a client entity's
// own admin runs their staff, not the firm's.
const PRACTICE_EDITABLE: (keyof User)[] = ['practice', 'practiceRole', 'clientAccess', 'allClients'];

// The direct manager to route a claim to, given the claimant's display name.
// Resolves the claimant's row, then their managerId to a roster member. Returns
// the approver's { name, email } or null when no manager is set / found.
export function directManagerFor(ws: string, claimantName: string): { name: string; email: string } | null {
  const key = norm(claimantName);
  if (!key) return null;
  const items = ensure(ws);
  const claimant = items.find((u) => u.workspaceId === ws && !u.removed && norm(u.name) === key);
  if (!claimant?.managerId) return null;
  const manager = items.find((u) => u.workspaceId === ws && !u.removed && u.id === claimant.managerId);
  if (!manager) return null;
  return { name: manager.name, email: manager.email };
}

// The roster email for a display name (e.g. a claim's `claimFor`), so a claimant
// can be notified of a decision. Null when no matching active user has an email.
export function emailForName(ws: string, name: string): string {
  const key = norm(name);
  if (!key) return '';
  const u = ensure(ws).find((x) => x.workspaceId === ws && !x.removed && norm(x.name) === key);
  return u?.email || '';
}

// Apply the editable fields present in `b` onto a user, keeping name in sync
// with first/last. Shared by the add-merge path and PATCH.
function applyEditable(user: User, b: Partial<User>, ws: string) {
  // The roster reports the general account as having no email, so a form that
  // round-trips a row would otherwise save that blank over the identity every
  // document of theirs is stored against.
  const internalEmail = user.general ? user.email : '';
  for (const k of EDITABLE) if (k in b) (user as Record<string, unknown>)[k] = (b as Record<string, unknown>)[k];
  if (internalEmail) user.email = internalEmail;
  if ('firstName' in b || 'lastName' in b) {
    const nm = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    if (nm) user.name = nm;
  }
  // Client access only ever names entities that are actually linked, so an
  // unlinked (or invented) id can't sit on a row granting nothing.
  if ('clientAccess' in b) {
    const wanted = Array.isArray(b.clientAccess) ? b.clientAccess : [];
    user.clientAccess = [...new Set(wanted.map(String))].filter((id) => getOrganisation(ws, id));
  }
  if ('practiceRole' in b) user.practiceRole = currentPracticeRole(user.practiceRole);
  // Moving someone to another organisation relabels the company on their row,
  // so the roster can never show the entity they used to belong to.
  if ('organisationId' in b) {
    user.companyId = user.organisationId;
    user.companyName = getOrganisation(ws, user.organisationId)?.name || '';
  }
}

export type InviteResult = { email: string; name: string; sent: boolean; link?: string; error?: string };

// Invite freshly-created people (best-effort): issue a set-password link and
// email it. The rows are mutated with the token; the caller saves. Shared by the
// Users roster and the practice's Colleagues roster.
export async function sendInvites(
  req: Request,
  created: User[],
  opts: { orgName?: string; message?: string } = {}
): Promise<InviteResult[]> {
  const invites: InviteResult[] = [];
  const inviter = memberForSession(req)?.name || readSession(req)?.name;
  for (const nu of created) {
    // No mailbox to invite: the general account, and anybody added without an
    // address (their identity is internal — see internalEmailFor).
    if (!nu.email || isInternalAddress(nu.email)) continue;
    const raw = issueToken(nu, 'invite');
    nu.invitedAt = new Date().toISOString();
    const link = resetUrl(req, raw);
    const mail = inviteEmail({
      name: nu.name,
      url: link,
      inviterName: inviter,
      expiresInDays: env.INVITE_TTL_DAYS,
      orgName: opts.orgName || '',
      message: opts.message || '',
    });
    const result = await sendMail({ to: { email: nu.email, name: nu.name }, ...mail }).catch(
      (e): { sent: boolean; error?: string } => ({ sent: false, error: e instanceof Error ? e.message : String(e) })
    );
    invites.push({
      email: nu.email,
      name: nu.name,
      sent: Boolean(result.sent),
      // Surface WHY it didn't send (SMTP rejection, not-configured, etc.) so
      // the admin isn't left guessing, plus the link they can share by hand.
      error: result.sent ? undefined : (result as { error?: string }).error,
      link: result.sent ? undefined : link,
    });
  }
  return invites;
}

export const usersRouter = Router();

// GET /api/users — the selected organisation's OWN people. Tenant-scoped, so
// switching organisations switches the roster (and with it the direct-manager
// options) instead of showing every entity's staff in one list. Practice
// colleagues are deliberately absent: they aren't this client's employees, they
// work across clients, and they have their own roster at /api/practice.
// GET /api/users/directory — every person who could own a document in the
// entity the caller has open, as { email, name }. Deliberately separate from
// GET / (the roster), which is client employees only.
usersRouter.get('/directory', (req, res) => {
  res.json({ people: peopleForOrg(workspaceId(req), orgScope(req)) });
});

usersRouter.get('/', (req, res) => {
  const ws = workspaceId(req);
  const org = orgScope(req);
  res.json({
    users: ensure(ws)
      .filter((u) => u.workspaceId === ws && !u.removed && !u.practice && inOrg(u, org))
      .map(publicUser),
  });
});

// GET /api/users/me — the signed-in user's membership status, used to gate the
// app: 'anonymous' (no session), 'none' (signed in but no roster profile — send
// to /join), 'pending' (awaiting approval), 'deactivated', or 'active'. The
// access flags are the server's own verdict — `businessAdmin` for account-wide
// settings, `canManageUsers` for the roster, `admin` for either — and the client
// trusts them rather than re-deriving access from the role string, so the two
// can't disagree.
usersRouter.get('/me', (req, res) => {
  const session = readSession(req);
  // No `admin` field on the identity-less branches: the client's fallback
  // (open when Google auth isn't configured) has to stay in charge there, or
  // mock/dev mode would lose its admin surfaces.
  if (!session?.email) return res.json({ status: 'anonymous', user: null });
  const ws = workspaceId(req);
  const email = norm(session.email);
  // Prefer the practice row on a duplicate email, so a colleague's login lands
  // on their colleague identity (Colleagues/Clients) rather than a stray entity row.
  const user = memberByEmail(ws, email);
  if (!user) return res.json({ status: 'none', user: null });
  const status = user.deactivated ? 'deactivated' : user.pending ? 'pending' : 'active';
  const live = status === 'active';
  // Access is answered for the entity the caller currently has open, because a
  // colleague's rights come from client access rather than from their own row:
  // Business Admin inside an assigned client, nothing at all outside one.
  const role = effectiveRoleFor(user, orgScope(req));
  return res.json({
    status,
    user: publicUser(user),
    admin: live && isAdminRole(role),
    businessAdmin: live && isBusinessAdminRole(role),
    canManageUsers: live && canManageUsersRole(role),
    // The practice surfaces (Colleagues, Clients) — practice team only.
    practice: live && Boolean(user.practice),
    managePractice: live && canManagePractice(user),
  });
});

// GET /api/users/join/people?orgId= — the people an admin has already added to
// this company who have never signed in.
//
// The admin types somebody's name and role when they add them; asking that
// person to type it all again on the join form invites a second, differently
// spelled row for the same human — and the documents they already own stay on
// the first one. So the join form offers the admin's list instead: pick
// yourself, and your request attaches to the row that already exists.
//
// Names and roles only. It is readable by anyone signed in (a person joining is
// by definition not yet a member), so it must not leak addresses or say
// anything about people who can already sign in.
usersRouter.get('/join/people', (req, res) => {
  // Mock/dev has no sessions at all, and stays open like every other route.
  if (googleEnabled && !readSession(req)) return res.status(401).json({ error: 'unauthenticated' });
  const ws = workspaceId(req);
  const org = String(req.query.orgId ?? '').trim();
  if (!org || !getOrganisation(ws, org)) return res.json({ people: [] });
  const people = ensure(ws)
    .filter(
      (u) =>
        u.workspaceId === ws &&
        !u.removed &&
        !u.deactivated &&
        !u.general &&
        !u.practice &&
        (u.organisationId || '') === org &&
        // Never anybody with a real address: that is somebody else's identity,
        // and claiming it is how you would sign in as them.
        isInternalAddress(u.email)
    )
    .map((u) => ({ id: u.id, name: u.name, role: u.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ people });
});

// POST /api/users/join — self-signup onboarding. The signed-in user submits
// their details and the company (organisation) they belong to; they become a
// pending roster member until an admin approves. Idempotent: re-joining updates
// the same row, and an already-active member is left untouched.
usersRouter.post('/join', (req, res) => {
  const session = readSession(req);
  if (!session?.email) return res.status(401).json({ error: 'unauthenticated' });
  const ws = workspaceId(req);
  const items = ensure(ws);
  const email = norm(session.email);
  const b = req.body ?? {};
  const firstName = String(b.firstName || '').trim();
  const lastName = String(b.lastName || '').trim();
  const companyId = String(b.companyId || '').trim();
  const fields = {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || session.name || session.email,
    mobile: String(b.mobile || '').trim(),
    // The company they picked IS the tenant they join, when it names a linked
    // organisation; a free-typed company name (nothing linked yet) falls back to
    // the primary organisation so the request still reaches an admin's roster.
    organisationId: companyId && getOrganisation(ws, companyId) ? companyId : primaryOrgId(),
    companyId,
    companyName: String(b.companyName || '').trim(),
    role: String(b.role || 'Standard'),
  };
  // Claiming the row an admin already made for them (see GET /join/people).
  // Their name and role are the ADMIN's — that is what the documents this
  // person already owns are filed under, and re-typing it is how the same human
  // ends up on the roster twice.
  const claimId = String(b.claimId || '').trim();
  const claimed = claimId
    ? items.find(
        (u) =>
          u.workspaceId === ws &&
          u.id === claimId &&
          !u.removed &&
          !u.general &&
          !u.practice &&
          isInternalAddress(u.email)
      )
    : null;
  if (claimed) {
    const previousIdentity = claimed.email;
    // A stray row from an earlier attempt is the same person; one email must
    // resolve to exactly one row, so it steps aside rather than becoming a twin.
    for (const u of items) {
      if (u.workspaceId === ws && u.id !== claimed.id && !u.removed && norm(u.email) === email) u.removed = true;
    }
    claimed.email = session.email;
    claimed.pending = true;
    claimed.login = 'No';
    claimed.deactivated = false;
    if (fields.mobile) claimed.mobile = fields.mobile;
    save(items);
    // The documents they already own move with them.
    const moved = reassignPerson(dataScopeForOrg(claimed.organisationId || ''), previousIdentity, claimed.email);
    return res.json({ status: 'pending', user: publicUser(claimed), documentsMoved: moved });
  }

  let user = items.find((u) => u.workspaceId === ws && !u.removed && norm(u.email) === email);
  if (user) {
    if (!user.pending && user.login === 'Yes' && !user.deactivated) {
      return res.json({ status: 'active', user: publicUser(user) }); // already a member
    }
    Object.assign(user, fields, { email: session.email, login: 'No', pending: true, deactivated: false });
  } else {
    user = full({ ...fields, email: session.email, login: 'No', pending: true }, ws);
    items.unshift(user);
  }
  save(items);
  return res.json({ status: 'pending', user: publicUser(user) });
});

// POST /api/users/:id/approve — an admin (signed in) approves a pending member,
// granting access.
usersRouter.post('/:id/approve', (req, res) => {
  if (!readSession(req)) return res.status(401).json({ error: 'unauthenticated' });
  return mutate(req, res, (user) => {
    user.pending = false;
    user.deactivated = false;
    user.login = 'Yes';
  });
});

// Add one or many users. Body: a user object, or { users: [...] }, plus an
// optional top-level `notify` (default true) to email each new user an invite.
// An incoming email that ALREADY belongs to a teammate is reported back in
// `duplicates` (not silently merged) so the UI can warn "this user already
// exists". New users with an email get an invitation link (emailed when mail is
// configured, else the link is returned so an admin can share it).
usersRouter.post('/', async (req, res) => {
  const ws = workspaceId(req);
  const org = orgScope(req);
  const orgLabel = getOrganisation(ws, org)?.name || '';
  const items = ensure(ws);
  const incoming: Partial<User>[] = Array.isArray(req.body?.users) ? req.body.users : [req.body ?? {}];
  const notify = req.body?.notify !== false;
  const orgName = String(req.body?.orgName || '').trim();
  const message = String(req.body?.message || '').trim();
  const created: User[] = [];
  const duplicates: Array<{ email: string; name: string; organisationName: string }> = [];
  for (const u of incoming) {
    const email = norm(String(u.email || ''));
    if (email) {
      // Checked across the whole account, not just this organisation: sign-in is
      // by email, so one address must resolve to exactly one person. Report
      // which organisation already has them so the admin knows where to look.
      const dup = items.find((x) => x.workspaceId === ws && !x.removed && norm(x.email) === email);
      if (dup) {
        duplicates.push({
          email: dup.email,
          name: dup.name,
          organisationName: getOrganisation(ws, dup.organisationId)?.name || dup.companyName || '',
        });
        continue;
      }
    }
    // Somebody added without an email still has to be a person the app can
    // name: they own documents and claims are made out to them. They get an
    // internal identity rather than a blank, and no login — there is no address
    // to sign in with.
    const displayName = (String(u.name || '') || `${u.firstName || ''} ${u.lastName || ''}`).trim();
    const identity = email || internalEmailFor(org, displayName, new Set(items.map((x) => norm(x.email))));
    // Stamped with the selected organisation — an admin adds people to the
    // entity they are currently working in.
    const newUser = full(
      {
        ...u,
        id: undefined,
        email: identity,
        login: email ? u.login : 'No',
        general: false,
        organisationId: org,
        companyId: u.companyId || org,
        companyName: u.companyName || orgLabel,
      },
      ws
    );
    items.unshift(newUser);
    created.push(newUser);
  }
  const invites = notify ? await sendInvites(req, created, { orgName, message }) : [];
  save(items);
  res.json({ users: created.map(publicUser), duplicates, invites });
});

// POST /api/users/login — non-Google sign-in with email + password. Issues the
// same session cookie as Google, so the rest of the app works unchanged.
usersRouter.post('/login', (req, res) => {
  const ws = workspaceId(req);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });
  const user = ensure(ws).find(
    (u) => u.workspaceId === ws && !u.removed && !u.deactivated && u.email.toLowerCase() === email
  );
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'invalid_login' });
  }
  setSession(res, { sub: user.id, email: user.email, name: user.name });
  return res.json({ user: publicUser(user) });
});

// --- Account email flows (invite / reset / change password) -------------------
// All of these mint a single-use link and mail it via Microsoft Graph. When
// mail isn't configured the link is still created and returned to the admin, so
// onboarding works before (or during an outage of) the mail setup.

const MIN_PASSWORD = 8;

// Only Business/User Admins may invite or reset someone else's account — both
// tiers run the roster, which is the whole point of User Admin. In mock/dev (no
// session-backed roster member) the check is skipped, matching the rest of the
// app's dev-open posture.
function requireAdmin(req: Request, res: Response): boolean {
  if (!readSession(req)) {
    res.status(401).json({ error: 'unauthenticated' });
    return false;
  }
  const me = memberForSession(req);
  if (me && !canManageUsersRole(effectiveRoleFor(me, orgScope(req))) && !canManagePractice(me)) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// POST /api/users/:id/invite — email a user an invitation to set their password
// and activate their account. Also used by "Resend Invitation": re-issuing
// simply replaces any previous link. Responds with { sent, link } — the link is
// echoed back so an admin can pass it on when mail is off or delivery failed.
// POST /api/users/:id/dismiss-forward — clear the pending Gmail forwarding
// confirmation once the user has clicked it (or it's no longer wanted).
usersRouter.post('/:id/dismiss-forward', (req, res) => {
  const ws = workspaceId(req);
  const user = ensure(ws).find((u) => u.id === req.params.id && u.workspaceId === ws && !u.removed);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const updated = clearPendingForward(user.id);
  return res.json({ user: updated ? publicUser(updated) : publicUser(user) });
});

usersRouter.post('/:id/invite', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ws = workspaceId(req);
  const items = ensure(ws);
  const user = items.find((u) => u.id === req.params.id && u.workspaceId === ws && !u.removed && reachable(u, req));
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (!user.email) return res.status(400).json({ error: 'no_email' });

  const raw = issueToken(user, 'invite');
  user.invitedAt = new Date().toISOString();
  save(items);

  const link = resetUrl(req, raw);
  const inviter = memberForSession(req)?.name || readSession(req)?.name;
  const mail = inviteEmail({ name: user.name, url: link, inviterName: inviter, expiresInDays: env.INVITE_TTL_DAYS });
  const { sent, error } = await sendMail({ to: { email: user.email, name: user.name }, ...mail });

  return res.json({ sent, error, link, email: user.email, user: publicUser(user) });
});

// POST /api/users/forgot-password — public. Emails a reset link. Always answers
// 200 with the same body so the endpoint can't be used to discover which email
// addresses have accounts.
usersRouter.post('/forgot-password', async (req, res) => {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const email = norm(String(req.body?.email || ''));
  const user = email
    ? items.find((u) => u.workspaceId === ws && !u.removed && !u.deactivated && norm(u.email) === email)
    : undefined;

  if (user) {
    const raw = issueToken(user, 'reset');
    save(items);
    const mail = passwordResetEmail({ name: user.name, url: resetUrl(req, raw), expiresInDays: env.INVITE_TTL_DAYS });
    await sendMail({ to: { email: user.email, name: user.name }, ...mail });
  }
  return res.json({ ok: true });
});

// GET /api/users/reset/:token — public. Validates an invite/reset link so the
// set-password page can greet the recipient (or explain that it has expired).
usersRouter.get('/reset/:token', (req, res) => {
  const user = findByToken(ensure(workspaceId(req)), String(req.params.token || ''));
  if (!user) return res.status(404).json({ valid: false, error: 'invalid_or_expired' });
  return res.json({ valid: true, kind: user.resetTokenKind ?? 'reset', name: user.name, email: user.email });
});

// POST /api/users/reset — public. Consumes an invite/reset link and sets the
// chosen password. The token is single-use; accepting an invitation also grants
// login access, so the recipient lands straight in the app with a session.
usersRouter.post('/reset', async (req, res) => {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const password = String(req.body?.password || '');
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'weak_password' });

  const user = findByToken(items, String(req.body?.token || ''));
  if (!user) return res.status(400).json({ error: 'invalid_or_expired' });

  const wasInvite = user.resetTokenKind === 'invite';
  user.passwordHash = hashPassword(password);
  clearToken(user);
  if (wasInvite) {
    // An admin-issued invitation is itself the approval.
    user.login = 'Yes';
    user.pending = false;
    user.deactivated = false;
  }
  save(items);

  // Sign them straight in. Skipped in mock/dev, where no SESSION_SECRET is
  // configured to sign a cookie with (the app is open there anyway).
  if (env.SESSION_SECRET) setSession(res, { sub: user.id, email: user.email, name: user.name });
  const mail = passwordChangedEmail({ name: user.name });
  await sendMail({ to: { email: user.email, name: user.name }, ...mail });
  return res.json({ user: publicUser(user) });
});

// POST /api/users/password — the signed-in user changes their OWN password.
// The current password is required when one is already set; a user who signed
// in with Google and has never set one can just choose it (the session is proof
// enough).
usersRouter.post('/password', async (req, res) => {
  const session = readSession(req);
  if (!session?.email) return res.status(401).json({ error: 'unauthenticated' });
  const ws = workspaceId(req);
  const items = ensure(ws);
  const user = items.find((u) => u.workspaceId === ws && !u.removed && norm(u.email) === norm(session.email));
  if (!user) return res.status(404).json({ error: 'not_found' });

  const next = String(req.body?.newPassword || '');
  if (next.length < MIN_PASSWORD) return res.status(400).json({ error: 'weak_password' });
  if (user.passwordHash && !verifyPassword(String(req.body?.currentPassword || ''), user.passwordHash)) {
    return res.status(400).json({ error: 'wrong_current_password' });
  }

  user.passwordHash = hashPassword(next);
  clearToken(user); // a password change retires any outstanding reset link
  save(items);

  const mail = passwordChangedEmail({ name: user.name });
  await sendMail({ to: { email: user.email, name: user.name }, ...mail });
  return res.json({ user: publicUser(user) });
});

// POST /api/users/:id/password — an admin sets a user's password directly (the
// break-glass path when someone can't receive email). The account owner is
// notified by email that it happened, and by whom.
usersRouter.post('/:id/password', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const password = String(req.body?.password || '');
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'weak_password' });

  const ws = workspaceId(req);
  const items = ensure(ws);
  const user = items.find((u) => u.id === req.params.id && u.workspaceId === ws && reachable(u, req));
  if (!user) return res.status(404).json({ error: 'not_found' });

  user.passwordHash = hashPassword(password);
  clearToken(user);
  save(items);

  const by = memberForSession(req)?.name || readSession(req)?.name;
  const mail = passwordChangedEmail({ name: user.name, by });
  const { sent } = user.email
    ? await sendMail({ to: { email: user.email, name: user.name }, ...mail })
    : { sent: false };
  return res.json({ user: publicUser(user), notified: sent });
});

// A direct manager is the colleague a claim routes to for approval, so it only
// makes sense within one organisation. Moving someone to another entity drops
// their own manager and detaches anyone who reported to them, rather than
// leaving approvals pointing across a tenant boundary.
function detachManagerLinks(items: User[], moved: User) {
  moved.managerId = '';
  for (const u of items) {
    if (u.managerId === moved.id && !inOrg(u, moved.organisationId)) u.managerId = '';
  }
}

// Roster edits are tenant-scoped: someone else's row is only reachable from the
// organisation it belongs to, so an id from one entity can't be edited while
// another is selected. Your OWN row is always reachable — editing your profile
// (Profile page, own password) can't depend on which client entity you happen to
// have open.
function mutate(req: Request, res: Response, fn: (u: User, items: User[]) => void) {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const user = items.find((u) => u.id === req.params.id && u.workspaceId === ws && reachable(u, req));
  if (!user) return res.status(404).json({ error: 'not_found' });
  fn(user, items);
  save(items);
  return res.json({ user: publicUser(user) });
}

// Fields a non-admin may change on their OWN profile. Everything else (role,
// login, deactivation, company, manager, …) needs roster rights — otherwise any
// signed-in user could PATCH themselves to Business Admin.
const SELF_EDITABLE: (keyof User)[] = ['name', 'firstName', 'lastName', 'mobile'];

usersRouter.patch('/:id', (req, res) => {
  const session = readSession(req);
  const me = session ? memberForSession(req) : null;
  // Judged by the caller's role in the entity they have open, so a colleague
  // manages the roster of a client they've been given, and of no other.
  const admin = me ? canManageUsersRole(effectiveRoleFor(me, orgScope(req))) || canManagePractice(me) : !session; // sessionless mock stays open
  const isSelf = Boolean(me && me.id === req.params.id);
  if (!admin && !isSelf) return res.status(403).json({ error: 'forbidden' });
  const practiceAdmin = me ? canManagePractice(me) : !session;
  const allowed = admin ? (practiceAdmin ? [...EDITABLE, ...PRACTICE_EDITABLE] : EDITABLE) : SELF_EDITABLE;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filtered: Partial<User> = {};
  for (const k of allowed) if (k in body) (filtered as Record<string, unknown>)[k] = body[k];
  // The inbound address is chosen by hand now, so it has to be checked. Two
  // people on one handle is not a cosmetic clash: every bill forwarded to it
  // would file under whichever row was found first, silently and for good.
  if ('emailHandle' in filtered) {
    const handle = normaliseHandle(String(filtered.emailHandle ?? ''));
    if (!handle) return res.status(400).json({ error: 'invalid_handle' });
    const owner = userByEmailHandle(handle);
    if (owner && owner.id !== req.params.id) {
      return res.status(409).json({ error: 'handle_taken', handle, takenBy: owner.name || owner.email });
    }
    filtered.emailHandle = handle;
  }
  return mutate(req, res, (user, items) => {
    const risk = lockoutRisk(
      workspaceId(req),
      user,
      { deactivated: filtered.deactivated === true, practiceRole: filtered.practiceRole },
      me?.id || ''
    );
    if (risk) return res.status(409).json({ error: 'would_lock_out', message: risk });
    const from = user.organisationId;
    applyEditable(user, filtered, workspaceId(req));
    if (user.organisationId !== from) detachManagerLinks(items, user);
  });
});

usersRouter.post('/:id/active', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const me = memberForSession(req);
  return mutate(req, res, (user) => {
    const risk =
      req.body?.active === false
        ? lockoutRisk(workspaceId(req), user, { deactivated: true }, me?.id || '')
        : '';
    if (risk) return res.status(409).json({ error: 'would_lock_out', message: risk });
    user.deactivated = req.body?.active === false;
  });
});

usersRouter.delete('/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const me = memberForSession(req);
  return mutate(req, res, (user) => {
    const risk = lockoutRisk(workspaceId(req), user, { removed: true }, me?.id || '');
    if (risk) return res.status(409).json({ error: 'would_lock_out', message: risk });
    user.removed = true;
  });
});
