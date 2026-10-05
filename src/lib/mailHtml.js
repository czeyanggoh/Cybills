// A mail's HTML part, made safe to draw.
//
// An order confirmation is laid out in its HTML part; the text part of the
// same message is a flattened copy. So the message is shown from the markup —
// and markup from a public catch-all address is a stranger's, so nothing in it
// may run, load or phone home. Three layers, each enough for what it covers:
// the markup is parsed INERT (DOMParser runs nothing and fetches nothing) and
// everything that could act is taken out; the page it is written into carries
// a policy that allows no script and no remote resource; and the frame it is
// drawn in is sandboxed without scripts or forms.
//
// Remote images are dropped, the way a mail client holds them back: fetching
// one tells the sender the message was opened, and by whom.

const DROP =
  'script,iframe,frame,frameset,object,embed,applet,form,input,button,select,textarea,link,meta,base,title,noscript,svg,math,audio,video,source,template';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A stylesheet with nothing left in it that reaches the network.
const cleanCss = (css) =>
  String(css ?? '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(?!data:)[^)]*\)/gi, 'none')
    .replace(/expression\s*\(/gi, '(');

/** `{ styles, body }` — the mail's own CSS and its body markup, sanitised. */
export function sanitiseMailHtml(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  doc.querySelectorAll('img').forEach((img) => {
    if (!/^data:image\//i.test(img.getAttribute('src') || '')) img.remove();
  });
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || name === 'srcset' || name === 'background' || name === 'srcdoc') {
        el.removeAttribute(attr.name);
      } else if (name === 'style') {
        el.setAttribute('style', cleanCss(value));
      } else if (
        (name === 'href' || name === 'src' || name === 'action' || name === 'xlink:href') &&
        !/^(https?:|mailto:|tel:|data:image\/|#)/i.test(value)
      ) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  const styles = [...doc.querySelectorAll('style')].map((s) => cleanCss(s.textContent)).join('\n');
  doc.querySelectorAll('style').forEach((s) => s.remove());
  return { styles, body: doc.body ? doc.body.innerHTML : '' };
}

const BASE_CSS = `
  html { background: #fff; }
  body { margin: 0; padding: 12px; background: #fff; color: #1f2937;
         font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
         overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #1d4ed8; }
  .cyb-mail-head { margin: 0 0 16px; padding: 0 0 12px; border-bottom: 1px solid #d1d5db; }
  .cyb-mail-head .cap { font-size: 11px; color: #6b7280; margin: 0 0 8px; }
  .cyb-mail-head h1 { font-size: 18px; margin: 0 0 8px; color: #111; }
  .cyb-mail-head table { border-collapse: collapse; font-size: 13px; }
  .cyb-mail-head td { padding: 1px 12px 1px 0; vertical-align: top; }
  .cyb-mail-head td:first-child { color: #6b7280; }
`;

// The envelope, printed above the message where the page stands alone (a PDF).
function headBlock(env) {
  if (!env) return '';
  const row = (label, value) => (value ? `<tr><td>${label}</td><td>${esc(value)}</td></tr>` : '');
  return `<div class="cyb-mail-head">${env.caption ? `<p class="cap">${esc(env.caption)}</p>` : ''}<h1>${esc(
    env.subject || '(no subject)'
  )}</h1><table>${row('From', env.from)}${row('To', env.to)}${row('Date', env.date)}</table></div>`;
}

/** A whole document for an iframe's `srcdoc`: the mail, and nothing that acts. */
export function mailFrameDoc(html, envelope = null) {
  const { styles, body } = sanitiseMailHtml(html);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><base target="_blank"><style>${BASE_CSS}</style><style>${styles.replace(
    /<\/style/gi,
    ''
  )}</style></head><body>${headBlock(envelope)}${body}</body></html>`;
}

/** What the frame may do: open a link in a new tab, and be measured. Never run. */
export const MAIL_FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';
