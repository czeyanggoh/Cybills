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

// Returns { base64, mediaType, previewUrl }. Images larger than `maxDim` on the
// long edge (or above ~1.2MB) are re-encoded to JPEG at `maxDim`.
export async function prepareUpload(file, { maxDim = 1600, quality = 0.85 } = {}) {
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
  if (longEdge <= maxDim && file.size < 1_200_000) {
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
