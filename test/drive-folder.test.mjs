// What a pasted Google Drive link names, and which files in a folder are
// documents at all. Both sides read these rules — the page to refuse a link
// before it is sent, the server to connect it — so they are tested once, here.
import {
  folderIdFromLink,
  folderLinkFor,
  isFiledFolder,
  driveSkipReason,
  driveStatusLabel,
  stampedName,
  stampSeq,
  isStamped,
  FOLDER_MIME,
} from '../src/lib/driveFolder.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123-_';

// --- What people paste ----------------------------------------------------------
check('the address bar', folderIdFromLink(`https://drive.google.com/drive/folders/${ID}`), ID);
check('…with an account in it, and sharing parameters', folderIdFromLink(`https://drive.google.com/drive/u/2/folders/${ID}?usp=sharing&resourcekey=0-abc`), ID);
check('…without the scheme', folderIdFromLink(`drive.google.com/drive/folders/${ID}`), ID);
check('…with spaces round it', folderIdFromLink(`  https://drive.google.com/drive/folders/${ID}  `), ID);
check('the older open?id= form', folderIdFromLink(`https://drive.google.com/open?id=${ID}`), ID);
check('the bare id', folderIdFromLink(ID), ID);
check('a mobile link', folderIdFromLink(`https://drive.google.com/drive/mobile/folders/${ID}`), ID);

// --- What is not a folder -------------------------------------------------------
check('nothing', folderIdFromLink(''), '');
check('words', folderIdFromLink('my receipts folder'), '');
check('a short word is not an id', folderIdFromLink('receipts'), '');
check('a file link carries an id of the same shape, and is not a folder', folderIdFromLink(`https://drive.google.com/file/d/${ID}/view`), '');
check('nor is a Google Doc', folderIdFromLink(`https://docs.google.com/document/d/${ID}/edit`), '');
check('nor a Sheet', folderIdFromLink(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`), '');
check('a folder on somebody else’s site is not a Drive folder', folderIdFromLink(`https://drive.example.com/drive/folders/${ID}`), '');
check('…however the host is dressed', folderIdFromLink(`https://drive.google.com.evil.example/drive/folders/${ID}`), '');
check('My Drive itself names no folder', folderIdFromLink('https://drive.google.com/drive/my-drive'), '');

check('the link back out', folderLinkFor(ID), `https://drive.google.com/drive/folders/${ID}`);
check('…of nothing is nothing', folderLinkFor(''), '');

// --- The Filed subfolder --------------------------------------------------------
check('Filed', isFiledFolder({ name: 'Filed', mimeType: FOLDER_MIME }), true);
check('…as somebody typed it', isFiledFolder({ name: ' filed ', mimeType: FOLDER_MIME }), true);
check('a FILE called Filed is not it', isFiledFolder({ name: 'Filed', mimeType: 'application/pdf' }), false);
check('nor a folder called something else', isFiledFolder({ name: 'Filed 2025', mimeType: FOLDER_MIME }), false);

// --- Which files are documents ---------------------------------------------------
const verdict = (file) => {
  const v = driveSkipReason(file);
  return v.ignore ? 'ignored' : v.reason || 'taken';
};
check('a PDF', verdict({ name: 'Singtel Sep.pdf', mimeType: 'application/pdf', size: '20000' }), 'taken');
check('a photo', verdict({ name: 'IMG_4821.jpg', mimeType: 'image/jpeg', size: '900000' }), 'taken');
check('a PDF a scanner called a byte stream', verdict({ name: 'scan.pdf', mimeType: 'application/octet-stream', size: '20000' }), 'taken');
check('a byte stream with no name to go on is judged by its bytes', verdict({ name: 'scan0001', mimeType: 'application/octet-stream', size: '20000' }), 'taken');
check('an iPhone photo is filed, as it is by email', verdict({ name: 'IMG_0012.HEIC', mimeType: 'image/heic', size: '20000' }), 'taken');
check('a subfolder is passed over without a word', verdict({ name: 'Old', mimeType: FOLDER_MIME }), 'ignored');
check('…and so is a shortcut', verdict({ name: 'Invoice', mimeType: 'application/vnd.google-apps.shortcut' }), 'ignored');
check('a Word document', verdict({ name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: '500' }), 'not a PDF or image');
check('a spreadsheet', verdict({ name: 'claims.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: '500' }), 'not a PDF or image');
check(
  'a Google Doc says what to do about it',
  verdict({ name: 'Invoice draft', mimeType: 'application/vnd.google-apps.document' }),
  'a Google Doc, not a file — download it as a PDF and save that here'
);
check(
  'a file too large to read',
  verdict({ name: 'everything.pdf', mimeType: 'application/pdf', size: String(45 * 1024 * 1024) }),
  'too large to read (45 MB; the limit is 20 MB)'
);

// --- The name a filed file wears -----------------------------------------------------
check('the day and a running number in front of its own name', stampedName('Singtel Sep.pdf', '2026-10-01', 3), '2026-10-01-0003 Singtel Sep.pdf');
check('four digits, and more when a day needs them', [stampedName('a.pdf', '2026-10-01', 12), stampedName('a.pdf', '2026-10-01', 12345)], ['2026-10-01-0012 a.pdf', '2026-10-01-12345 a.pdf']);
check('the numbers start at one', stampedName('a.pdf', '2026-10-01', 0), '2026-10-01-0001 a.pdf');
check('a name already stamped is not stamped again', stampedName('2026-09-30-0007 Singtel Sep.pdf', '2026-10-01', 3), '2026-09-30-0007 Singtel Sep.pdf');
check('a file with no name still gets one', stampedName('', '2026-10-01', 1), '2026-10-01-0001 document');
check('a date somebody put in a name themselves is not a stamp', [isStamped('2026-10-01 Singtel.pdf'), isStamped('2026-10-01-Singtel.pdf'), isStamped('Invoice 2026-10-01-0003.pdf')], [false, false, false]);
check('…so it is stamped like any other', stampedName('2026-10-01 Singtel.pdf', '2026-10-01', 2), '2026-10-01-0002 2026-10-01 Singtel.pdf');
check('the number a stamped name carries for the day', stampSeq('2026-10-01-0003 Singtel Sep.pdf', '2026-10-01'), 3);
check('…and none for another day', stampSeq('2026-09-30-0007 Singtel Sep.pdf', '2026-10-01'), 0);
check('…nor for a name with no stamp', stampSeq('Singtel Sep.pdf', '2026-10-01'), 0);

// --- How a connection reads ---------------------------------------------------------
check('connected', driveStatusLabel({ status: 'connected', lastError: '' }), 'Connected');
check('connected, but unreachable', driveStatusLabel({ status: 'connected', lastError: 'unshared' }), 'Can’t be opened');
check('disconnected', driveStatusLabel({ status: 'disconnected', lastError: '' }), 'Disconnected');

process.exit(failures ? 1 : 0);
