// A Google Drive folder as a road in.
//
// Somebody shares a folder in their own Drive with CYBills' robot and pastes
// its link on their page; what is saved into it is filed under them, once, and
// moved into a "Filed" subfolder. What can go wrong is the whole of what is
// tested here: a folder connected by somebody it does not belong to (one robot
// address serves every client), a file filed twice, a file that is not a
// document filed as one, and a move that fails taking the filing with it.
//
// Driven over real HTTP at both ends — the routes as the browser calls them,
// and a stub standing in for Google (its token endpoint included, so the signed
// assertion that actually goes out is what gets verified).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-drive-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
// No reader key: the background read returns at its first line, which keeps
// this test about the folder rather than about extraction.
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const ROBOT = 'cybills-robot@cybills-test.iam.gserviceaccount.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
// Base64 of the key file, which is how a deploy is told to paste it.
process.env.GOOGLE_DRIVE_CREDENTIALS = Buffer.from(
  JSON.stringify({ client_email: ROBOT, private_key: privateKey, private_key_id: 'k1', token_uri: 'http://127.0.0.1:4692/token' })
).toString('base64');
process.env.GOOGLE_DRIVE_API_URL = 'http://127.0.0.1:4692';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-red', orgId: 'cybm', name: 'Red Alpha Cybersecurity Pte. Ltd.', tenantId: 't-red', tenantName: 'Red Alpha', createdAt: new Date(1).toISOString(), createdBy: '' },
      { id: 'org-dart', orgId: 'cybm', name: 'Dart Consulting', tenantId: 't-dart', tenantName: 'Dart', createdAt: new Date(2).toISOString(), createdBy: '' },
    ],
  })
);

// --- The stand-in for Google ---------------------------------------------------
const FOLDER = 'application/vnd.google-apps.folder';
type Item = {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  bytes?: Buffer;
  owner?: string;
  sharedWith?: string[];
  trashed?: boolean;
  /** Whether the robot may add to / change it. */
  editable?: boolean;
  /** Whether the robot can see it at all. */
  visible?: boolean;
};
const drive = new Map<string, Item>();
const put = (item: Item) => {
  drive.set(item.id, { visible: true, editable: true, ...item });
  return item.id;
};
let mayCreateFolders = true;
let minted = 0;
const tokens: Array<{ iss: string; aud: string; scope: string }> = [];
const created: string[] = [];

const jwt = (await import('jsonwebtoken')).default;

const meta = (i: Item) => ({
  id: i.id,
  name: i.name,
  mimeType: i.mimeType,
  size: i.bytes ? String(i.bytes.length) : undefined,
  createdTime: '2026-09-27T02:00:00.000Z',
  trashed: Boolean(i.trashed),
  parents: i.parents,
  owners: i.owner ? [{ emailAddress: i.owner, displayName: i.owner.split('@')[0] }] : [],
  lastModifyingUser: i.owner ? { emailAddress: i.owner, displayName: i.owner.split('@')[0] } : undefined,
  capabilities: { canAddChildren: Boolean(i.editable), canEdit: Boolean(i.editable), canListChildren: true },
});

const google = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url || '/', 'http://127.0.0.1:4692');
    const json = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const refuse = (status: number, reason: string, message: string) =>
      json(status, { error: { code: status, message, errors: [{ reason }] } });

    if (url.pathname === '/token') {
      const assertion = new URLSearchParams(raw).get('assertion') || '';
      try {
        const claims = jwt.verify(assertion, publicKey, { algorithms: ['RS256'] }) as Record<string, string>;
        tokens.push({ iss: claims.iss, aud: claims.aud, scope: claims.scope });
        minted += 1;
        return json(200, { access_token: `tok-${minted}`, expires_in: 3600, token_type: 'Bearer' });
      } catch {
        return json(400, { error: 'invalid_grant', error_description: 'bad assertion' });
      }
    }
    if (!/^Bearer tok-\d+$/.test(String(req.headers.authorization || ''))) return refuse(401, 'authError', 'Invalid Credentials');

    const one = /^\/drive\/v3\/files\/([^/]+)(\/permissions)?$/.exec(url.pathname);
    if (one) {
      const item = drive.get(decodeURIComponent(one[1]));
      if (!item || !item.visible) return refuse(404, 'notFound', `File not found: ${one[1]}.`);
      if (one[2]) {
        return json(200, {
          permissions: [item.owner, ...(item.sharedWith ?? []), ROBOT].filter(Boolean).map((e) => ({ emailAddress: e, type: 'user', role: 'writer' })),
        });
      }
      if (req.method === 'PATCH') {
        if (!item.editable) return refuse(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.');
        const add = url.searchParams.get('addParents');
        const remove = url.searchParams.get('removeParents');
        item.parents = [...item.parents.filter((p) => p !== remove), ...(add ? [add] : [])];
        return json(200, { id: item.id });
      }
      if (url.searchParams.get('alt') === 'media') {
        res.statusCode = 200;
        res.setHeader('content-type', item.mimeType);
        return res.end(item.bytes ?? Buffer.alloc(0));
      }
      return json(200, meta(item));
    }
    if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
      const body = JSON.parse(raw || '{}') as { name: string; mimeType: string; parents: string[] };
      const parent = drive.get(body.parents?.[0]);
      if (!mayCreateFolders || !parent?.editable) {
        return refuse(403, 'storageQuotaExceeded', 'Service Accounts do not have storage quota.');
      }
      const id = `made_folder_${created.length + 1}_abcdefghij`;
      created.push(id);
      put({ id, name: body.name, mimeType: body.mimeType, parents: body.parents });
      return json(200, { id, name: body.name, mimeType: body.mimeType });
    }
    if (url.pathname === '/drive/v3/files') {
      const parentId = /'([^']+)' in parents/.exec(url.searchParams.get('q') || '')?.[1] || '';
      const parent = drive.get(parentId);
      if (!parent || !parent.visible) return refuse(404, 'notFound', `File not found: ${parentId}.`);
      const files = [...drive.values()].filter((i) => i.parents.includes(parentId) && !i.trashed).map(meta);
      return json(200, { files });
    }
    return refuse(404, 'notFound', 'no such route');
  });
});
await new Promise<void>((r) => google.listen(4692, '127.0.0.1', r));

// --- The app ---------------------------------------------------------------------
const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { driveRouter, pollAllFolders } = await import('../src/drive.ts');
const { listBills } = await import('../src/store.ts');
const { ensure, save } = await import('../src/users.ts');

const RED = 'org-red';
const items = ensure('cybm');
const seed = items.find((u) => u.practice)!;
const employee = (id: string, name: string, email: string, role: string, org = RED) =>
  ({
    ...seed, id, name, email, role, practice: false, practiceRole: 'Standard', general: false,
    allClients: false, clientAccess: [], extraAccess: [], organisationId: org,
    deactivated: false, pending: false, removed: false, managerId: '', privileges: {},
  }) as never;
items.unshift(
  employee('emp_deanna', 'Deanna Chua', 'deanna.chua@redalphacyber.com', 'Standard'),
  employee('emp_martin', 'Martin Lim', 'martin@redalphacyber.com', 'Standard'),
  employee('emp_boss', 'Bee Admin', 'boss@redalphacyber.com', 'Business Admin'),
  employee('emp_dan', 'Dan Dart', 'dan@dart.com.sg', 'Business Admin', 'org-dart'),
  { ...seed, id: 'col_owner', name: 'Pat Owner', email: 'pat@cy-bm.sg', practice: true, practiceRole: 'Owner', role: 'Business Admin', allClients: true, clientAccess: [], organisationId: '', deactivated: false, pending: false, removed: false } as never
);
save(items);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use('/api/drive', driveRouter);
const server = app.listen(4691, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const as = (email: string) =>
  `cyb_session=${jwt.sign({ sub: email, email, name: email.split('@')[0] }, 'test-session-secret', { expiresIn: '1h' })}`;
const DEANNA = as('deanna.chua@redalphacyber.com');
const MARTIN = as('martin@redalphacyber.com');
const BOSS = as('boss@redalphacyber.com');
const DAN = as('dan@dart.com.sg');
const PAT = as('pat@cy-bm.sg');

const call = async (method: string, path: string, cookie: string, body?: unknown, org = RED) => {
  const res = await fetch(`http://127.0.0.1:4691${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Org-Id': org, Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const settle = async (want: () => boolean) => {
  for (let i = 0; i < 100 && !want(); i++) await new Promise((r) => setTimeout(r, 50));
};
const linkTo = (id: string) => `https://drive.google.com/drive/u/0/folders/${id}?usp=sharing`;

const PDF = (words: string) => Buffer.from(`%PDF-1.4 ${words}`);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a receipt photo')]);

// Deanna's own folder, with what people actually leave in one.
const DEANNA_FOLDER = 'deannaFolder_0123456789abcdefghi';
put({ id: DEANNA_FOLDER, name: 'Receipts for CYBills', mimeType: FOLDER, parents: ['root'], owner: 'deanna.chua@redalphacyber.com' });
// Saved by a scanner that labels everything a byte stream.
put({ id: 'file_grab_00000000001', name: 'Grab tiffinlabs paid.pdf', mimeType: 'application/octet-stream', parents: [DEANNA_FOLDER], bytes: PDF('a Grab receipt'), owner: 'deanna.chua@redalphacyber.com' });
put({ id: 'file_photo_0000000002', name: 'IMG_4821.png', mimeType: 'image/png', parents: [DEANNA_FOLDER], bytes: PNG, owner: 'deanna.chua@redalphacyber.com' });
put({ id: 'file_docx_00000000003', name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', parents: [DEANNA_FOLDER], bytes: Buffer.from('PK not a document'), owner: 'deanna.chua@redalphacyber.com' });
put({ id: 'file_gdoc_00000000004', name: 'Invoice draft', mimeType: 'application/vnd.google-apps.document', parents: [DEANNA_FOLDER], owner: 'deanna.chua@redalphacyber.com' });
put({ id: 'subfolder_00000000005', name: 'Old', mimeType: FOLDER, parents: [DEANNA_FOLDER], owner: 'deanna.chua@redalphacyber.com' });
// …and one inside the subfolder, which is nobody's business.
put({ id: 'file_deep_00000000006', name: 'last year.pdf', mimeType: 'application/pdf', parents: ['subfolder_00000000005'], bytes: PDF('last year'), owner: 'deanna.chua@redalphacyber.com' });

// --- Whether the road is there ----------------------------------------------------
let r = await call('GET', '/api/drive/status', DEANNA);
check('the road is there, and says the address a folder is shared with', [r.body.enabled, r.body.robotEmail], [true, ROBOT]);

// --- What is not a folder link ------------------------------------------------------
r = await call('POST', '/api/drive/folders', DEANNA, { userId: 'emp_deanna', link: 'my receipts folder' });
check('words are not a link', [r.status, r.body.error], [400, 'invalid_link']);
r = await call('POST', '/api/drive/folders', DEANNA, { userId: 'emp_deanna', link: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit' });
check('a FILE link is refused as one, not connected as a folder', [r.status, r.body.error], [400, 'invalid_link']);

// --- A folder the robot has not been given ------------------------------------------
r = await call('POST', '/api/drive/folders', DEANNA, { userId: 'emp_deanna', link: linkTo('nobodySharedThis_0123456789abcd') });
check('a folder not shared with the robot says so', [r.status, r.body.error], [422, 'not_shared']);
check('…naming the address to share it with', String(r.body.message).includes(ROBOT), true);
check('no token was asked for until a folder was', minted, 1);
check('…and it was asked for as the robot, for Drive', tokens[0], { iss: ROBOT, aud: 'http://127.0.0.1:4692/token', scope: 'https://www.googleapis.com/auth/drive' });

// --- Somebody else's folder ------------------------------------------------------------
// One robot serves every client, so a folder shared with it for Dart must not be
// connectable by somebody at Red Alpha who has merely come by the link.
const DART_FOLDER = 'dartFolder_0123456789abcdefghijk';
put({ id: DART_FOLDER, name: 'Dart bills', mimeType: FOLDER, parents: ['root'], owner: 'dan@dart.com.sg' });
put({ id: 'file_dart_00000000007', name: 'UE invoice.pdf', mimeType: 'application/pdf', parents: [DART_FOLDER], bytes: PDF('United Engineers'), owner: 'dan@dart.com.sg' });
r = await call('POST', '/api/drive/folders', MARTIN, { userId: 'emp_martin', link: linkTo(DART_FOLDER) });
check('a folder that is neither theirs nor shared with them is refused', [r.status, r.body.error], [403, 'folder_not_yours']);
check('…and nothing of Dart’s was filed at Red Alpha', listBills(RED).length, 0);

// And nobody connects a folder for somebody they do not administer.
r = await call('POST', '/api/drive/folders', MARTIN, { userId: 'emp_deanna', link: linkTo(DEANNA_FOLDER) });
check('a Standard user cannot connect a folder for a colleague', r.status, 403);

// --- Connecting her own -----------------------------------------------------------------
r = await call('POST', '/api/drive/folders', DEANNA, { userId: 'emp_deanna', link: linkTo(DEANNA_FOLDER) });
check('her own folder connects', [r.status, r.body.folder?.folderName, r.body.folder?.status], [200, 'Receipts for CYBills', 'connected']);
const connection = r.body.folder.id as string;

// What was already in it is looked at straight away.
await settle(() => listBills(RED).length >= 2 && drive.get('file_photo_0000000002')!.parents[0] !== DEANNA_FOLDER);
let bills = listBills(RED);
check('the two documents in it were filed, and nothing else', bills.map((b) => b.fileName).sort(), ['Grab tiffinlabs paid.pdf', 'IMG_4821.png']);
const grab = bills.find((b) => b.fileName.startsWith('Grab'))!;
check('…under the person the folder is connected to', [grab.owner, grab.createdBy], ['deanna.chua@redalphacyber.com', 'deanna.chua@redalphacyber.com']);
check('…as what the bytes say it is, whatever Drive labelled it', grab.contentType, 'application/pdf');
check('…as a cost', grab.kind, 'cost');
check('…remembering where it came from', [grab.drive?.folderName, grab.drive?.fileId, grab.drive?.addedBy], ['Receipts for CYBills', 'file_grab_00000000001', 'deanna.chua@redalphacyber.com']);
await settle(() => listBills(RED).every((b) => b.status !== 'processing'));
check('…and out of Processing once the read ended', listBills(RED).map((b) => b.status), ['new', 'new']);

const filedFolder = created[0];
check('a Filed folder was made inside it', [created.length, drive.get(filedFolder)?.name, drive.get(filedFolder)?.parents], [1, 'Filed', [DEANNA_FOLDER]]);
check('…and the filed files moved into it', [drive.get('file_grab_00000000001')!.parents, drive.get('file_photo_0000000002')!.parents], [[filedFolder], [filedFolder]]);
check('what is not a document stays where it was put', [drive.get('file_docx_00000000003')!.parents, drive.get('file_gdoc_00000000004')!.parents], [[DEANNA_FOLDER], [DEANNA_FOLDER]]);
check('a subfolder is not gone into', drive.get('file_deep_00000000006')!.parents, ['subfolder_00000000005']);

r = await call('GET', '/api/drive/folders?userId=emp_deanna', DEANNA);
const card = r.body.folders?.[0];
check('her page shows the folder and what it has filed', [r.body.folders?.length, card?.filed, card?.lastError, card?.filedNote], [1, 2, '', '']);
const skippedRows = (card?.files ?? []).filter((f: any) => f.outcome === 'skipped').map((f: any) => [f.name, f.reason]).sort();
check('…and says why the rest were passed over', skippedRows, [
  ['Invoice draft', 'a Google Doc, not a file — download it as a PDF and save that here'],
  ['notes.docx', 'not a PDF or image'],
]);

// --- Looking again ----------------------------------------------------------------------
r = await call('POST', `/api/drive/folders/${connection}/check`, DEANNA);
check('a second look files nothing twice', [r.status, r.body.filed?.length, listBills(RED).length], [200, 0, 2]);

// --- A file saved afterwards ---------------------------------------------------------------
put({ id: 'file_new_000000000008', name: 'Singtel Sep.pdf', mimeType: 'application/pdf', parents: [DEANNA_FOLDER], bytes: PDF('Singtel September'), owner: 'deanna.chua@redalphacyber.com' });
r = await call('POST', `/api/drive/folders/${connection}/check`, DEANNA);
check('a file saved later is filed on the next look', [r.body.filed?.length, r.body.filed?.[0]?.name, r.body.moved], [1, 'Singtel Sep.pdf', 1]);
check('…into the same Filed folder, not a second one', [created.length, drive.get('file_new_000000000008')!.parents], [1, [filedFolder]]);

// --- One folder, one person ------------------------------------------------------------------
drive.get(DEANNA_FOLDER)!.sharedWith = ['martin@redalphacyber.com'];
r = await call('POST', '/api/drive/folders', MARTIN, { userId: 'emp_martin', link: DEANNA_FOLDER });
check('a folder already connected is not connected to a second person', [r.status, r.body.error], [409, 'folder_in_use']);
r = await call('POST', '/api/drive/folders', DEANNA, { userId: 'emp_deanna', link: DEANNA_FOLDER });
check('…and connecting it again to the same person changes nothing', [r.status, r.body.unchanged, r.body.folder?.id], [200, true, connection]);

// --- Who sees which folders ---------------------------------------------------------------------
r = await call('GET', '/api/drive/folders', MARTIN);
check('a Standard user sees only their own folders', [r.body.canManage, r.body.folders?.length], [false, 0]);
r = await call('GET', '/api/drive/folders', BOSS);
check('whoever runs the entity sees all of them', [r.body.canManage, r.body.folders?.map((f: any) => f.personName)], [true, ['Deanna Chua']]);
r = await call('POST', `/api/drive/folders/${connection}/check`, MARTIN);
check('somebody else’s connection is a 404, never a 403', r.status, 404);

// --- A Business Admin connects one for their own staff --------------------------------------------
// And here the Filed folder cannot be made — a robot that may not own a folder
// in somebody's My Drive — which must not take the filing with it.
const MARTIN_FOLDER = 'martinFolder_0123456789abcdefghi';
put({ id: MARTIN_FOLDER, name: 'Martin scans', mimeType: FOLDER, parents: ['root'], owner: 'martin@redalphacyber.com' });
put({ id: 'file_mart_00000000009', name: 'SPC petrol.pdf', mimeType: 'application/pdf', parents: [MARTIN_FOLDER], bytes: PDF('SPC'), owner: 'martin@redalphacyber.com' });
mayCreateFolders = false;
r = await call('POST', '/api/drive/folders', BOSS, { userId: 'emp_martin', link: linkTo(MARTIN_FOLDER) });
check('an admin connects a folder that is the person’s own', [r.status, r.body.folder?.personName], [200, 'Martin Lim']);
const martins = r.body.folder.id as string;
await settle(() => listBills(RED).some((b) => b.fileName === 'SPC petrol.pdf'));
await new Promise((res) => setTimeout(res, 200));
check('the document is filed all the same', listBills(RED).filter((b) => b.fileName === 'SPC petrol.pdf').map((b) => b.owner), ['martin@redalphacyber.com']);
check('…and stays where it was saved', drive.get('file_mart_00000000009')!.parents, [MARTIN_FOLDER]);
r = await call('GET', '/api/drive/folders?userId=emp_martin', BOSS);
check('…with the card saying why, and what to do', String(r.body.folders?.[0]?.filedNote).includes('Make a folder called Filed'), true);
r = await call('POST', `/api/drive/folders/${martins}/check`, BOSS);
check('a file left in place is still filed only once', [r.body.filed?.length, listBills(RED).filter((b) => b.fileName === 'SPC petrol.pdf').length], [0, 1]);

// Somebody makes the folder by hand, as the card asked — spelt their own way.
put({ id: 'handmade_filed_000010', name: 'filed ', mimeType: FOLDER, parents: [MARTIN_FOLDER], owner: 'martin@redalphacyber.com' });
r = await call('POST', `/api/drive/folders/${martins}/check`, BOSS);
check('a Filed folder made by hand is used', [r.body.moved, drive.get('file_mart_00000000009')!.parents], [1, ['handmade_filed_000010']]);
r = await call('GET', '/api/drive/folders?userId=emp_martin', BOSS);
check('…and the card stops saying otherwise', r.body.folders?.[0]?.filedNote, '');
mayCreateFolders = true;

// --- The practice connects one for a client ---------------------------------------------------------
// Whoever runs the practice can open every client's book already, so the
// folder need not be shared with THEM — only with the robot.
r = await call('POST', '/api/drive/folders', PAT, { userId: 'emp_dan', link: linkTo(DART_FOLDER) }, 'org-dart');
check('the practice connects a client’s folder', [r.status, r.body.folder?.orgId], [200, 'org-dart']);
const darts = r.body.folder.id as string;
await settle(() => listBills('org-dart').length > 0);
check('…and its documents go into THAT client’s book', [listBills('org-dart').map((b) => b.fileName), listBills(RED).some((b) => b.fileName === 'UE invoice.pdf')], [['UE invoice.pdf'], false]);

// --- A folder that stops being shared ----------------------------------------------------------------
drive.get(DART_FOLDER)!.visible = false;
r = await call('POST', `/api/drive/folders/${darts}/check`, DAN, undefined, 'org-dart');
check('an unshared folder is reported, in words', [r.body.ok, String(r.body.error).startsWith('CYBills can no longer open this folder')], [false, true]);
r = await call('GET', '/api/drive/folders', DAN, undefined, 'org-dart');
check('…and the card carries it', String(r.body.folders?.[0]?.lastError).includes(ROBOT), true);
drive.get(DART_FOLDER)!.visible = true;
r = await call('POST', `/api/drive/folders/${darts}/check`, DAN, undefined, 'org-dart');
check('shared again, it picks up where it left off', [r.body.ok, r.body.error], [true, '']);

// --- The clock -------------------------------------------------------------------------------------------
put({ id: 'file_clock_0000000011', name: 'Canva Oct.pdf', mimeType: 'application/pdf', parents: [DEANNA_FOLDER], bytes: PDF('Canva'), owner: 'deanna.chua@redalphacyber.com' });
await pollAllFolders();
check('the sweep files what nobody pressed a button for', listBills(RED).some((b) => b.fileName === 'Canva Oct.pdf'), true);

// --- Disconnecting, and connecting again --------------------------------------------------------------------
// A file the robot could not move is still sitting in the folder. Connecting
// the folder again must not read that as a new document.
put({ id: 'file_stuck_0000000012', name: 'Stuck.pdf', mimeType: 'application/pdf', parents: [DEANNA_FOLDER], bytes: PDF('stuck'), owner: 'deanna.chua@redalphacyber.com', editable: false });
r = await call('POST', `/api/drive/folders/${connection}/check`, DEANNA);
check('a file that cannot be moved is filed and left', [r.body.filed?.length, drive.get('file_stuck_0000000012')!.parents], [1, [DEANNA_FOLDER]]);
const countBefore = listBills(RED).length;
r = await call('DELETE', `/api/drive/folders/${connection}`, DEANNA);
check('the folder disconnects', [r.status, r.body.folder?.status], [200, 'disconnected']);
put({ id: 'file_after_0000000013', name: 'After.pdf', mimeType: 'application/pdf', parents: [DEANNA_FOLDER], bytes: PDF('after'), owner: 'deanna.chua@redalphacyber.com' });
await pollAllFolders();
check('a disconnected folder is no longer looked in', listBills(RED).length, countBefore);
r = await call('GET', '/api/drive/folders?userId=emp_deanna', DEANNA);
check('…nor shown as one of hers', r.body.folders?.length, 0);

r = await call('POST', '/api/drive/folders', DEANNA, { userId: 'emp_deanna', link: linkTo(DEANNA_FOLDER) });
check('it can be connected again', [r.status, r.body.folder?.id !== connection], [200, true]);
await settle(() => listBills(RED).some((b) => b.fileName === 'After.pdf'));
await new Promise((res) => setTimeout(res, 200));
const names = listBills(RED).map((b) => b.fileName);
check('…filing what was saved meanwhile', names.filter((n) => n === 'After.pdf').length, 1);
check('…and not, a second time, what was already filed', names.filter((n) => n === 'Stuck.pdf').length, 1);

await finish(failures, server, google);
