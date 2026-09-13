// Escape closes the popup on top, whichever popup that is.
//
// Every dialog, drawer, lightbox and menu in the app is a hand-built
// `fixed inset-0` layer, and nearly fifty of them each close their own way, so
// Escape is answered HERE, once, by pressing the control that already closes
// the top one — rather than fifty listeners that each have to remember to exist
// and to stand aside for the one stacked above them. Pressing the control
// (never calling anything behind it) is what keeps this honest: a Close button
// that is disabled mid-save stays shut to Escape too, and whatever a popup does
// on closing — the claim-added dialog moving on to the next document — happens
// exactly as it does for a click.
//
// A control that answers Escape itself (a dropdown, an inline edit reverting)
// calls preventDefault, and this stands aside.

const OVERLAY = '.fixed.inset-0';
// What closes a popup, strongest first: an explicit marker for a close control
// with some other name ("Done"), then the X every dialog carries.
const CLOSE_BUTTON = '[data-escape-close], button[aria-label="Close"], button[aria-label^="Close "], button[aria-label="Dismiss"]';

const zOf = (el) => {
  const z = Number.parseInt(getComputedStyle(el).zIndex, 10);
  return Number.isFinite(z) ? z : 0;
};

// The top layer: highest z-index, and of equals the one later in the page,
// which is the one painted over the other.
export function topOverlay(root = document) {
  const shown = [...root.querySelectorAll(OVERLAY)].filter((el) => el.getClientRects().length > 0);
  let top = null;
  for (const el of shown) {
    if (!top || zOf(el) > zOf(top) || (zOf(el) === zOf(top) && top.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      top = el;
    }
  }
  return top;
}

// What to press to close that layer, or null when nothing on it closes it.
export function closeControlFor(overlay) {
  if (!overlay) return null;
  // A menu's invisible click-catcher: pressing it is how the menu closes.
  if (overlay.getAttribute('aria-hidden') === 'true') return overlay;
  // The popup's own close control — not one belonging to a layer nested in it.
  const button = [...overlay.querySelectorAll(CLOSE_BUTTON)].find((b) => b.closest(OVERLAY) === overlay);
  if (button) return button;
  // A dialog with Cancel but no X closes on its dimmed backdrop.
  const backdrop = [...overlay.children].find((c) => c.getAttribute('aria-hidden') === 'true' && c.classList.contains('inset-0'));
  if (backdrop) return backdrop;
  // The rest close on a click on the layer itself; one that doesn't simply
  // ignores the press.
  return overlay;
}

export function installEscapeToClose(target = window) {
  const onKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const control = closeControlFor(topOverlay());
    if (!control) return;
    e.preventDefault();
    control.click();
  };
  // Bubbling on window, so it runs after every document- and element-level
  // handler has had the chance to claim the key.
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
