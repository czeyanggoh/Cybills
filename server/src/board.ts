import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId, actor } from './workspace.js';
import { getOrganisation } from './organisations.js';
import {
  canAccessOrg, emailForName, isPracticeColleague, memberByEmail, memberForSession,
  normaliseAddress, orgScope, seesEveryIssue, type User,
} from './users.js';

// Support Desk boards — Support tickets, Feature requests, and the Testing
// checklist — server-backed (same JSON-store pattern as claims/users).
//
// They were shared across the whole WORKSPACE, which is one room for every
// client at once: an issue raised by one company's bookkeeper, with a
// screenshot of that company's book attached to it, was read by every other
// company's staff. Every issue now names the entity it was raised IN and the
// person who raised it, and `canSee` below is the whole of who gets it.

type Comment = { author: string; text: string; created_at: string; screenshots: string[] };
type Item = {
  id: string;
  workspaceId: string;
  orgId: string; // the client entity it was raised in ('' = the practice's own)
  board: string; // 'support' | 'features' | 'testing'
  text: string;
  screenshots: string[];
  status: string; // 'open' | 'done' | 'closed'
  author: string; // display NAME, as the roster spelt it the day it was raised
  createdBy: string; // the raiser's ADDRESS — an identity, and never rewritten
  created_at: string;
  comments: Comment[];
  assignee: { id: string; name: string } | null;
  seq: number; // stable ordering (seed order for the checklist)
  deleted: boolean;
};

const COLLECTION = 'board_items';
const load = () => loadCollection<Item>(COLLECTION);
const save = (items: Item[]) => saveCollection(COLLECTION, items);
const nowIso = () => new Date().toISOString();

// The Testing checklist seed (moved server-side so it's shared). A–K workflow
// checks plus the Dext parity checks ('done' = verified pass).
const TESTING_SEED: Array<{ text: string; status?: string }> = [
  { text: 'A · Costs: upload a receipt (Add documents) — it reads (OCR) and lands in the Inbox as “New”.' },
  { text: 'A · Costs: open the receipt detail — image on the left, extracted fields on the right.' },
  { text: 'B · Cost detail: Category dropdown lists the Xero chart + the CSV Lists categories.' },
  { text: 'B · Cost detail: Customer & Project dropdowns are populated; the Paid toggle switches Yes/No.' },
  { text: 'B · Cost detail: Add payment method — the Bank account list is synced from Xero.' },
  { text: 'B · Cost detail: Split the receipt across two categories.' },
  { text: 'B · Costs: move an item through the pipeline (Inbox → To review → Ready).' },
  { text: 'C · Sales: upload a receipt — the drawer defaults to Sales and the item appears under Processing.' },
  { text: 'C · Sales: click Move to inbox — it lands in the Inbox with a green “New” dot.' },
  { text: 'C · Sales detail: Set customer rules (+ Smart split), Add category, Add payment method.' },
  { text: 'C · Sales detail: History tab shows uploaded → processing → viewed (+ any category change).' },
  { text: 'D · Business settings → Lists: add or hide a Category → it appears/disappears in the Cost/Sales dropdowns.' },
  { text: 'D · Lists: Tax rates (21) and Projects show; add a project → it appears in every Project dropdown.' },
  { text: 'E · Sales → Customers: set a Category and Project per customer (persists on reload).' },
  { text: 'E · Costs → Suppliers: set a Category and Customer per supplier (persists on reload).' },
  { text: 'F · Expense claims: add selected costs to a claim (new or existing).' },
  { text: 'F · Expense claim: Submit for approval — the ✕ closes the dialog even with the approver dropdown open.' },
  { text: 'F · Expense claim: PDF preview (with approval-history page) + Export (CSV/PDF).' },
  { text: 'G · Vault: upload a file → it previews on the detail page; Subject & Summary auto-fill.' },
  { text: 'G · Vault: Copy to Costs and Copy to Sales from a file — it appears in each inbox.' },
  { text: 'G · Vault: Manage access (general + per-user); Tags (Add tags); Downloads records a ZIP archive.' },
  { text: 'H · Bank → Accounts: Add bank account (2-step wizard) + Request your bank sub-dialog.' },
  { text: 'H · Bank → Statements: Set up an Integration → lands on Business settings → Connections.' },
  { text: 'I · Users: Add a user — Login access off hides Email, on makes it required; 3-step add completes.' },
  { text: 'I · Users: Manage → Deactivate/Reactivate and Edit user details.' },
  { text: 'J · Profile: Change email + Change password; Bookkeeping toggles and Approval dropdowns persist.' },
  { text: 'K · Exports: Export all (CSV / PDF / ZIP) → the file appears in the Exports tab and Download works.' },
  { text: 'DEXT · Capture: drag & drop files onto Add documents → uploads and lands in the inbox. ✅ verified', status: 'done' },
  { text: 'DEXT · Extraction: OCR/AI reads supplier, amount, tax & date from the receipt. ✅ verified (prod, Claude Vision)', status: 'done' },
  { text: 'DEXT · Categorize: extraction auto-assigns a Category from the live Xero chart. ✅ verified', status: 'done' },
  { text: 'DEXT · Expense mgmt: create an expense claim → Submit for approval → Approve. ✅ verified', status: 'done' },
  { text: 'DEXT · Expense mgmt: approved claim → Send to HR for payment routes the payable to CYHR. ✅ verified end-to-end', status: 'done' },
  { text: '⚠️ MANUAL — Capture: snap a receipt photo from your phone browser camera (responsive web; no native app). Test on your phone.' },
  { text: '⚠️ MANUAL — Sync: Publish to Xero on a cost pushes the bill via the cyworkspace relay. Needs a connected Xero org — confirm the bill appears in Xero.' },
  { text: "🚧 GAP — Capture by email: the Extract-by-Email addresses shown in Add documents are display-only; email ingestion isn't wired." },
  { text: '🚧 GAP — Auto-fetch bills from online suppliers: not built (Dext connects to supplier portals).' },
  { text: '🚧 GAP — Sync to QuickBooks / Sage: not built (CYBills syncs to Xero only).' },
  { text: '🚧 GAP — Mileage tracking: not built (record business travel + compute travel costs).' },
  { text: '🚧 GAP — Bank reconciliation vs a live bank feed: not built (Bank section stores accounts/statements; no live-feed matching).' },
];

// Seed the testing board once per workspace, in checklist order. It is the
// practice's own QA list — nobody raised it and it names no client — so it
// carries no entity and no raiser, which is exactly what makes it the
// practice's to see.
function ensure(ws: string, board: string): Item[] {
  const items = load();
  if (board === 'testing' && !items.some((x) => x.workspaceId === ws && x.board === 'testing')) {
    TESTING_SEED.forEach((s, i) => {
      items.push({
        id: randomUUID(), workspaceId: ws, orgId: '', board: 'testing', text: s.text, screenshots: [],
        status: s.status || 'open', author: '', createdBy: '', created_at: nowIso(), comments: [], assignee: null, seq: i, deleted: false,
      });
    });
    save(items);
  }
  return items;
}

// --- Who sees which issue ----------------------------------------------------
// The caller, as the three questions this board asks of them: who they are, the
// entity they are standing in, and whether they run it.
type Viewer = {
  me: User | null;
  email: string;
  org: string;
  practice: boolean;
  everyIssueHere: boolean;
};

function viewerFor(req: Request): Viewer {
  const me = memberForSession(req);
  const org = orgScope(req);
  return {
    me,
    // The address they signed in under, which is the identity an issue is
    // raised against. Off the SESSION rather than the roster row alone, so
    // somebody who has not been added to a roster yet still owns what they
    // raise once they are.
    email: normaliseAddress(me?.email || actor(req).email),
    org,
    practice: isPracticeColleague(me),
    everyIssueHere: seesEveryIssue(me, org),
  };
}

// An issue is visible three ways, and only two of them are shared.
function canSee(item: Item, v: Viewer): boolean {
  if (!v.me) return true; // the sessionless mock/dev context, open like the rest of the app
  // THEIRS, always — matched on the address they raised it under, which is
  // never rewritten. `author` is a display name and drifts with the roster, so
  // a person renamed on the Users page would otherwise lose their own tickets.
  if (v.email && normaliseAddress(item.createdBy) === v.email) return true;
  // A PRACTICE COLLEAGUE holds client access rather than belonging to one
  // entity, so their desk is every client they can open — plus the issues that
  // name no client at all, which are the practice's own.
  if (v.practice) return item.orgId ? canAccessOrg(v.me, item.orgId) : true;
  // Everybody else is standing in ONE entity. A Business Admin runs its book
  // and sees every issue raised against it; a Standard user sees only the ones
  // above.
  //
  // An issue naming NO entity is the practice's own, unconditionally — the
  // Testing checklist, and anything raised before an issue recorded where. It
  // is never a client's to read, and that holds even where the caller's own
  // scope is '' (nothing linked yet, or their entity since unlinked), which is
  // the one case a bare === would quietly hand it to them.
  return v.everyIssueHere && Boolean(item.orgId) && item.orgId === v.org;
}

// What the caller is looking at, so the board can say so rather than leaving a
// missing ticket to read as a lost one.
const scopeOf = (v: Viewer) => (!v.me || v.practice ? 'clients' : v.everyIssueHere ? 'entity' : 'own');

// A colleague's list spans clients, so an issue from an entity other than the
// one they are standing in says whose it is.
function decorate(item: Item, ws: string, v: Viewer) {
  if (!item.orgId || item.orgId === v.org) return item;
  return { ...item, orgName: getOrganisation(ws, item.orgId)?.name || '' };
}

// The issues raised before an issue recorded who raised it. All they carry is
// `author`, a display NAME — the very thing a roster edit moves — so it is
// resolved back through emailForName, the way a stale claim's claimant is, and
// a name that resolves to nobody is left exactly as it is rather than guessed
// at. Where they were raised was never recorded either, so it is the raiser's
// own entity; a practice colleague's is no client's, which is what '' means.
// Idempotent: a row that already names its raiser is never touched.
function backfillRaisers(ws: string, items: Item[]): Item[] {
  let touched = false;
  for (const x of items) {
    if (x.deleted || x.createdBy || !x.author) continue;
    const email = emailForName(ws, x.author);
    if (!email) continue;
    x.createdBy = email;
    if (!x.orgId) {
      const u = memberByEmail(ws, normaliseAddress(email));
      x.orgId = u && !u.practice ? u.organisationId || '' : '';
    }
    touched = true;
  }
  if (touched) save(items);
  return items;
}

export const boardRouter = Router();

// GET /api/board/:board — the board's items, narrowed to the ones this caller
// may see. Checklist keeps seed order; tickets and feature requests
// newest-first. `scope` says WHICH of the three answers they got, so the page
// can tell somebody they are looking at their own issues instead of leaving
// them to conclude a ticket was lost.
boardRouter.get('/:board', (req, res) => {
  const ws = workspaceId(req);
  const board = req.params.board;
  const v = viewerFor(req);
  const rows = backfillRaisers(ws, ensure(ws, board))
    .filter((x) => x.workspaceId === ws && x.board === board && !x.deleted && canSee(x, v));
  rows.sort((a, b) => (board === 'testing' ? a.seq - b.seq : b.created_at.localeCompare(a.created_at)));
  res.json({
    items: rows.map((x) => decorate(x, ws, v)),
    scope: scopeOf(v),
    orgName: getOrganisation(ws, v.org)?.name || '',
  });
});

// POST /api/board/:board — create an item (ticket / request / extra check).
boardRouter.post('/:board', (req, res) => {
  const ws = workspaceId(req);
  const b = req.body ?? {};
  const me = actor(req);
  // Honor an optional created_at so the one-time localStorage→server migration
  // (older tickets filed before the Support Desk went server-side) keeps its
  // original date instead of all showing "just now".
  const createdAt = typeof b.created_at === 'string' && b.created_at ? b.created_at : nowIso();
  // The entity and the raiser come off the SESSION, never off the body: an
  // address is an identity here, and a client that could name its own would be
  // choosing whose desk the issue lands on.
  const v = viewerFor(req);
  const item: Item = {
    id: randomUUID(), workspaceId: ws, orgId: v.org, board: req.params.board,
    text: String(b.text || ''),
    screenshots: Array.isArray(b.screenshots) ? b.screenshots : [],
    status: 'open', author: b.author || me.name, createdBy: v.email, created_at: createdAt, comments: [], assignee: null,
    seq: Date.now(), deleted: false,
  };
  const items = load();
  items.push(item);
  save(items);
  res.json({ item });
});

// POST /api/board/:board/import — adopt items that predate the server-backed
// board. They lived in one browser's localStorage, so nobody else could ever
// see them; this lifts them into the shared workspace with their original
// timestamp, status, screenshots and replies intact.
//
// Matching is by normalised text, not by id: the Testing checklist was seeded
// client-side with the same wording the server now seeds, so an id/timestamp
// match would import a second copy of all 39 checks. On a match we MERGE
// (adopt screenshots, replies, a done/closed status, an assignee) rather than
// insert, so a ticked-off check that carries screenshot proof keeps it. Both
// paths are idempotent — re-running the migration, or two people migrating the
// same shared browser, adds nothing the board doesn't already have.
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// Cap one import so a corrupted localStorage blob can't balloon the store.
const IMPORT_LIMIT = 500;

function cleanComments(raw: unknown): Comment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => ({
      author: String(c.author || ''),
      text: String(c.text || ''),
      created_at: typeof c.created_at === 'string' && c.created_at ? c.created_at : nowIso(),
      screenshots: Array.isArray(c.screenshots) ? c.screenshots.map(String) : [],
    }))
    .filter((c) => c.text || c.screenshots.length);
}

const commentKey = (c: Comment) => `${c.author} ${c.text} ${c.created_at}`;

boardRouter.post('/:board/import', (req, res) => {
  const ws = workspaceId(req);
  const board = req.params.board;
  const incoming = Array.isArray(req.body?.items) ? req.body.items.slice(0, IMPORT_LIMIT) : [];

  const v = viewerFor(req);
  const items = backfillRaisers(ws, ensure(ws, board));
  // Only ever merge into an item this caller can already see. Matching on text
  // against the whole board would let one company's migration quietly adopt
  // another's ticket — and hand it their screenshots.
  const mine = items.filter((x) => x.workspaceId === ws && x.board === board && !x.deleted && canSee(x, v));
  const byText = new Map(mine.map((x) => [norm(x.text), x]));
  const maxSeq = mine.reduce((m, x) => Math.max(m, x.seq), 0);

  let imported = 0;
  let merged = 0;

  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const text = String(raw.text || '');
    const screenshots = Array.isArray(raw.screenshots) ? raw.screenshots.map(String) : [];
    if (!text && !screenshots.length) continue;

    const created_at = typeof raw.created_at === 'string' && raw.created_at ? raw.created_at : nowIso();
    const status = raw.status === 'done' || raw.status === 'closed' ? raw.status : 'open';
    const assignee =
      raw.assignee && typeof raw.assignee === 'object' && raw.assignee.id
        ? { id: String(raw.assignee.id), name: String(raw.assignee.name || raw.assignee.id) }
        : null;
    const comments = cleanComments(raw.comments);

    const existing = text ? byText.get(norm(text)) : undefined;
    if (existing) {
      let touched = false;
      for (const url of screenshots) {
        if (!existing.screenshots.includes(url)) { existing.screenshots.push(url); touched = true; }
      }
      const seen = new Set(existing.comments.map(commentKey));
      for (const c of comments) {
        if (!seen.has(commentKey(c))) { existing.comments.push(c); seen.add(commentKey(c)); touched = true; }
      }
      // Only ever move an untouched item forward — never re-open something a
      // colleague has since closed on the shared board.
      if (existing.status === 'open' && status !== 'open') { existing.status = status; touched = true; }
      if (!existing.assignee && assignee) { existing.assignee = assignee; touched = true; }
      if (!existing.author && raw.author) { existing.author = String(raw.author); touched = true; }
      if (touched) merged++;
      continue;
    }

    const item: Item = {
      id: randomUUID(), workspaceId: ws, orgId: v.org, board, text, screenshots, status,
      author: String(raw.author || ''), createdBy: v.email, created_at, comments, assignee,
      seq: maxSeq + 1 + imported, deleted: false,
    };
    items.push(item);
    if (text) byText.set(norm(text), item);
    imported++;
  }

  if (imported || merged) save(items);
  res.json({ imported, merged, skipped: incoming.length - imported - merged });
});

// Every write goes through here, so the listing's rule is the board's rule
// rather than a display detail: closing, assigning, replying to and deleting an
// issue all ask the same question the list asked. 404 rather than 403 — whether
// somebody else's ticket exists is itself not the caller's to learn.
function mutate(req: Request, res: Response, fn: (item: Item, me: { email: string; name: string }) => void) {
  const ws = workspaceId(req);
  const items = backfillRaisers(ws, load());
  const item = items.find((x) => x.id === req.params.id && x.workspaceId === ws && x.board === req.params.board);
  if (!item || !canSee(item, viewerFor(req))) return res.status(404).json({ error: 'not_found' });
  fn(item, actor(req));
  save(items);
  return res.json({ item });
}

// PATCH /api/board/:board/:id — status and/or assignee.
boardRouter.patch('/:board/:id', (req, res) =>
  mutate(req, res, (item) => {
    const b = req.body ?? {};
    if (typeof b.status === 'string') item.status = b.status;
    if ('assignee' in b) item.assignee = b.assignee || null;
  })
);

// POST /api/board/:board/:id/comment — reply with text and/or screenshots.
boardRouter.post('/:board/:id/comment', (req, res) =>
  mutate(req, res, (item, me) => {
    const b = req.body ?? {};
    item.comments.push({
      author: b.author || me.name,
      text: String(b.text || ''),
      created_at: nowIso(),
      screenshots: Array.isArray(b.screenshots) ? b.screenshots : [],
    });
  })
);

// DELETE /api/board/:board/:id — soft delete.
boardRouter.delete('/:board/:id', (req, res) => mutate(req, res, (item) => { item.deleted = true; }));
