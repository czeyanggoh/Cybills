// The note a document arrived with, whichever road it came in on.
//
// A bill can reach CYBills three ways, and two of them carry a covering message
// from the person who sent it: an email ("recharge this to CY-Biz") and a
// WhatsApp bill collection group ("Please pay this"). They are the same KIND of
// thing — one person's instruction about THIS document, which beats a standing
// rule about every document from that supplier — so the reader is given them in
// one shape and everything downstream stops having to ask which it was.
//
// The third road carries something weaker, and every road carries it: the NAME
// of the file. "Singtel tiffinlabs paid.pdf" is what the sender called it, and
// it is often the only place the covering thought was written down — the file
// was sent into a group with no caption at all. So it travels in the same
// envelope, marked as what it is (see fileNameHint below).
//
// The point of reading it off the DOCUMENT rather than passing it around: a
// re-read has to see the note the first read saw. Read once with "recharge this
// to CY-Biz" and again without it, and the second read quietly undoes the
// first.
//
// Returns null only when there is nothing at all to say — no message, and not
// even a file name.
export function coveringNote(doc) {
  const fileName = String(doc?.fileName || '');
  if (doc?.email) {
    const { from = '', subject = '', text = '' } = doc.email;
    return { via: 'email', from, subject, text, fileName };
  }
  const wa = doc?.whatsapp;
  if (wa) {
    return {
      via: 'whatsapp',
      // Who, as a person reads it: the name WhatsApp gave, else the number
      // without the '@c.us' machinery on the end.
      from: wa.senderName || String(wa.from || '').split('@')[0] || '',
      // A chat has no subject. The group's name is not one — "CYBills - Acme
      // Pte Ltd" says which client, which the reader already knows, and
      // offering it as the subject line would have it read as a fact about
      // the document.
      subject: '',
      text: wa.text || '',
      fileName,
    };
  }
  // Uploaded, so nobody wrote anything — but they still named the file, and on
  // this road that name is the whole of what the sender said.
  if (fileName) return { via: 'upload', from: '', subject: '', text: '', fileName };
  return null;
}

// Whether a document arrived carrying an INSTRUCTION at all — a note with words
// in it, not just an envelope. An emailed attachment with an empty body decided
// nothing, and neither did a WhatsApp file sent with no caption.
//
// Deliberately not satisfied by a file name. A name is a label somebody typed
// once, usually to find the file again; a message is a person telling us what
// to do with this document, and only that is allowed to beat a standing rule.
export const hasCoveringNote = (doc) => Boolean(coveringNote(doc)?.text?.trim());

// --- What a file name is worth ----------------------------------------------
// Most file names say nothing. A phone names a photo after its sensor and the
// clock, a scanner counts, and this app itself falls back to "document" — so
// feeding every name to the reader would spend prompt on noise and, worse, put
// a date-shaped string ("WhatsApp Image 2026-09-03 at 11.19.00") in front of a
// reader whose job at that moment is to find the document's date.
//
// So a name is offered only when a PERSON is visible in it: at least one word
// that is neither a counter nor one of the words every device uses. What comes
// back is the name as they wrote it, minus the extension and with its
// separators opened out — "Singtel tiffinlabs paid" — because the words are the
// evidence and re-ordering them would be inventing.
const NOISE = new Set([
  // What devices and apps call a file when nobody named it
  'img', 'image', 'images', 'photo', 'photos', 'pic', 'picture', 'pxl', 'dsc', 'dcim',
  'screenshot', 'screen', 'shot', 'scan', 'scanned', 'scanner', 'capture', 'camera',
  'whatsapp', 'wa', 'download', 'downloads', 'attachment', 'untitled', 'unnamed',
  // What this app and its users call one when it has no name of its own
  'document', 'documents', 'doc', 'docs', 'file', 'files', 'receipt', 'copy', 'new',
  'final', 'temp', 'tmp', 'output', 'export', 'page', 'pages', 'at', 'and', 'the', 'of',
]);

export function fileNameHint(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  // Drop the extension, then open out the separators people type instead of
  // spaces. Nothing else is rewritten: the words are the evidence.
  const stem = raw.replace(/\.[a-z0-9]{1,5}$/i, '');
  const opened = stem.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!opened) return '';
  // A word somebody chose: three or more letters, and not one of the words a
  // device would have written by itself.
  const meant = opened
    .split(' ')
    .some((w) => {
      const letters = w.replace(/[^a-z]/gi, '').toLowerCase();
      return letters.length >= 3 && !NOISE.has(letters);
    });
  return meant ? opened.slice(0, 120) : '';
}
