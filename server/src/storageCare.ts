import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { env, r2Enabled } from './env.js';
import { putBill, objectSize, listKeys, deleteKey, localFilePath, storageHealth } from './storage.js';
import { listBillsAcrossScopes, replaceStorageKeys } from './store.js';
import { loadCollection, saveCollection } from './jsonStore.js';
import { loadMail, saveMail } from './mailThread.js';
import { practiceDayKey } from './usage.js';

// Keeping the files, and the records, somewhere other than this one VPS.
//
// For weeks every upload landed on the server's own disk: the bucket CYBills was
// pointed at was one its R2 key could not open, the upload fell back to local
// disk exactly as designed, and nothing anybody looks at said so. Two jobs fix
// what that left behind, and both run on a clock because nobody presses a button
// for either:
//
//   - MOVE: any stored file still on local disk is copied into the bucket,
//     checked there by size, and only then are the records pointed at the copy.
//     The local file is left where it is (nothing here deletes it), so a move
//     that turns out wrong costs nothing. It keeps running, so a file that fell
//     back during a later outage goes up once the bucket answers again.
//   - BACKUP: once a practice day, every record file in the data directory —
//     bills.json, the roster, claims, settings — is gzipped into the bucket
//     under backups/cybills/<day>/, and days older than BACKUP_KEEP_DAYS are
//     removed. The FILES need no copy of their own once they are in the bucket;
//     the records saying which file is whose live only here, so they do.
//
// What each last did is kept (`storage-care` collection) and shown to the
// practice by GET /api/practice/storage, with the bucket's own health
// (storage.ts), so a storage problem is a message on a page and not a log line.

const DATA_DIR = env.BILLS_DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url));
const MIGRATED_PREFIX = 'bills/local/';
const BACKUP_PREFIX = 'backups/cybills/';
const BACKUP_KEEP_DAYS = 30;
const MOVE_BATCH = 50;

type MoveState = {
  lastRunAt: string;
  lastMoved: number;
  movedTotal: number;
  lastError: string;
  missing: string[]; // local keys whose file is not on disk: nothing to move
};
type BackupState = {
  lastDay: string;
  lastAt: string;
  lastFiles: number;
  lastBytes: number;
  lastError: string;
  lastErrorAt: string;
};
type CareState = { id: 'state'; move: MoveState; backup: BackupState };

const COLLECTION = 'storage-care';
const blankState = (): CareState => ({
  id: 'state',
  move: { lastRunAt: '', lastMoved: 0, movedTotal: 0, lastError: '', missing: [] },
  backup: { lastDay: '', lastAt: '', lastFiles: 0, lastBytes: 0, lastError: '', lastErrorAt: '' },
});
function readState(): CareState {
  const row = loadCollection<CareState>(COLLECTION)[0];
  const blank = blankState();
  return row ? { id: 'state', move: { ...blank.move, ...row.move }, backup: { ...blank.backup, ...row.backup } } : blank;
}
function writeState(state: CareState): void {
  saveCollection(COLLECTION, [state]);
}

// --- Move --------------------------------------------------------------------

// Every local key any record names: a document's file, a claim's supporting
// document, a mirrored mail's stored body.
export function localKeysInUse(): Set<string> {
  const keys = new Set<string>();
  const add = (k: unknown) => {
    if (typeof k === 'string' && k.startsWith('local:')) keys.add(k);
  };
  for (const b of listBillsAcrossScopes()) add(b.storageKey);
  for (const c of loadCollection<{ attachments?: Array<{ storageKey?: string }> }>('claims')) {
    for (const a of c.attachments ?? []) add(a.storageKey);
  }
  for (const m of loadMail()) add(m.bodyKey);
  return keys;
}

// Point the claims' attachments and the mirrored mail at the moved copies. The
// documents go through store.ts, which owns that file.
function repointCollections(moved: Map<string, string>): void {
  const claims = loadCollection<{ attachments?: Array<{ storageKey?: string }> }>('claims');
  let claimsChanged = false;
  for (const c of claims) {
    for (const a of c.attachments ?? []) {
      const to = a.storageKey ? moved.get(a.storageKey) : undefined;
      if (to) {
        a.storageKey = to;
        claimsChanged = true;
      }
    }
  }
  if (claimsChanged) saveCollection('claims', claims);
  const mail = loadMail();
  let mailChanged = false;
  for (const m of mail) {
    const to = m.bodyKey ? moved.get(m.bodyKey) : undefined;
    if (to) {
      m.bodyKey = to;
      mailChanged = true;
    }
  }
  if (mailChanged) saveMail(mail);
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  html: 'text/html',
};
const contentTypeFor = (name: string) =>
  CONTENT_TYPES[(name.split('.').pop() || '').toLowerCase()] ?? 'application/octet-stream';

let moving = false;
export async function moveLocalFilesToBucket(): Promise<{ moved: number; remaining: number; error: string }> {
  if (!r2Enabled) return { moved: 0, remaining: localKeysInUse().size, error: 'R2 is not configured' };
  if (moving) return { moved: 0, remaining: localKeysInUse().size, error: '' };
  moving = true;
  const state = readState();
  let moved = 0;
  let error = '';
  const missing: string[] = [];
  try {
    const todo = [...localKeysInUse()];
    let refused = false;
    for (let i = 0; i < todo.length && !refused; i += MOVE_BATCH) {
      const batch = new Map<string, string>();
      for (const localKey of todo.slice(i, i + MOVE_BATCH)) {
        const path = localFilePath(localKey);
        if (!existsSync(path)) {
          missing.push(localKey);
          continue;
        }
        const name = localKey.slice('local:'.length);
        const key = `${MIGRATED_PREFIX}${name}`;
        const bytes = readFileSync(path);
        try {
          await putBill(key, bytes, contentTypeFor(name));
        } catch (err) {
          // The bucket refusing one file is the bucket refusing: stop, keep
          // what has moved, and say why. The next tick tries again.
          error = `Could not copy ${name} into the bucket: ${(err as Error)?.name ?? ''} ${(err as Error)?.message ?? err}`.trim();
          refused = true;
          break;
        }
        // Pointed at only once the bucket holds every byte of it.
        if ((await objectSize(key)) !== bytes.length) {
          error = `The copy of ${name} in the bucket is not the same size as the file; left on local disk.`;
          continue;
        }
        batch.set(localKey, `r2:${key}`);
      }
      replaceStorageKeys(batch);
      repointCollections(batch);
      moved += batch.size;
    }
  } catch (err) {
    error = String((err as Error)?.message ?? err);
  } finally {
    moving = false;
  }
  state.move = {
    lastRunAt: new Date().toISOString(),
    lastMoved: moved,
    movedTotal: state.move.movedTotal + moved,
    lastError: error,
    missing: missing.slice(0, 50),
  };
  writeState(state);
  if (moved) console.log(`[storage] moved ${moved} local file(s) into the bucket`);
  if (error) console.error('[storage] move to bucket stopped:', error);
  return { moved, remaining: localKeysInUse().size, error };
}

// --- Backup ------------------------------------------------------------------

let backingUp = false;
export async function backupRecords(): Promise<{ ok: boolean; files: number; bytes: number; error: string }> {
  const state = readState();
  if (!r2Enabled) return { ok: false, files: 0, bytes: 0, error: 'R2 is not configured' };
  if (backingUp) return { ok: false, files: 0, bytes: 0, error: 'A backup is already running.' };
  backingUp = true;
  const day = practiceDayKey(new Date());
  let files = 0;
  let bytes = 0;
  let error = '';
  try {
    const names = readdirSync(DATA_DIR).filter(
      (n) => n.endsWith('.json') && statSync(`${DATA_DIR}/${n}`).isFile()
    );
    for (const name of names) {
      const gz = gzipSync(readFileSync(`${DATA_DIR}/${name}`));
      await putBill(`${BACKUP_PREFIX}${day}/${name}.gz`, gz, 'application/gzip');
      files += 1;
      bytes += gz.length;
    }
    // Retention: the day folders older than the window go.
    const cutoff = practiceDayKey(new Date(Date.now() - BACKUP_KEEP_DAYS * 86_400_000));
    for (const key of await listKeys(BACKUP_PREFIX)) {
      const keyDay = key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(keyDay) && keyDay < cutoff) await deleteKey(key);
    }
  } catch (err) {
    error = `${(err as Error)?.name ?? ''} ${(err as Error)?.message ?? err}`.trim();
  } finally {
    backingUp = false;
  }
  if (error) {
    state.backup = { ...state.backup, lastError: error, lastErrorAt: new Date().toISOString() };
    console.error('[storage] backup failed:', error);
  } else {
    state.backup = { lastDay: day, lastAt: new Date().toISOString(), lastFiles: files, lastBytes: bytes, lastError: '', lastErrorAt: '' };
  }
  writeState(state);
  return { ok: !error, files, bytes, error };
}

// --- Status ------------------------------------------------------------------

export type StorageStatus = {
  r2Enabled: boolean;
  bucket: string;
  health: ReturnType<typeof storageHealth>;
  localFiles: number; // records still pointing at the VPS's own disk
  move: MoveState;
  backup: BackupState;
  // Plain-language problems, empty when there are none. What the banner shows.
  problems: string[];
};

export function storageStatus(): StorageStatus {
  const state = readState();
  const health = storageHealth();
  // Only a file that is actually on disk can be moved; a record naming one that
  // is gone is reported apart (`move.missing`) rather than counted here for ever.
  const localFiles = [...localKeysInUse()].filter((k) => existsSync(localFilePath(k))).length;
  const problems: string[] = [];
  if (!r2Enabled) {
    problems.push('File storage (R2) is not configured, so every document is kept only on the server’s own disk.');
  } else {
    const failingNow = health.lastFailureAt && (!health.lastSuccessAt || health.lastFailureAt > health.lastSuccessAt);
    if (failingNow) {
      problems.push(`The file storage bucket is refusing requests (${health.lastFailureMessage}). New documents are being kept on the server’s own disk.`);
    }
    if (localFiles && !failingNow) {
      problems.push(`${localFiles} stored file${localFiles === 1 ? ' is' : 's are'} still only on the server’s own disk.`);
    }
    const yesterday = practiceDayKey(new Date(Date.now() - 86_400_000));
    if (!state.backup.lastDay || state.backup.lastDay < yesterday) {
      problems.push(
        state.backup.lastError
          ? `The nightly backup of CYBills’ records failed: ${state.backup.lastError}`
          : state.backup.lastDay
            ? `CYBills’ records were last backed up on ${state.backup.lastDay}.`
            : 'CYBills’ records have not been backed up yet.'
      );
    }
  }
  return { r2Enabled, bucket: r2Enabled ? env.R2_BUCKET : '', health, localFiles, move: state.move, backup: state.backup, problems };
}

// --- Clock -------------------------------------------------------------------

// Every half hour: move whatever is still on local disk, and back up once per
// practice day. Both are no-ops when there is nothing to do. The first tick
// waits a minute so a restart's own work settles first.
export function startStorageClock(): void {
  if (!r2Enabled) return;
  const tick = async () => {
    try {
      if (localKeysInUse().size) await moveLocalFilesToBucket();
      if (readState().backup.lastDay !== practiceDayKey(new Date())) await backupRecords();
    } catch (err) {
      console.error('[storage] care tick failed', err);
    }
  };
  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), 30 * 60_000).unref();
}
