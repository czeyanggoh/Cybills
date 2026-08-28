// A person's inbound email address: the handle they were given, the short form
// their entity chose, and the one domain both live on.
//
// Mirrors normaliseHandle / normaliseSuffix / localPart in server/src/users.ts,
// which is the authority — the server normalises again on the way in and has
// the last word. This exists so the address a page PREVIEWS is the address that
// gets saved, and so the two places that print one (the person's own card and
// Business settings) can't drift apart.

// The mail domain user addresses live on (mirrors INBOUND_MAIL_DOMAIN).
export const INBOUND_DOMAIN = 'cybills.sg';

export function cleanHandle(raw) {
  return String(raw || '')
    .toLowerCase()
    .split('@')[0]
    .replace(/[^a-z0-9.-]+/g, '')
    .replace(/[.-]{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
}

// An entity's short form: letters, digits and hyphens, no dots. The dot is what
// separates the person from the entity, so a suffix carrying one would leave
// the address reading as three parts with nothing to say where the split was.
export function cleanSuffix(raw) {
  return String(raw || '')
    .toLowerCase()
    .split('@')[0]
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

// "martin" + "redalpha" -> "martin.redalpha". Either half missing leaves the
// other standing on its own.
export function localPart(handle, suffix) {
  const h = cleanHandle(handle);
  const s = cleanSuffix(suffix);
  return h && s ? `${h}.${s}` : h;
}

// The whole address, or '' when there is no handle to build one from.
export function inboundAddress(handle, suffix, domain = INBOUND_DOMAIN) {
  const local = localPart(handle, suffix);
  return local ? `${local}@${domain}` : '';
}

// The fixed tail shown beside the editable handle: ".redalpha@cybills.sg", or
// just "@cybills.sg" where the entity has set no short form.
export function addressTail(suffix, domain = INBOUND_DOMAIN) {
  const s = cleanSuffix(suffix);
  return s ? `.${s}@${domain}` : `@${domain}`;
}

// Which entity's suffix a person's address carries: their own, else the
// practice's primary one — the same rule the server applies (orgIdForUser), and
// the same one an emailed document of theirs follows.
//
// A person filed under an entity that isn't in this list is somebody the caller
// cannot open the books of, so there is nothing here to read: '' shows the bare
// handle rather than borrowing the primary entity's short form, which would
// print an address that belongs to nobody.
export function suffixForUser(user, organisations) {
  const list = Array.isArray(organisations) ? organisations : [];
  const own = user?.organisationId;
  const org = own ? list.find((o) => o.id === own) : list.find((o) => o.isPrimary);
  return cleanSuffix(org?.emailSuffix || '');
}
