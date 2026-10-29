// Prepare an uploaded file for sending to the backend: downscale large images
// so the base64 payload stays well under the server body limit (a phone photo
// can be several MB → >10MB once base64-encoded). Also keeps the reader fast
// and cheap. Non-images (PDFs) pass through unchanged.

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// The image types the reader takes. Anything else that is an image is sent as
// a JPEG, or the read is skipped (VISION_MEDIA in bills.js) and the document
// lands as "Nothing read".
const READER_IMAGES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// An iPhone photo. Chrome and Edge cannot draw one, Windows often gives it no
// type at all, and neither reader accepts it — so six claim photos uploaded as
// .HEIC were filed without ever being read (Yakson, 29 Oct 2026). Known by its
// type, else its name.
export function isHeic(type, name = '') {
  return /^image\/hei[cf]/i.test(String(type || '')) || /\.hei[cf]$/i.test(String(name || ''));
}

// HEIC bytes to a JPEG blob. The decoder is a few MB of WebAssembly, so it is
// fetched only when a HEIC file actually turns up. Null when it cannot decode.
async function heicToJpeg(blob, quality) {
  try {
    // heic-to, not heic2any: heic2any's libheif is too old for a current
    // iPhone's HEIC and answers "format not supported" (tried on Yakson's).
    const { heicTo } = await import('heic-to');
    return await heicTo({ blob, type: 'image/jpeg', quality });
  } catch {
    return null;
  }
}

// A stored file the reader cannot take, made into one it can: a HEIC document
// uploaded before the upload converted them is re-read as a JPEG. Anything
// else is returned as it is.
export async function readableForReader(base64, mediaType, name = '') {
  if (!isHeic(mediaType, name)) return { base64, mediaType };
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const jpeg = await heicToJpeg(new Blob([bytes], { type: 'image/heic' }), 0.85);
  if (!jpeg) return { base64, mediaType };
  const { base64: out, mediaType: type } = await prepareUpload(new File([jpeg], 'photo.jpg', { type: 'image/jpeg' }));
  return { base64: out, mediaType: type };
}

// Returns { base64, mediaType, previewUrl }. Images larger than `maxDim` on the
// long edge (or above ~1.2MB) are re-encoded to JPEG at `maxDim`, and so is any
// image in a format the reader does not take. A HEIC photo is converted first.
export async function prepareUpload(file, { maxDim = 1600, quality = 0.85 } = {}) {
  if (isHeic(file.type, file.name)) {
    const jpeg = await heicToJpeg(file, quality);
    if (jpeg) file = new File([jpeg], String(file.name || 'photo').replace(/\.hei[cf]$/i, '') + '.jpg', { type: 'image/jpeg' });
  }
  if (!file.type.startsWith('image/')) {
    const dataUrl = await readDataUrl(file);
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: file.type, previewUrl: URL.createObjectURL(file) };
  }

  const dataUrl = await readDataUrl(file);
  let img;
  try {
    img = await loadImage(dataUrl);
  } catch {
    // Can't decode (e.g. unusual format) — send the original bytes as-is.
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: file.type, previewUrl: dataUrl };
  }

  const longEdge = Math.max(img.width, img.height);
  if (longEdge <= maxDim && file.size < 1_200_000 && READER_IMAGES.includes(file.type)) {
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: file.type, previewUrl: dataUrl };
  }

  const scale = Math.min(1, maxDim / longEdge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: file.type, previewUrl: dataUrl };
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const outUrl = canvas.toDataURL('image/jpeg', quality);
  return { base64: outUrl.slice(outUrl.indexOf(',') + 1), mediaType: 'image/jpeg', previewUrl: outUrl };
}
