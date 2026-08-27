// The note a document arrived with, whichever road it came in on.
//
// A bill can reach CYBills three ways, and two of them carry a covering message
// from the person who sent it: an email ("recharge this to CY-Biz") and a
// WhatsApp bill collection group ("Please pay this"). They are the same KIND of
// thing — one person's instruction about THIS document, which beats a standing
// rule about every document from that supplier — so the reader is given them in
// one shape and everything downstream stops having to ask which it was.
//
// The point of reading it off the DOCUMENT rather than passing it around: a
// re-read has to see the note the first read saw. Read once with "recharge this
// to CY-Biz" and again without it, and the second read quietly undoes the
// first.
//
// Returns null when the document was simply uploaded, and there is no note.
export function coveringNote(doc) {
  if (doc?.email) {
    const { from = '', subject = '', text = '' } = doc.email;
    return { via: 'email', from, subject, text };
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
    };
  }
  return null;
}

// Whether a document arrived carrying an instruction at all — a note with words
// in it, not just an envelope. An emailed attachment with an empty body decided
// nothing, and neither did a WhatsApp file sent with no caption.
export const hasCoveringNote = (doc) => Boolean(coveringNote(doc)?.text?.trim());
