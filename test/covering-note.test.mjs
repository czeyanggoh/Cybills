// A bill can reach CYBills three ways and two of them carry a note from the
// person who sent it. Reading either into ONE shape is what stops a re-read
// quietly undoing what the note asked for — it has to find the note on the
// document, whichever road that document came in on.
import { coveringNote, hasCoveringNote } from '../src/lib/coveringNote.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

// --- Nothing to read ---------------------------------------------------------
check('an uploaded document carries no note', coveringNote({ supplier: 'Grab' }), null);
check('and neither does nothing at all', coveringNote(null), null);

// --- Emailed in --------------------------------------------------------------
const emailed = {
  email: { from: 'dean@acme.sg', to: 'astrid4@cybills.sg', subject: 'FW: invoice', date: '', text: 'recharge this to CY-Biz' },
};
check('an emailed note keeps its sender, subject and text', coveringNote(emailed), {
  via: 'email',
  from: 'dean@acme.sg',
  subject: 'FW: invoice',
  text: 'recharge this to CY-Biz',
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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
