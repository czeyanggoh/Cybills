// A bill can reach CYBills three ways and two of them carry a note from the
// person who sent it. Reading either into ONE shape is what stops a re-read
// quietly undoing what the note asked for — it has to find the note on the
// document, whichever road that document came in on.
import { coveringNote, hasCoveringNote, fileNameHint } from '../src/lib/coveringNote.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- Nothing to read ---------------------------------------------------------
check('a document with nothing to say carries no note', coveringNote({ supplier: 'Grab' }), null);
check('and neither does nothing at all', coveringNote(null), null);
// An upload has no message — but somebody named the file, and on that road it
// is the whole of what they said about the document.
check('an upload carries the name it was given', coveringNote({ fileName: 'Singtel tiffinlabs paid.pdf' }), {
  via: 'upload',
  from: '',
  subject: '',
  text: '',
  fileName: 'Singtel tiffinlabs paid.pdf',
});

// --- Emailed in --------------------------------------------------------------
const emailed = {
  email: { from: 'dean@acme.sg', to: 'astrid4@cybills.sg', subject: 'FW: invoice', date: '', text: 'recharge this to CY-Biz' },
};
check('an emailed note keeps its sender, subject and text', coveringNote({ ...emailed, fileName: 'inv.pdf' }), {
  via: 'email',
  from: 'dean@acme.sg',
  subject: 'FW: invoice',
  text: 'recharge this to CY-Biz',
  fileName: 'inv.pdf',
});

// --- Sent over WhatsApp ------------------------------------------------------
const chat = {
  whatsapp: {
    senderName: 'Dean',
    from: '60123456789@c.us',
    text: 'recharge this to CY-Biz',
    chatSubject: 'CYBills - Acme Pte Ltd',
  },
};
check('a WhatsApp note reads as the same kind of thing', coveringNote(chat), {
  via: 'whatsapp',
  from: 'Dean',
  // The GROUP's name is not a subject. "CYBills - Acme Pte Ltd" says which
  // client, which the reader already knows, and offering it as a subject line
  // would have it read as a fact about the document.
  subject: '',
  text: 'recharge this to CY-Biz',
  fileName: '',
});

const noName = { whatsapp: { senderName: '', from: '60123456789@c.us', text: 'pay this' } };
check('with no display name, the number stands in — without the machinery', coveringNote(noName).from, '60123456789');

// --- An envelope is not an instruction ---------------------------------------
// A file sent with no caption decided nothing, and neither did a forward with
// an empty body. Both still have an envelope worth showing on the document.
check('a caption-less file has no instruction in it', hasCoveringNote({ whatsapp: { from: '6012@c.us', text: '' } }), false);
check('nor does a wordless forward', hasCoveringNote({ email: { from: 'a@b.c', subject: 'FW:', text: '   ' } }), false);
check('a note with words in it does', hasCoveringNote(chat), true);

// --- One document, one note --------------------------------------------------
// It cannot have arrived both ways, but a merge can put two envelopes on one
// row. The email is the older road and stays the answer, rather than the shape
// changing depending on which field was written last.
check('an email wins if somehow both are present', coveringNote({ ...emailed, ...chat }).via, 'email');

// --- What a file name is worth ----------------------------------------------
// A name is offered to the reader only when a PERSON is visible in it. Most
// names are a device counting, and feeding those in spends prompt on noise —
// worse, it puts a date-shaped string in front of a reader hunting for a date.
check('a name somebody typed comes through, opened out', fileNameHint('Singtel tiffinlabs paid.pdf'), 'Singtel tiffinlabs paid');
check('…and keeps its own numbers, which are part of what they wrote', fileNameHint('INV-2026-0912 ABC Pte Ltd.pdf'), 'INV 2026 0912 ABC Pte Ltd');
check('one real word among the noise is enough', fileNameHint('Grab receipt.pdf'), 'Grab receipt');

check('a camera name says nothing', fileNameHint('IMG_4821.pdf'), '');
check('nor does a phone with a clock', fileNameHint('20260903_111825.jpg'), '');
// The one that matters most: it is nothing but a date, and a reader hunting for
// the document's date must not be shown one that came off a file system.
check('nor WhatsApp naming an image after the moment it arrived', fileNameHint('WhatsApp Image 2026-09-03 at 11.19.00.jpeg'), '');
check('nor a scanner counting', fileNameHint('Scan_0001.pdf'), '');
check('nor this app\'s own fallback', fileNameHint('whatsapp-document'), '');
check('nor a bare "receipt"', fileNameHint('receipt.pdf'), '');
check('nor nothing at all', fileNameHint(''), '');

// A name is not an instruction, however useful it is. Only a MESSAGE beats a
// standing supplier rule, and that is what hasCoveringNote answers.
check('a named file sent with no caption still holds no instruction', hasCoveringNote({ whatsapp: { from: '6012@c.us', text: '' }, fileName: 'Singtel paid.pdf' }), false);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
