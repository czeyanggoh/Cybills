import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { env } from './env.js';

// Google Drive, spoken to as CYBills' ROBOT — a service account.
//
// The whole of what CYBills can reach is what somebody has SHARED with the
// robot's address: it has no Drive of its own worth the name, sees nobody's
// files by default, and needs no consent screen, which is why it is a service
// account at all (see env.ts). Everything here is the thin client; which
// folders are looked in, and what becomes of what is found, is drive.ts.
//
// The token grant is written out rather than pulled in, the way totp.ts is: it
// is one signed assertion and one POST (RFC 7523), it honours the `token_uri`
// the key file itself names — which is what lets a test stand a stub in for
// Google without a test-only switch in here — and `jsonwebtoken` is already
// what signs the session.

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
};

const SCOPE = 'https://www.googleapis.com/auth/drive';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

let parsed: ServiceAccountKey | null | undefined;

// The key, from whichever of the two places it was put. Read once: it is
// deployment configuration, and a key that fails to parse is reported the same
// way as one that is absent — the road is not there — with the reason logged.
function serviceAccount(): ServiceAccountKey | null {
  if (parsed !== undefined) return parsed;
  parsed = null;
  let raw = String(env.GOOGLE_DRIVE_CREDENTIALS || '').trim();
  try {
    if (!raw && env.GOOGLE_DRIVE_KEY_FILE) raw = readFileSync(env.GOOGLE_DRIVE_KEY_FILE, 'utf8').trim();
    if (!raw) return parsed;
    // Base64 of the JSON, which is how it survives a .env file best.
    if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8').trim();
    const key = JSON.parse(raw) as Partial<ServiceAccountKey>;
    if (key?.client_email && key?.private_key) {
      parsed = {
        client_email: String(key.client_email),
        // A key pasted into a .env by hand often arrives with its newlines
        // spelt out as the two characters `\n`.
        private_key: String(key.private_key).replace(/\\n/g, '\n'),
        private_key_id: key.private_key_id ? String(key.private_key_id) : undefined,
        token_uri: key.token_uri ? String(key.token_uri) : undefined,
      };
    } else {
      console.error('[drive] the service account key has no client_email / private_key');
    }
  } catch (err) {
    console.error('[drive] the service account key could not be read', err instanceof Error ? err.message : err);
  }
  return parsed;
}

export const driveEnabled = (): boolean => Boolean(serviceAccount());

/** The address a folder is shared with. Public by nature: it is what people type into Drive's Share box. */
export const robotEmail = (): string => serviceAccount()?.client_email ?? '';

let token: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  const key = serviceAccount();
  if (!key) throw new DriveError(503, 'drive_not_configured', 'Google Drive is not set up on this deployment.');
  if (token && token.expires - 60_000 > Date.now()) return token.value;
  const tokenUri = key.token_uri || DEFAULT_TOKEN_URI;
  const assertion = jwt.sign({ scope: SCOPE }, key.private_key, {
    algorithm: 'RS256',
    issuer: key.client_email,
    audience: tokenUri,
    expiresIn: 3600,
    ...(key.private_key_id ? { keyid: key.private_key_id } : {}),
  });
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error_description?: string; error?: string } | null;
  if (!res.ok || !data?.access_token) {
    throw new DriveError(
      502,
      'drive_auth_failed',
      `Google refused CYBills' robot a token (${data?.error_description || data?.error || res.status}).`
    );
  }
  token = { value: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return token.value;
}

/** A refusal from Drive, in a shape the routes and the poller can both report. */
export class DriveError extends Error {
  status: number;
  code: string;
  /** Google's own `reason` ('notFound', 'storageQuotaExceeded', …) where it gave one. */
  reason: string;
  constructor(status: number, code: string, message: string, reason = '') {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

type GoogleError = { error?: { message?: string; errors?: Array<{ reason?: string }> } };

async function call(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const res = await fetch(`${env.GOOGLE_DRIVE_API_URL}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${await accessToken()}` },
  });
  // A token Google has stopped honouring before its stated expiry: get another
  // and ask once more, rather than failing every folder until the hour is up.
  if (res.status === 401 && !retried) {
    token = null;
    return call(path, init, true);
  }
  if (res.ok) return res;
  const body = (await res.json().catch(() => null)) as GoogleError | null;
  const reason = body?.error?.errors?.[0]?.reason || '';
  const message = body?.error?.message || `Google Drive answered ${res.status}`;
  throw new DriveError(res.status, res.status === 404 ? 'not_found' : res.status === 403 ? 'forbidden' : 'drive_error', message, reason);
}

// Every call names all-drives support: a folder in a SHARED drive is a folder
// like any other to the person sharing it, and without the flag Drive answers
// 404 for one that is plainly there.
const ALL_DRIVES = 'supportsAllDrives=true';

export type DrivePerson = { emailAddress?: string; displayName?: string };

export type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  trashed?: boolean;
  parents?: string[];
  owners?: DrivePerson[];
  lastModifyingUser?: DrivePerson;
  sharingUser?: DrivePerson;
  capabilities?: { canAddChildren?: boolean; canEdit?: boolean; canListChildren?: boolean };
};

const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,trashed,parents,' +
  'owners(emailAddress,displayName),lastModifyingUser(emailAddress,displayName),sharingUser(emailAddress,displayName)';

export async function getFile(id: string): Promise<DriveFileMeta> {
  const fields = encodeURIComponent(`${FILE_FIELDS},capabilities(canAddChildren,canEdit,canListChildren)`);
  const res = await call(`/drive/v3/files/${encodeURIComponent(id)}?fields=${fields}&${ALL_DRIVES}`);
  return (await res.json()) as DriveFileMeta;
}

/** Everything directly inside a folder — files and subfolders, oldest first. Not recursive. */
export async function listChildren(folderId: string, max = 500): Promise<DriveFileMeta[]> {
  const out: DriveFileMeta[] = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`);
    const fields = encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`);
    const res = await call(
      `/drive/v3/files?q=${q}&fields=${fields}&pageSize=100&orderBy=createdTime&${ALL_DRIVES}&includeItemsFromAllDrives=true` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '')
    );
    const data = (await res.json()) as { files?: DriveFileMeta[]; nextPageToken?: string };
    out.push(...(data.files ?? []));
    pageToken = data.nextPageToken || '';
  } while (pageToken && out.length < max);
  return out;
}

export async function downloadFile(id: string): Promise<Buffer> {
  const res = await call(`/drive/v3/files/${encodeURIComponent(id)}?alt=media&${ALL_DRIVES}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Who can open a folder, by address. [] where the robot is not allowed to ask. */
export async function listPermissionEmails(id: string): Promise<string[]> {
  try {
    const fields = encodeURIComponent('permissions(emailAddress,type,role)');
    const res = await call(`/drive/v3/files/${encodeURIComponent(id)}/permissions?fields=${fields}&pageSize=100&${ALL_DRIVES}`);
    const data = (await res.json()) as { permissions?: Array<{ emailAddress?: string }> };
    return (data.permissions ?? []).map((p) => String(p.emailAddress || '').trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function createFolder(parentId: string, name: string): Promise<DriveFileMeta> {
  const res = await call(`/drive/v3/files?fields=id,name,mimeType&${ALL_DRIVES}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  return (await res.json()) as DriveFileMeta;
}

/** Move a file from one folder into another. Its id, its owner and its sharing all stay as they were. */
export async function moveFile(id: string, fromFolderId: string, toFolderId: string): Promise<void> {
  await call(
    `/drive/v3/files/${encodeURIComponent(id)}?addParents=${encodeURIComponent(toFolderId)}` +
      `&removeParents=${encodeURIComponent(fromFolderId)}&fields=id&${ALL_DRIVES}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' }
  );
}
