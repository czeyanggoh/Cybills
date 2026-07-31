import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId, actor } from './workspace.js';

// Support Desk boards — Support tickets, Feature requests, and the Testing
// checklist — now server-backed + shared across the workspace (same JSON-store
// pattern as claims/users). So when one person files a ticket, everyone sees it.

type Comment = { author: string; text: string; created_at: string; screenshots: string[] };
type Item = {
  id: string;
  workspaceId: string;
  board: string; // 'support' | 'features' | 'testing'
  text: string;
  screenshots: string[];
  status: string; // 'open' | 'done' | 'closed'
  author: string;
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

// Seed the testing board once per workspace, in checklist order.
function ensure(ws: string, board: string): Item[] {
  const items = load();
  if (board === 'testing' && !items.some((x) => x.workspaceId === ws && x.board === 'testing')) {
    TESTING_SEED.forEach((s, i) => {
      items.push({
        id: randomUUID(), workspaceId: ws, board: 'testing', text: s.text, screenshots: [],
        status: s.status || 'open', author: '', created_at: nowIso(), comments: [], assignee: null, seq: i, deleted: false,
      });
    });
    save(items);
  }
  return items;
}

export const boardRouter = Router();

// GET /api/board/:board — the board's items. Checklist keeps seed order; tickets
// and feature requests newest-first.
boardRouter.get('/:board', (req, res) => {
  const ws = workspaceId(req);
  const board = req.params.board;
  const rows = ensure(ws, board).filter((x) => x.workspaceId === ws && x.board === board && !x.deleted);
  rows.sort((a, b) => (board === 'testing' ? a.seq - b.seq : b.created_at.localeCompare(a.created_at)));
  res.json({ items: rows });
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
  const item: Item = {
    id: randomUUID(), workspaceId: ws, board: req.params.board,
    text: String(b.text || ''),
    screenshots: Array.isArray(b.screenshots) ? b.screenshots : [],
    status: 'open', author: b.author || me.name, created_at: createdAt, comments: [], assignee: null,
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

  const items = ensure(ws, board);
  const mine = items.filter((x) => x.workspaceId === ws && x.board === board && !x.deleted);
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
      id: randomUUID(), workspaceId: ws, board, text, screenshots, status,
      author: String(raw.author || ''), created_at, comments, assignee,
      seq: maxSeq + 1 + imported, deleted: false,
    };
    items.push(item);
    if (text) byText.set(norm(text), item);
    imported++;
  }

  if (imported || merged) save(items);
  res.json({ imported, merged, skipped: incoming.length - imported - merged });
});

function mutate(req: Request, res: Response, fn: (item: Item, me: { email: string; name: string }) => void) {
  const ws = workspaceId(req);
  const items = load();
  const item = items.find((x) => x.id === req.params.id && x.workspaceId === ws && x.board === req.params.board);
  if (!item) return res.status(404).json({ error: 'not_found' });
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
