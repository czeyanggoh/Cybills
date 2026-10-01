// A Google Drive folder as a road into CYBills.
//
// A person shares a folder in their own Drive with CYBills' robot address and
// pastes its link on their page; whatever is saved into it is filed under them,
// the way a bill emailed to their address or sent into their WhatsApp group is.
// This is the half of that both sides have to agree on — what a pasted link
// names, which files are documents at all, and what the subfolder the filed
// ones are moved into is called — so it is pure, tested by `npm test` at the
// root, and loaded by path server-side (server/src/drive.ts) the way mileage.js
// and categoryList.js are: the link a page accepts is the link the server
// connects.

// Where a filed file is moved to, inside the folder it was saved in. The main
// folder then only ever holds what is still waiting, which is the whole point
// of moving anything.
export const FILED_FOLDER_NAME = 'Filed';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Bigger than this is not read: the reader's own limits are in this region and
// a 60 MB scan would be held in memory three times over on its way there.
export const MAX_DRIVE_FILE_BYTES = 20 * 1024 * 1024;

// A Drive id: letters, digits, '-' and '_'. Folder ids have been 19, 28 and 33
// characters over the years, so the floor is loose on purpose — what is being
// kept out is a word, not a short id.
const ID = /^[A-Za-z0-9_-]{15,}$/;

/**
 * The folder id a pasted link names, or '' when it names none.
 *
 * Takes what people actually paste: the address bar
 * (`drive.google.com/drive/folders/<id>`, with `/u/0/` and `?usp=sharing` and
 * the rest), the older `open?id=<id>`, and the bare id itself. Deliberately
 * refuses a FILE link (`/file/d/<id>`, `docs.google.com/document/d/<id>`): it
 * carries an id of exactly the same shape, and connecting it would report a
 * folder CYBills cannot list rather than a link of the wrong kind.
 */
export function folderIdFromLink(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (ID.test(raw)) return raw;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return '';
  }
  if (!/(^|\.)google\.com$/i.test(url.hostname)) return '';
  const inPath = /\/folders\/([A-Za-z0-9_-]+)/.exec(url.pathname);
  if (inPath && ID.test(inPath[1])) return inPath[1];
  // A file's link, which has an id too. Said as nothing rather than guessed at.
  if (/\/(file|document|spreadsheets|presentation|forms)\/d\//.test(url.pathname)) return '';
  const byQuery = url.searchParams.get('id') || '';
  if (ID.test(byQuery) && /\/(open|drive|folderview)/.test(url.pathname)) return byQuery;
  return '';
}

export const folderLinkFor = (id) => (id ? `https://drive.google.com/drive/folders/${id}` : '');

// The subfolder filed files are moved into — matched loosely, because the
// person may have made it themselves and typed "filed" or "FILED ".
export const isFiledFolder = (file) =>
  file?.mimeType === FOLDER_MIME &&
  String(file?.name ?? '').trim().toLowerCase() === FILED_FOLDER_NAME.toLowerCase();

// --- The name a filed file wears -------------------------------------------------
// Moved into "Filed", a file is renamed with the day it was filed and a running
// number in front of what its owner called it: `2026-10-01-0003 Singtel Sep.pdf`.
// Two reasons, and both are about the folder being read by a person later. Drive
// lets two files share a name, so the same invoice saved twice sits in Filed as
// two rows nobody can tell apart; and sorted by name the folder is then in the
// order things were filed. The owner's own name is kept whole behind the stamp,
// so a duplicate still shows as the same words twice.
//
// The number runs per folder per day and starts again at 0001 each morning — the
// date in front of it is what keeps two days' 0001 apart.
const STAMP = /^(\d{4}-\d{2}-\d{2})-(\d{4,}) /;

export const isStamped = (name) => STAMP.test(String(name ?? ''));

/** The running number a stamped name carries for `day`, or 0 when it carries none for that day. */
export function stampSeq(name, day) {
  const m = STAMP.exec(String(name ?? ''));
  return m && m[1] === day ? Number(m[2]) : 0;
}

/**
 * `name` as it is filed on `day` (YYYY-MM-DD) under running number `seq`. A name
 * that already wears a stamp is left exactly as it is: it was filed once, pulled
 * back out, and is the same file — a second stamp in front of the first would
 * say it was filed twice.
 */
export function stampedName(name, day, seq) {
  const raw = String(name ?? '').trim() || 'document';
  if (isStamped(raw)) return raw;
  return `${day}-${String(Math.max(1, Number(seq) || 1)).padStart(4, '0')} ${raw}`;
}

/**
 * The name its owner gave a file, with any filing stamp taken back off. A file
 * pulled out of "Filed" and filed again is still called what its owner called
 * it: the stamp is CYBills' own mark, and left on the document's name it would
 * put a date that is not the document's in front of a reader looking for one.
 */
export const unstampedName = (name) => String(name ?? '').replace(STAMP, '');

const NATIVE = {
  'application/vnd.google-apps.document': 'a Google Doc',
  'application/vnd.google-apps.spreadsheet': 'a Google Sheet',
  'application/vnd.google-apps.presentation': 'a Google Slides deck',
  'application/vnd.google-apps.drawing': 'a Google Drawing',
  'application/vnd.google-apps.form': 'a Google Form',
};

/**
 * Why a file in the folder is NOT taken, judged from its listing alone — before
 * anything is downloaded. '' means it is worth downloading; `ignore` means it
 * is not a file anybody saved as a document at all (a subfolder, a shortcut)
 * and is passed over without a word, where a `skip` is said on the card.
 */
export function driveSkipReason(file) {
  const type = String(file?.mimeType ?? '');
  const name = String(file?.name ?? '');
  if (type === FOLDER_MIME) return { ignore: true, reason: '' };
  if (type === 'application/vnd.google-apps.shortcut') return { ignore: true, reason: '' };
  if (NATIVE[type]) {
    return { ignore: false, reason: `${NATIVE[type]}, not a file — download it as a PDF and save that here` };
  }
  if (type.startsWith('application/vnd.google-apps.')) {
    return { ignore: false, reason: 'a Google file, not a PDF or image' };
  }
  const size = Number(file?.size ?? 0);
  if (size > MAX_DRIVE_FILE_BYTES) {
    return { ignore: false, reason: `too large to read (${(size / (1024 * 1024)).toFixed(0)} MB; the limit is 20 MB)` };
  }
  // The same filter the email road applies to an attachment, by label or name.
  // What the file really IS is decided from its bytes after the download.
  const looksRight = /pdf|png|jpe?g|gif|webp|tiff?|heic/i;
  if (!looksRight.test(type) && !looksRight.test(name.slice(name.lastIndexOf('.') + 1))) {
    // A label that says nothing (`application/octet-stream`) is downloaded and
    // judged by its bytes; one that says something else is not a document.
    if (type && type !== 'application/octet-stream') return { ignore: false, reason: 'not a PDF or image' };
  }
  return { ignore: false, reason: '' };
}

// How the state of a connection reads on a card. One place, so the person's
// page and Business settings say the same words about the same folder.
export function driveStatusLabel(folder) {
  if (!folder) return '';
  if (folder.status === 'disconnected') return 'Disconnected';
  if (folder.lastError) return 'Can’t be opened';
  return 'Connected';
}
