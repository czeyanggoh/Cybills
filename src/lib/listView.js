// What a list page was LOOKING at — which scope, which tab, what was typed and
// narrowed — kept across a trip to one of its rows and back.
//
// Every list here works the same way: you narrow it down to find something,
// open the thing you found, then come back for the next one. Held in ordinary
// component state that dies with the page, "Back" landed on an unfiltered
// Unpublished every time, and the narrowing had to be redone for each row —
// which is worst exactly where the list is longest and the filter mattered most.
//
// sessionStorage rather than a saved preference: this belongs to a stretch of
// work, not to the account. A new tab is its own, and tomorrow starts clean,
// which is what you want from a filter you set to answer one question. It is
// also why nothing here ever throws — a browser that refuses storage (private
// mode, site data blocked) simply gets the defaults it used to get.
//
// Deliberately NOT the URL. A claim page's own Previous/Next walks the list, so
// history back does not mean "the list" there, and the pages that navigate to
// `/expense-claims` by name would each have to carry the query string for it to
// survive. One store the list reads on mount is the whole mechanism.
import { useEffect, useState } from 'react';

const keyFor = (name) => `cybills.listview.${name}`;

function read(name) {
  try {
    const raw = sessionStorage.getItem(keyFor(name));
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function write(name, value) {
  try {
    sessionStorage.setItem(keyFor(name), JSON.stringify(value));
  } catch {
    /* nothing to do: the page works, it just won't remember */
  }
}

// What a stored value is worth now, given what the page expects. Pure, and its
// own function because this is the part that can quietly break a page: what was
// stored is last release's, and it is trusted only as far as its SHAPE.
//
//   * nothing stored, or a different type -> the fallback whole. A filter object
//     from before a field was added, or a scope key that no longer exists, would
//     otherwise show an empty list nobody could explain.
//   * an object -> merged OVER the fallback, so a field added since has a value
//     rather than being undefined.
//   * `fallback` may be a value or a factory, exactly as useState's initial state
//     may be. The Costs page's empty filters are a factory, and storing the
//     FUNCTION as the state is the one way this could break the page it exists
//     to help.
export function restoreView(saved, fallback) {
  const empty = typeof fallback === 'function' ? fallback() : fallback;
  if (saved === undefined || saved === null) return empty;
  if (typeof saved !== typeof empty) return empty;
  if (empty && typeof empty === 'object' && !Array.isArray(empty)) {
    return Array.isArray(saved) ? empty : { ...empty, ...saved };
  }
  return saved;
}

// useState, remembered. Same signature and the same setter — updater functions
// included — so a caller swaps one for the other and nothing else changes.
export function useListView(name, field, fallback) {
  const [value, setValue] = useState(() => restoreView(read(name)[field], fallback));
  useEffect(() => {
    write(name, { ...read(name), [field]: value });
  }, [name, field, value]);
  return [value, setValue];
}

// The ORDER of the rows a list page is showing, so its rows' Previous / Next
// walk the list the reviewer opened them from — narrowed, sorted and scoped
// the way it was on screen — rather than some other list. It lives beside the
// view above because it is the same stretch of work: what you were looking at,
// and the order you were looking at it in.
//
// The document page used to walk a list of SAMPLE documents left over from
// before there was a server, so Next from a real cost landed on "Yew Kee Two,
// 8 / 18" — a page that could not render because there was nothing behind it.
const walkKeyFor = (name) => `cybills.listwalk.${name}`;

export function rememberWalk(name, ids) {
  try {
    sessionStorage.setItem(walkKeyFor(name), JSON.stringify(ids.map(String)));
  } catch {
    /* nothing to do: Previous / Next fall back to the inbox */
  }
}

export function readWalk(name) {
  try {
    const raw = sessionStorage.getItem(walkKeyFor(name));
    const value = raw ? JSON.parse(raw) : null;
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string' || typeof v === 'number').map(String) : [];
  } catch {
    return [];
  }
}

// Where `id` stands in `ids`, and its neighbours. Pure, so the arithmetic that
// enables the two buttons and prints "3 / 41" can be held to account. An id not
// in the list is index -1 with no neighbours — the page shows "–" and disables
// both, rather than jumping somewhere from nowhere.
export function walkPosition(ids, id) {
  const list = Array.isArray(ids) ? ids.map(String) : [];
  const index = list.indexOf(String(id));
  return {
    index,
    total: list.length,
    prev: index > 0 ? list[index - 1] : null,
    next: index >= 0 && index < list.length - 1 ? list[index + 1] : null,
  };
}
