import { randomBytes } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';

// The Google Drive folders people have connected, and what became of every
// file found in one. A leaf, like waChannels.ts and mailThread.ts and for the
// same reason: the router and the poller both read it, and neither should have
// to import the other to do so.

export type DriveFolder = {
  id: string;
  workspaceId: string;
  /** The organisation RECORD the documents belong to; `scope` is its bills-store scope. */
  orgId: string;
  scope: string;
  /** Whose folder it is — every file found in it is filed under this person. */
  userId: string;
  folderId: string;
  folderName: string;
  /** Who owns the folder in Drive, where Drive says. Shown, never matched on after connecting. */
  folderOwner: string;
  status: 'connected' | 'disconnected';
  connectedBy: string;
  connectedAt: string;
  disconnectedAt?: string;
  disconnectedBy?: string;
  lastCheckedAt: string;
  /** Why the folder could not be looked in, in words. '' when the last look worked. */
  lastError: string;
  /** The "Filed" subfolder, once found or made. */
  filedFolderId: string;
  /** Why filed files are NOT being moved, where they are not. */
  filedNote: string;
  /** When making the subfolder was last refused, so it is not asked for every two minutes. */
  filedBlockedAt?: string;
  filed: number;
  lastFiledAt: string;
};

// One row per Drive file ever seen in a connected folder. It is what makes a
// file filed ONCE: moving it out of the folder is a courtesy to the person
// looking at their Drive, and it can fail (a robot with view-only access, a
// subfolder that could not be made) without anything being filed twice.
export type DriveFileRow = {
  /** `${connectionId}:${fileId}` — a file can be seen by two connections over time. */
  id: string;
  connectionId: string;
  fileId: string;
  name: string;
  outcome: 'filed' | 'skipped' | 'failed';
  /** Why it was skipped, or what went wrong. */
  reason: string;
  billId: string;
  displayId: string;
  moved: boolean;
  /** What the file is called in "Filed" — the day and running number in front of its own name. */
  filedName?: string;
  attempts: number;
  at: string;
};

const FOLDERS = 'drive-folders';
const FILES = 'drive-files';

export const loadFolders = (): DriveFolder[] => loadCollection<DriveFolder>(FOLDERS);

export const folderById = (id: string): DriveFolder | null => loadFolders().find((f) => f.id === id) ?? null;

export const foldersForUser = (ws: string, userId: string): DriveFolder[] =>
  loadFolders().filter((f) => f.workspaceId === ws && f.userId === userId);

export const foldersForOrg = (ws: string, orgId: string): DriveFolder[] =>
  loadFolders().filter((f) => f.workspaceId === ws && f.orgId === orgId);

/** The live connection on a Drive folder, whoever's it is. One folder, one person. */
export const connectionOnFolder = (folderId: string): DriveFolder | null =>
  loadFolders().find((f) => f.folderId === folderId && f.status === 'connected') ?? null;

export function insertFolder(
  input: Omit<DriveFolder, 'id' | 'status' | 'connectedAt' | 'lastCheckedAt' | 'lastError' | 'filedFolderId' | 'filedNote' | 'filed' | 'lastFiledAt'>
): DriveFolder {
  const items = loadFolders();
  const folder: DriveFolder = {
    ...input,
    id: `drv_${randomBytes(8).toString('hex')}`,
    status: 'connected',
    connectedAt: new Date().toISOString(),
    lastCheckedAt: '',
    lastError: '',
    filedFolderId: '',
    filedNote: '',
    filed: 0,
    lastFiledAt: '',
  };
  items.push(folder);
  saveCollection(FOLDERS, items);
  return folder;
}

/** Writes only on a change: the poller calls this every two minutes per folder. */
export function patchFolder(id: string, patch: Partial<DriveFolder>): DriveFolder | null {
  const items = loadFolders();
  const folder = items.find((f) => f.id === id);
  if (!folder) return null;
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if ((folder as Record<string, unknown>)[k] !== v) {
      (folder as Record<string, unknown>)[k] = v;
      changed = true;
    }
  }
  if (changed) saveCollection(FOLDERS, items);
  return folder;
}

const rowId = (connectionId: string, fileId: string) => `${connectionId}:${fileId}`;

export const loadFileRows = (): DriveFileRow[] => loadCollection<DriveFileRow>(FILES);

export const fileRow = (connectionId: string, fileId: string): DriveFileRow | null =>
  loadFileRows().find((r) => r.id === rowId(connectionId, fileId)) ?? null;

/**
 * Whether ANY live connection has already filed this Drive file. A folder
 * disconnected and connected again — or handed from one person to another —
 * is a new connection over the same files, and the ones still sitting in it
 * were filed once already.
 */
export const filedAnywhere = (fileId: string): DriveFileRow | null =>
  // The LATEST connection's word on it: rows are appended as connections are
  // made, and the last one is what most recently happened to the file.
  [...loadFileRows()].reverse().find((r) => r.fileId === fileId && r.outcome === 'filed') ?? null;

export function recordFile(row: Omit<DriveFileRow, 'id' | 'at'> & { at?: string }): DriveFileRow {
  const items = loadFileRows();
  const id = rowId(row.connectionId, row.fileId);
  const next: DriveFileRow = { ...row, id, at: row.at || new Date().toISOString() };
  const i = items.findIndex((r) => r.id === id);
  if (i >= 0) items[i] = next;
  else items.push(next);
  saveCollection(FILES, items);
  return next;
}

/**
 * Every name a file has been filed under in this Drive FOLDER — across every
 * connection it has ever had, because a folder disconnected and connected again
 * is a new connection over the same "Filed" subfolder, and the running number
 * must go on from where the last one stopped rather than hand out 0001 twice.
 */
export function filedNamesIn(folderId: string): string[] {
  const connections = new Set(loadFolders().filter((f) => f.folderId === folderId).map((f) => f.id));
  return loadFileRows()
    .filter((r) => connections.has(r.connectionId) && r.filedName)
    .map((r) => String(r.filedName));
}

/** The latest rows for a connection, newest first — what its card shows. */
export const recentFiles = (connectionId: string, limit = 8): DriveFileRow[] =>
  loadFileRows()
    .filter((r) => r.connectionId === connectionId)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, limit);
