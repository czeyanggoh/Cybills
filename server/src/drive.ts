import { Router, type Request } from 'express';
import { createHash } from 'node:crypto';
import { env, googleEnabled } from './env.js';
import {
  ensure as ensureUsers,
  memberForSession,
  canAccessOrg,
  canManagePractice,
  effectiveRoleFor,
  isBusinessAdminRole,
  isInternalAddress,
  type User,
} from './users.js';
import { dataScopeForOrg, getOrganisation, primaryOrgId } from './organisations.js';
import { insertBill, noteReading } from './store.js';
import { putBillFile } from './storage.js';
import { readerMediaType } from './mediaType.js';
import { readSetting } from './settings.js';
import { resolveProvider } from './llm.js';
import { autoRead } from './inbound.js';
import { workspaceId, WORKSPACE_ID } from './workspace.js';
import {
  driveEnabled,
  robotEmail,
  getFile,
  listChildren,
  downloadFile,
  listPermissionEmails,
  createFolder,
  moveFile,
  DriveError,
  type DriveFileMeta,
} from './driveApi.js';
import {
  loadFolders,
  folderById,
  foldersForOrg,
  foldersForUser,
  connectionOnFolder,
  insertFolder,
  patchFolder,
  fileRow,
  filedAnywhere,
  recordFile,
  recentFiles,
  type DriveFolder,
  type DriveFileRow,
} from './driveFolders.js';

// Bill collection through a Google Drive folder.
//
// The third road a document travels without anybody signing in, beside a
// person's own inbound address and their WhatsApp group, and the same shape as
// both: a pipe that belongs to ONE person, so whatever comes down it is filed
// under them. Somebody shares a folder in their own Drive with CYBills' robot
// and pastes its link on their page; from then on a PDF saved into that folder
// — from a scanner, a phone, a mail client's "Save to Drive" — is a cost
// document in their entity's inbox within a couple of minutes, read exactly as
// an emailed attachment is.
//
// Nothing calls CYBills when a file is saved, so this is one of the two things
// here that run on a clock (the daily digest is the other): every connected
// folder is looked in every DRIVE_POLL_SECONDS. A file is filed ONCE, by its
// Drive id (driveFolders.ts), and then moved into a "Filed" subfolder so the
// folder itself only ever holds what is still waiting — the move is a courtesy
// to the person looking at their Drive, and it may fail without anything being
// filed twice.

// --- The rules both sides share (src/lib/driveFolder.js) -----------------------
type DriveRules = {
  FILED_FOLDER_NAME: string;
  MAX_DRIVE_FILE_BYTES: number;
  folderIdFromLink: (value: unknown) => string;
  folderLinkFor: (id: string) => string;
  isFiledFolder: (file: unknown) => boolean;
  driveSkipReason: (file: unknown) => { ignore: boolean; reason: string };
};

let rules: DriveRules | null = null;
let rulesTried = false;

async function loadRules(): Promise<DriveRules | null> {
  if (rulesTried) return rules;
  rulesTried = true;
  try {
    // From server/dist (or server/src under tsx) up to the repo root.
    const url = new URL('../../src/lib/driveFolder.js', import.meta.url).href;
    const mod = (await import(url)) as Partial<DriveRules>;
    rules =
      typeof mod?.folderIdFromLink === 'function' && typeof mod?.driveSkipReason === 'function'
        ? (mod as DriveRules)
        : null;
  } catch (e) {
    console.error('[drive] rules unavailable', e);
    rules = null;
  }
  return rules;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

// The same filter the email road applies to an attachment.
const IMAGE_OR_PDF = /pdf|png|jpe?g|gif|webp|tiff?|heic/i;

// --- Who ------------------------------------------------------------------------

// One person's own row, and the entity their documents are filed under — the
// rule an emailed document and a WhatsApp group of theirs already follow: their
// own organisation, else the practice's primary one.
function personFor(ws: string, userId: string): { user: User; orgId: string } | null {
  const user = ensureUsers(ws).find((u) => u.id === userId && !u.removed);
  if (!user) return null;
  return { user, orgId: user.organisationId || primaryOrgId() };
}

// Your own folder always; otherwise whoever administers you — the practice for
// a colleague, a Business Admin for a client entity's own staff. The WhatsApp
// group's rule, for the same reason: it is the same kind of pipe.
function mayManagePerson(req: Request, target: User, orgId: string): boolean {
  const me = memberForSession(req);
  if (!me) return !googleEnabled; // dev/mock mode has no session to judge
  if (me.deactivated) return false;
  if (me.id === target.id) return true;
  if (canManagePractice(me)) return true;
  return canAccessOrg(me, orgId) && isBusinessAdminRole(effectiveRoleFor(me, orgId));
}

function mayManageOrg(req: Request, orgId: string): boolean {
  const me = memberForSession(req);
  if (!me) return !googleEnabled;
  if (me.deactivated || !canAccessOrg(me, orgId)) return false;
  return isBusinessAdminRole(effectiveRoleFor(me, orgId));
}

// --- What a card is shown -------------------------------------------------------

function publicFolder(f: DriveFolder, withFiles = true) {
  const person = personFor(f.workspaceId, f.userId);
  return {
    id: f.id,
    userId: f.userId,
    personName: person?.user.name || '',
    orgId: f.orgId,
    folderId: f.folderId,
    folderName: f.folderName,
    folderOwner: f.folderOwner,
    link: rules?.folderLinkFor(f.folderId) || `https://drive.google.com/drive/folders/${f.folderId}`,
    status: f.status,
    connectedBy: f.connectedBy,
    connectedAt: f.connectedAt,
    lastCheckedAt: f.lastCheckedAt,
    lastError: f.lastError,
    filedNote: f.filedNote,
    filed: f.filed,
    lastFiledAt: f.lastFiledAt,
    files: withFiles
      ? recentFiles(f.id).map((r: DriveFileRow) => ({
          fileId: r.fileId,
          name: r.name,
          outcome: r.outcome,
          reason: r.reason,
          billId: r.billId,
          displayId: r.displayId,
          moved: r.moved,
          at: r.at,
        }))
      : [],
  };
}

// --- Looking in a folder --------------------------------------------------------

// The poller has no request: nobody asked. What the read downstream wants of
// one is the entity to attribute the model call to (recordUsage reads X-Org-Id)
// and an origin for a link back (appOrigin, which prefers APP_ORIGIN and so
// never needs the host). This is that much of a request and no more.
function robotRequest(orgId: string): Request {
  const headers: Record<string, string> = { 'x-org-id': orgId };
  const header = (name: string) => headers[String(name).toLowerCase()];
  return {
    headers,
    header,
    get: header,
    cookies: {},
    query: {},
    params: {},
    body: {},
    path: '/api/drive/poll',
    protocol: 'https',
  } as unknown as Request;
}

// Why Drive would not let the folder be listed, as the person who has to fix it
// would say it.
function whyUnreachable(err: unknown): string {
  if (err instanceof DriveError) {
    if (err.status === 404 || err.status === 403) {
      return `CYBills can no longer open this folder — it was unshared, moved to the bin or deleted. Share it with ${robotEmail()} again and it picks up where it left off.`;
    }
    return `Google Drive would not list this folder (${err.message}).`;
  }
  return `Google Drive could not be reached (${err instanceof Error ? err.message : String(err)}).`;
}

// New files taken per look. A person who drops a year of receipts into the
// folder gets them ten at a time, two minutes apart, rather than as two hundred
// model calls started in the same second.
const BATCH = 10;
const READS_AT_ONCE = 3;
const MAX_TRIES = 3;
// How long a refusal to make the "Filed" subfolder is believed before asking
// again. The likely reasons (view-only access, a robot that may not own a
// folder in somebody's My Drive) do not change by themselves.
const FILED_RETRY_MS = 6 * 60 * 60 * 1000;

export type PollResult = {
  ok: boolean;
  filed: Array<{ billId: string; displayId: string; name: string }>;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; reason: string }>;
  moved: number;
  waiting: number;
  error: string;
};

const inFlight = new Map<string, Promise<PollResult>>();

/** Look in one folder now. One look at a time per folder — a second caller waits on the first. */
export function pollFolder(folderId: string): Promise<PollResult> {
  const running = inFlight.get(folderId);
  if (running) return running;
  const run = lookIn(folderId).finally(() => inFlight.delete(folderId));
  inFlight.set(folderId, run);
  return run;
}

async function lookIn(connectionId: string): Promise<PollResult> {
  const out: PollResult = { ok: false, filed: [], skipped: [], failed: [], moved: 0, waiting: 0, error: '' };
  const r = await loadRules();
  const folder = folderById(connectionId);
  if (!r || !folder || folder.status !== 'connected') {
    out.error = !r ? 'The Drive rules could not be loaded.' : 'This folder is not connected.';
    return out;
  }
  const now = () => new Date().toISOString();
  const person = personFor(folder.workspaceId, folder.userId);
  if (!person) {
    out.error = 'The person this folder files under is no longer on the roster.';
    patchFolder(folder.id, { lastCheckedAt: now(), lastError: out.error });
    return out;
  }

  let children: DriveFileMeta[];
  try {
    children = await listChildren(folder.folderId);
  } catch (err) {
    out.error = whyUnreachable(err);
    patchFolder(folder.id, { lastCheckedAt: now(), lastError: out.error });
    return out;
  }

  const scope = folder.scope;
  const realOrgId = folder.orgId;
  const toMove: Array<{ fileId: string; name: string }> = [];
  const reads: Array<{ billId: string; base64: string; mediaType: string; fileName: string }> = [];
  let taken = 0;

  for (const child of children) {
    const verdict = r.driveSkipReason(child);
    if (verdict.ignore) continue;
    const seen = fileRow(folder.id, child.id);
    if (seen) {
      // Filed already and still sitting here: the move is what is outstanding.
      if (seen.outcome === 'filed' && !seen.moved && seen.attempts < MAX_TRIES) toMove.push({ fileId: child.id, name: child.name });
      if (!(seen.outcome === 'failed' && seen.attempts < MAX_TRIES)) continue;
    } else {
      // Filed through an EARLIER connection on this same folder — one that was
      // disconnected, or belonged to somebody else. The document exists; filing
      // the file again because the connection is new would make a second copy.
      const prior = filedAnywhere(child.id);
      if (prior) {
        recordFile({ connectionId: folder.id, fileId: child.id, name: child.name, outcome: 'filed', reason: 'filed earlier', billId: prior.billId, displayId: prior.displayId, moved: false, attempts: 0 });
        toMove.push({ fileId: child.id, name: child.name });
        continue;
      }
    }
    if (verdict.reason) {
      recordFile({ connectionId: folder.id, fileId: child.id, name: child.name, outcome: 'skipped', reason: verdict.reason, billId: '', displayId: '', moved: false, attempts: 0 });
      out.skipped.push({ name: child.name, reason: verdict.reason });
      continue;
    }
    if (taken >= BATCH) {
      out.waiting += 1;
      continue;
    }
    taken += 1;

    const tries = (seen?.attempts ?? 0) + 1;
    let bytes: Buffer;
    try {
      bytes = await downloadFile(child.id);
    } catch (err) {
      const reason = `could not be downloaded (${err instanceof Error ? err.message : String(err)})`;
      recordFile({ connectionId: folder.id, fileId: child.id, name: child.name, outcome: 'failed', reason, billId: '', displayId: '', moved: false, attempts: tries });
      out.failed.push({ name: child.name, reason });
      continue;
    }
    if (!bytes.length || bytes.length > r.MAX_DRIVE_FILE_BYTES) {
      const reason = bytes.length ? 'too large to read (the limit is 20 MB)' : 'an empty file';
      recordFile({ connectionId: folder.id, fileId: child.id, name: child.name, outcome: 'skipped', reason, billId: '', displayId: '', moved: false, attempts: tries });
      out.skipped.push({ name: child.name, reason });
      continue;
    }
    // What the file IS, off its bytes — Drive's label is whatever the uploading
    // app said, and a PDF saved by a scanner as `application/octet-stream` is
    // still a PDF (mediaType.ts).
    const readType = readerMediaType(child.mimeType, child.name, bytes);
    if (!readType && !IMAGE_OR_PDF.test(child.mimeType) && !IMAGE_OR_PDF.test(child.name)) {
      const reason = 'not a PDF or image';
      recordFile({ connectionId: folder.id, fileId: child.id, name: child.name, outcome: 'skipped', reason, billId: '', displayId: '', moved: false, attempts: tries });
      out.skipped.push({ name: child.name, reason });
      continue;
    }

    try {
      const fileHash = createHash('sha256').update(bytes).digest('hex');
      let storageKey = '';
      let storedType = '';
      try {
        const stored = await putBillFile(scope, fileHash, readType || child.mimeType, bytes);
        storageKey = stored.storageKey;
        storedType = stored.contentType;
      } catch {
        // Keep the metadata record even if the file store fails, as the email
        // road does — a document with no retrievable file is still a document.
      }
      const who = child.lastModifyingUser || child.sharingUser || child.owners?.[0] || {};
      const bill = insertBill({
        orgId: scope,
        fileHash,
        fileName: child.name,
        supplier: '',
        invoiceNumber: '',
        documentType: '',
        currency: '',
        total: 0,
        tax: 0,
        date: '',
        category: '',
        // The folder decides whose it is, the way a person's own WhatsApp group
        // does: it was connected FOR them, and that was settled then.
        createdBy: person.user.email,
        owner: person.user.email,
        drive: {
          connectionId: folder.id,
          folderId: folder.folderId,
          folderName: folder.folderName,
          fileId: child.id,
          fileName: child.name,
          addedBy: String(who.emailAddress || ''),
          addedByName: String(who.displayName || ''),
          addedAt: String(child.createdTime || ''),
        },
        storageKey,
        contentType: storedType || readType || child.mimeType,
        // Being read, and saying so, for the whole of the read.
        status: 'processing',
        kind: 'cost',
      });
      recordFile({ connectionId: folder.id, fileId: child.id, name: child.name, outcome: 'filed', reason: '', billId: bill.id, displayId: bill.displayId, moved: false, attempts: 0 });
      out.filed.push({ billId: bill.id, displayId: bill.displayId, name: child.name });
      reads.push({ billId: bill.id, base64: bytes.toString('base64'), mediaType: readType || storedType || child.mimeType, fileName: child.name });
      toMove.push({ fileId: child.id, name: child.name });
    } catch (err) {
      const reason = `could not be filed (${err instanceof Error ? err.message : String(err)})`;
      recordFile({ connectionId: folder.id, fileId: child.id, name: child.name, outcome: 'failed', reason, billId: '', displayId: '', moved: false, attempts: tries });
      out.failed.push({ name: child.name, reason });
    }
  }

  // Out of the folder, into "Filed" — after the document is durably stored and
  // without waiting for its read. The subfolder is found where somebody made
  // one, and made where nobody has.
  let filedFolderId = children.find((c) => r.isFiledFolder(c))?.id || '';
  // What was last said about moving stands until a look with something to move
  // says otherwise: a quiet look has learned nothing about it.
  let filedNote = folder.filedNote;
  let filedBlockedAt = folder.filedBlockedAt || '';
  if (toMove.length && !filedFolderId) {
    const blocked = filedBlockedAt && Date.now() - new Date(filedBlockedAt).getTime() < FILED_RETRY_MS;
    if (!blocked) {
      try {
        filedFolderId = (await createFolder(folder.folderId, r.FILED_FOLDER_NAME)).id;
        filedBlockedAt = '';
      } catch (err) {
        filedBlockedAt = now();
        filedNote =
          `Filed files are staying where they are: CYBills could not make a “${r.FILED_FOLDER_NAME}” folder here ` +
          `(${err instanceof Error ? err.message : String(err)}). Make a folder called ${r.FILED_FOLDER_NAME} inside this one ` +
          `and they will be moved into it; nothing is filed twice either way.`;
      }
    }
  }
  if (filedFolderId && toMove.length) {
    filedNote = '';
    for (const f of toMove) {
      const row = fileRow(folder.id, f.fileId);
      if (!row) continue;
      try {
        await moveFile(f.fileId, folder.folderId, filedFolderId);
        recordFile({ ...row, moved: true, at: row.at });
        out.moved += 1;
      } catch (err) {
        recordFile({ ...row, attempts: row.attempts + 1, at: row.at });
        filedNote = `“${f.name}” was filed but could not be moved into ${r.FILED_FOLDER_NAME} (${err instanceof Error ? err.message : String(err)}). Share the folder with ${robotEmail()} as an Editor.`;
      }
    }
  }

  patchFolder(folder.id, {
    lastCheckedAt: now(),
    lastError: '',
    filedFolderId,
    filedNote,
    filedBlockedAt,
    ...(out.filed.length ? { filed: folder.filed + out.filed.length, lastFiledAt: now() } : {}),
  });

  startReads(scope, realOrgId, reads);
  out.ok = true;
  return out;
}

// Read what was just filed, a few at a time, in the background.
//
// Every document in the batch says it is being read for as long as it is
// WAITING to be as well as while it is: the stuck-processing sweep counts from
// the last thing it heard, autoRead only starts speaking once a read begins,
// and the seventh document of ten would otherwise be filed out of "Processing"
// as "Needs: Category, Total" while it sat in this queue.
function startReads(
  scope: string,
  realOrgId: string,
  reads: Array<{ billId: string; base64: string; mediaType: string; fileName: string }>
): void {
  if (!reads.length) return;
  const settings = readSetting<{ readerProvider?: string }>(WORKSPACE_ID, 'cybills.extraction-settings.v1', realOrgId);
  const provider = resolveProvider(settings?.readerProvider);
  const req = robotRequest(realOrgId);
  const waiting = new Set(reads.map((x) => x.billId));
  for (const id of waiting) noteReading(scope, id);
  const beat = setInterval(() => {
    for (const id of waiting) noteReading(scope, id);
  }, 20_000);
  beat.unref?.();
  const queue = [...reads];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      waiting.delete(next.billId);
      try {
        // The file's NAME is the whole of what the person said about it: nobody
        // writes a covering message to a folder. It travels as it does on an
        // upload, and a re-read finds it again on the document.
        await autoRead(req, scope, realOrgId, provider, next.billId, next.base64, next.mediaType, {
          via: 'upload',
          fileName: next.fileName,
        });
      } catch (err) {
        console.error('[drive] read failed', err);
      }
    }
  };
  void Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, reads.length) }, worker)).finally(() =>
    clearInterval(beat)
  );
}

// --- The clock --------------------------------------------------------------------

let sweeping = false;

/** Look in every connected folder, one after another. Never two sweeps at once. */
export async function pollAllFolders(): Promise<void> {
  if (sweeping || !driveEnabled()) return;
  sweeping = true;
  try {
    for (const f of loadFolders().filter((x) => x.status === 'connected')) {
      try {
        await pollFolder(f.id);
      } catch (err) {
        console.error(`[drive] look in ${f.folderName || f.folderId} failed`, err);
      }
    }
  } finally {
    sweeping = false;
  }
}

export function startDriveClock(): void {
  if (!driveEnabled()) return;
  const tick = () => void pollAllFolders().catch((err) => console.error('[drive] sweep failed', err));
  setTimeout(tick, 45_000).unref();
  setInterval(tick, env.DRIVE_POLL_SECONDS * 1000).unref();
}

// --- Routes -------------------------------------------------------------------------

export const driveRouter = Router();

const orgIdFor = (req: Request) => String(req.header('X-Org-Id') || '').trim();

// GET /api/drive/status — whether the road exists here, and the address a
// folder is shared with. The address is not a secret: it is what people type
// into Drive's Share box, and holding it opens nothing.
driveRouter.get('/status', (_req, res) => {
  res.json({ enabled: driveEnabled(), robotEmail: robotEmail() });
});

// GET /api/drive/folders — the folders this entity collects through, or (with
// ?userId=) one person's. The per-person lookup is NOT scoped to the header
// entity, for the reason the WhatsApp one is not: a colleague's folder files
// into the practice's own organisation while the browser is sitting in some
// client's.
driveRouter.get('/folders', async (req, res) => {
  await loadRules();
  const ws = workspaceId(req);
  const base = { enabled: driveEnabled(), robotEmail: robotEmail() };
  const userId = String(req.query.userId ?? '').trim();
  if (userId) {
    const person = personFor(ws, userId);
    if (!person) return res.status(404).json({ error: 'unknown_user' });
    if (!mayManagePerson(req, person.user, person.orgId)) return res.status(403).json({ error: 'not_an_admin' });
    return res.json({
      ...base,
      canManage: true,
      folders: foldersForUser(ws, userId).filter((f) => f.status === 'connected').map((f) => publicFolder(f)),
    });
  }
  const orgId = orgIdFor(req);
  if (!orgId) return res.json({ ...base, canManage: false, folders: [] });
  const manage = mayManageOrg(req, orgId);
  const me = memberForSession(req);
  // Whoever runs the entity sees every folder it collects through; anybody
  // else sees their own, which is the rule their documents follow too.
  const mine = foldersForOrg(ws, orgId).filter(
    (f) => f.status === 'connected' && (manage || (me ? f.userId === me.id : !googleEnabled))
  );
  res.json({ ...base, canManage: manage, folders: mine.map((f) => publicFolder(f)) });
});

// POST /api/drive/folders — body { userId, link }. Connect a folder to a person.
//
// Nothing is made in Drive: the folder exists, in somebody's own Drive, and has
// been shared with the robot by whoever owns it. What this records is whose
// book its contents are filed into — and that is the whole of the care here,
// because ONE robot address serves every client. A folder shared with it for
// one client must not be connectable by somebody at another who has merely come
// by the link, so beyond the robot being able to open it, the folder has to be
// owned by or shared with the person it will file under, or whoever is
// connecting it. Whoever runs the practice is excused: they can open every
// client's book already.
driveRouter.post('/folders', async (req, res) => {
  if (!driveEnabled()) {
    return res.status(503).json({ error: 'drive_not_configured', message: 'Google Drive is not set up on this deployment yet.' });
  }
  const r = await loadRules();
  if (!r) return res.status(500).json({ error: 'rules_unavailable', message: 'Could not load the Drive rules.' });
  const ws = workspaceId(req);
  const userId = String(req.body?.userId ?? '').trim();
  const person = personFor(ws, userId);
  if (!person) return res.status(404).json({ error: 'unknown_user', message: 'That person is not on the roster.' });
  if (!mayManagePerson(req, person.user, person.orgId)) return res.status(403).json({ error: 'not_an_admin' });
  if (!person.orgId) {
    return res.status(400).json({
      error: 'org_required',
      message: 'There is no organisation to file into yet. Link one under Business settings → Connections first.',
    });
  }

  const folderId = r.folderIdFromLink(req.body?.link);
  if (!folderId) {
    return res.status(400).json({
      error: 'invalid_link',
      message: 'That is not a Google Drive folder link. Open the folder in Drive and copy the address from the browser.',
    });
  }

  const taken = connectionOnFolder(folderId);
  if (taken) {
    if (taken.userId === userId) return res.json({ ok: true, unchanged: true, folder: publicFolder(taken) });
    // Named only inside the same entity: whose folder it is elsewhere is not
    // this caller's to learn.
    const other = taken.orgId === person.orgId ? personFor(ws, taken.userId)?.user.name || '' : '';
    return res.status(409).json({
      error: 'folder_in_use',
      message: `That folder is already connected${other ? ` to ${other}` : ' to somebody else'}. One folder files under one person — disconnect it there first, or use another folder.`,
    });
  }

  let meta: DriveFileMeta;
  try {
    meta = await getFile(folderId);
  } catch (err) {
    if (err instanceof DriveError && (err.status === 404 || err.status === 403)) {
      return res.status(422).json({
        error: 'not_shared',
        message: `CYBills can’t open that folder yet. In Drive, share it with ${robotEmail()} as an Editor, then connect it again.`,
        robotEmail: robotEmail(),
      });
    }
    return res.status(502).json({
      error: err instanceof DriveError ? err.code : 'drive_error',
      message: err instanceof Error ? err.message : 'Google Drive could not be reached.',
    });
  }
  if (meta.mimeType !== 'application/vnd.google-apps.folder') {
    return res.status(400).json({ error: 'not_a_folder', message: `“${meta.name}” is a file, not a folder. Paste the link to the folder it is in.` });
  }
  if (meta.trashed) {
    return res.status(400).json({ error: 'folder_trashed', message: `“${meta.name}” is in the bin in Drive. Restore it, or use another folder.` });
  }

  const me = memberForSession(req);
  const owners = (meta.owners ?? []).map((o) => norm(o.emailAddress)).filter(Boolean);
  if (me && !canManagePractice(me)) {
    const allowed = new Set([...owners, ...(await listPermissionEmails(folderId))]);
    const candidates = [me.email, person.user.email].map(norm).filter((e) => e && !isInternalAddress(e));
    if (!candidates.some((e) => allowed.has(e))) {
      return res.status(403).json({
        error: 'folder_not_yours',
        message:
          `That folder is shared with CYBills, but not with ${candidates.join(' or ') || 'you'}. ` +
          'A folder can be connected by somebody it belongs to or is shared with — open it in Drive and share it with that address too, or ask the practice to connect it.',
      });
    }
  }

  const canChange = Boolean(meta.capabilities?.canAddChildren ?? meta.capabilities?.canEdit);
  const folder = insertFolder({
    workspaceId: ws,
    orgId: person.orgId,
    scope: dataScopeForOrg(person.orgId),
    userId,
    folderId,
    folderName: meta.name || 'Google Drive folder',
    folderOwner: meta.owners?.[0]?.emailAddress || meta.owners?.[0]?.displayName || '',
    connectedBy: me?.email ?? '',
  });
  if (!canChange) {
    patchFolder(folder.id, {
      filedNote: `CYBills can read this folder but not change it, so filed files stay where they are. Share it with ${robotEmail()} as an Editor to have them moved into “${r.FILED_FOLDER_NAME}”.`,
      // Nothing to ask for until the sharing changes.
      filedBlockedAt: new Date().toISOString(),
    });
  }
  // Whatever is already in it is looked at now rather than in two minutes —
  // somebody who has just connected a folder is watching for exactly that. Not
  // waited on: the answer is the connection.
  void pollFolder(folder.id).catch((err) => console.error('[drive] first look failed', err));
  const org = getOrganisation(ws, person.orgId);
  res.json({ ok: true, folder: publicFolder(folderById(folder.id) ?? folder), orgName: org?.name || '' });
});

function folderForCaller(req: Request, id: string): { folder: DriveFolder } | { status: number; error: string } {
  const folder = folderById(id);
  if (!folder || folder.workspaceId !== workspaceId(req)) return { status: 404, error: 'unknown_folder' };
  const person = personFor(folder.workspaceId, folder.userId);
  // A folder whose person has left the roster is still somebody's to close:
  // whoever runs the entity it files into.
  const allowed = person ? mayManagePerson(req, person.user, folder.orgId) : mayManageOrg(req, folder.orgId);
  // 404, not 403: whether a connection exists is itself not the caller's to learn.
  return allowed ? { folder } : { status: 404, error: 'unknown_folder' };
}

// POST /api/drive/folders/:id/check — look in it now, and say what was found.
driveRouter.post('/folders/:id/check', async (req, res) => {
  if (!driveEnabled()) return res.status(503).json({ error: 'drive_not_configured' });
  await loadRules();
  const found = folderForCaller(req, String(req.params.id));
  if ('error' in found) return res.status(found.status).json({ error: found.error });
  if (found.folder.status !== 'connected') return res.status(409).json({ error: 'not_connected' });
  const result = await pollFolder(found.folder.id);
  res.json({ ...result, folder: publicFolder(folderById(found.folder.id) ?? found.folder) });
});

// DELETE /api/drive/folders/:id — stop collecting from it.
//
// Nothing is touched in Drive: the folder is the person's own, and so is
// everything in it. The documents already filed are accounting records and
// stay in the book; the row stays too, because it is what says where they came
// from. To stop CYBills being ABLE to open the folder, its owner unshares it.
driveRouter.delete('/folders/:id', async (req, res) => {
  await loadRules();
  const found = folderForCaller(req, String(req.params.id));
  if ('error' in found) return res.status(found.status).json({ error: found.error });
  const me = memberForSession(req);
  const folder = patchFolder(found.folder.id, {
    status: 'disconnected',
    disconnectedAt: new Date().toISOString(),
    disconnectedBy: me?.email ?? '',
  });
  res.json({ ok: true, folder: folder ? publicFolder(folder, false) : null });
});
