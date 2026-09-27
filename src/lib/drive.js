import { useCallback, useEffect, useState } from 'react';
import { getActiveOrganisationId } from '@/lib/organisations';

// Bill collection through a Google Drive folder, from the browser's side.
//
// The third pipe a person has, beside their inbound address and their WhatsApp
// group: they share a folder in their own Drive with CYBills' robot address and
// paste its link, and what is saved into it is filed under them. This is the
// thin client over the routes — connecting a folder, looking in it now, and
// reading back what became of what was found. The looking itself happens on the
// server's clock; nothing here polls.

const orgHeaders = () => {
  const id = getActiveOrganisationId();
  return id ? { 'X-Org-Id': id } : {};
};

const EMPTY = { folders: [], enabled: false, robotEmail: '', canManage: false, loading: true };

async function send(path, init, fallback) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const err = new Error(data?.message || fallback);
  err.code = data?.error || '';
  throw err;
}

// One person's folders — the card on their own page. Deliberately not
// entity-scoped, for the reason the WhatsApp one is not: a colleague's folder
// files into the practice's own organisation while the browser usually sits in
// some client entity, and their page still has to find it.
export function useDriveForUser(userId) {
  const [state, setState] = useState(EMPTY);

  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetch(`/api/drive/folders?userId=${encodeURIComponent(userId)}`);
      const data = res.ok ? await res.json() : null;
      setState({
        folders: data?.folders ?? [],
        enabled: Boolean(data?.enabled),
        robotEmail: data?.robotEmail ?? '',
        canManage: Boolean(data?.canManage),
        loading: false,
      });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, [userId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return [state, reload];
}

// Every folder the entity open in the browser collects through — or, for
// somebody who does not run it, their own.
export function useDriveFolders() {
  const [state, setState] = useState(EMPTY);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/drive/folders', { headers: orgHeaders() });
      const data = res.ok ? await res.json() : null;
      setState({
        folders: data?.folders ?? [],
        enabled: Boolean(data?.enabled),
        robotEmail: data?.robotEmail ?? '',
        canManage: Boolean(data?.canManage),
        loading: false,
      });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return [state, reload];
}

// Connect a folder to a person. Nothing is made in Drive — the folder exists
// and has been shared with the robot by whoever owns it; this records whose
// book its contents are filed into. Throws with the server's own sentence,
// which is the instruction ("share it with … as an Editor").
export const connectDriveFolder = ({ userId, link }) =>
  send(
    '/api/drive/folders',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, link }) },
    'Could not connect the folder.'
  );

// Look in it now rather than at the next tick of the clock, and say what was
// found: what was filed, what was passed over and why.
export const checkDriveFolder = (id) =>
  send(
    `/api/drive/folders/${encodeURIComponent(id)}/check`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    'Could not look in the folder.'
  );

// Stop collecting from it. Nothing is touched in Drive, and the documents
// already filed stay in the book.
export const disconnectDriveFolder = (id) =>
  send(`/api/drive/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not disconnect the folder.');
