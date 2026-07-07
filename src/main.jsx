import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

// Stale-bundle recovery. Vite emits `vite:preloadError` when a dynamic import
// can't fetch its chunk — almost always because the user's tab was loaded
// against a previous deploy and the asset filename has since changed. Reloading
// once picks up the fresh index.html with the new chunk hashes. Guarded by a
// session flag so a genuinely broken chunk (404 even after reload) doesn't spin
// in an infinite reload loop — the second time the error fires we let it surface.
const STALE_RELOAD_KEY = '__cybills_preload_reloaded__';
window.addEventListener('vite:preloadError', (event) => {
  if (sessionStorage.getItem(STALE_RELOAD_KEY)) {
    sessionStorage.removeItem(STALE_RELOAD_KEY);
    return; // already tried once; let the error bubble
  }
  sessionStorage.setItem(STALE_RELOAD_KEY, '1');
  event.preventDefault?.();
  window.location.reload();
});
window.addEventListener('load', () => {
  setTimeout(() => sessionStorage.removeItem(STALE_RELOAD_KEY), 0);
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
