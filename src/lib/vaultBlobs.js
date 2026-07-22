// Uploaded Vault file bytes live in IndexedDB, keyed by the vault file id. Real
// documents (PDFs, images) would blow localStorage's ~5MB quota, so the bytes go
// to IDB while the metadata stays in the localStorage vault store. This is what
// lets the detail page preview the file and Copy-to-Costs/Sales forward it.

const DB = 'cybills-vault';
const STORE = 'blobs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Store a File/Blob for a vault file id. Best-effort — resolves even on failure
// so a storage hiccup never blocks the upload's metadata record.
export async function putVaultBlob(id, file) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ blob: file, type: file.type || '', name: file.name || '' }, id);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore — the file just won't have a stored preview */
  }
}

// Returns { blob, type, name } or null.
export async function getVaultBlob(id) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function deleteVaultBlob(id) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => resolve(undefined);
    });
  } catch {
    /* ignore */
  }
}
