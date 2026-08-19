// Per-document activity log for Sales, persisted in localStorage. Dext shows a
// "Recent activity" timeline on every document; we record the real interactions
// we can observe (viewed, category changes, status moves) and synthesize the
// upload + processing-complete anchors from the document itself.

import { useEffect, useState } from 'react';

const KEY = 'cybills.sales.events.v1';
export const SALES_EVENTS_EVENT = 'cybills:sales-events-changed';

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function writeAll(map) {
  localStorage.setItem(KEY, JSON.stringify(map));
  window.dispatchEvent(new Event(SALES_EVENTS_EVENT));
}

// Display an actor label without leaking a hardcoded identity: an unknown or
// generic actor reads as "You", and an email is shortened to its local-part.
// (This used to force every generic actor to "Astrid Yang", which mislabelled
// other users' actions as the dev's.)
export function prettyActor(a) {
  const s = String(a || '').trim();
  if (!s || s.toLowerCase() === 'you') return 'You';
  return s.includes('@') ? s.split('@')[0] : s;
}

let seq = 0;
function newId() {
  seq += 1;
  return `ev_${Date.now().toString(36)}_${seq}`;
}

// Append an event for a document.
export function recordEvent(docId, evt) {
  if (!docId) return;
  const map = readAll();
  const list = Array.isArray(map[docId]) ? map[docId] : [];
  list.push({ id: newId(), at: new Date().toISOString(), ...evt });
  map[docId] = list;
  writeAll(map);
}

// Record "viewed for the first time" — only once per document.
export function recordViewed(docId, actor) {
  if (!docId) return;
  const list = readAll()[docId] || [];
  if (list.some((e) => e.type === 'viewed')) return;
  recordEvent(docId, { type: 'viewed', text: 'This item was viewed for the first time', actor });
}

export function recordCategory(docId, from, to, actor) {
  if (!docId || from === to || !to) return;
  const text = from ? `Category was changed from "${from}" to "${to}"` : `Category was set to "${to}"`;
  recordEvent(docId, { type: 'category', text, actor });
}

export function recordMove(docId, dest, actor) {
  if (!docId) return;
  recordEvent(docId, { type: 'move', text: `This item was moved to ${dest}`, actor });
}

function storedEvents(docId) {
  const list = readAll()[docId];
  return Array.isArray(list) ? list : [];
}

// Full timeline for a document (newest first): the synthesized upload +
// processing-complete anchors plus every stored interaction. `doc` supplies the
// anchor timestamp (createdAt, else the document date) and the uploader.
export function getSalesHistory(doc) {
  if (!doc) return [];
  const uploader = prettyActor(doc.user);
  const anchorIso = doc.createdAt || (doc.date ? new Date(doc.date).toISOString() : new Date().toISOString());
  const t0 = Number.isFinite(new Date(anchorIso).getTime()) ? new Date(anchorIso).getTime() : Date.now();
  const base = [
    { id: 'base_upload', type: 'upload', text: 'This item was uploaded via web', actor: uploader, at: new Date(t0).toISOString() },
    { id: 'base_processing', type: 'processing', text: 'Processing was completed', actor: 'CYBills', at: new Date(t0 + 1000).toISOString() },
  ];
  return [...base, ...storedEvents(doc.id)]
    .map((e) => ({ ...e, actor: prettyActor(e.actor) }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Re-render a component whenever the activity log changes.
export function useSalesEvents() {
  const [, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((n) => n + 1);
    window.addEventListener(SALES_EVENTS_EVENT, bump);
    return () => window.removeEventListener(SALES_EVENTS_EVENT, bump);
  }, []);
}
