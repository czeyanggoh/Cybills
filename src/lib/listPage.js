// A long list shown fifty rows at a time.
//
// All costs is the whole book bar the set-aside pile, so it grows by every
// document a client ever sends, and a table of a few hundred rows — each with
// a category picker and a tax-rate picker in it — is slow to draw and slower
// to find anything in. So the table shows one PAGE of the list, and the list
// itself is unchanged: the search, the filters, the sort, Export, the badge
// counts and the document page's Previous / Next all read every row, because
// those are questions about the list, not about what happens to fit on screen.
//
// Pure, so the arithmetic that prints "51–100 of 312" and enables the two
// buttons can be held to account (`npm test`, list-page).

// Rows per page. 0 is every row, the old behaviour, kept for the reviewer who
// wants to scroll and ctrl-F.
export const PAGE_SIZES = [50, 100, 200, 0];
export const DEFAULT_PAGE_SIZE = 50;

export function pageSizeOf(size) {
  return PAGE_SIZES.includes(size) ? size : DEFAULT_PAGE_SIZE;
}

// Which slice of `total` rows page `page` is. A page past the end — the list
// shrank under it, a row was archived off the last page — is the last page, so
// the table never stands empty above a "Showing 0 of 51".
export function pageOf(total, size, page) {
  const n = Math.max(0, Number(total) || 0);
  const per = pageSizeOf(size);
  if (per === 0 || n === 0) return { page: 0, pages: 1, start: 0, end: n };
  const pages = Math.ceil(n / per);
  const p = Math.min(Math.max(0, Math.floor(Number(page) || 0)), pages - 1);
  return { page: p, pages, start: p * per, end: Math.min(n, (p + 1) * per) };
}

// Changing the page size keeps the first row on screen on screen: on rows
// 101–150 at 50 a page, 200 a page is the page holding row 101 (1–200), not
// a jump back to the top for no reason.
export function pageForSize(start, size) {
  const per = pageSizeOf(size);
  return per === 0 ? 0 : Math.floor(Math.max(0, start) / per);
}

// The page a list is on, remembered alongside WHAT it was narrowed to. A new
// search, filter, sort, tab or scope is a different list, and page 4 of the
// old one means nothing in it — so a page stored against another narrowing
// reads as the first page. Derived rather than reset by an effect, which would
// also fire on mount and throw away the page somebody came back to.
export function currentPage(saved, key) {
  return saved && typeof saved === 'object' && saved.at === key ? Math.max(0, Number(saved.n) || 0) : 0;
}
