/**
 * Switching a tab that only changes ?tab= (the Actions page, 0286) reloads nothing: the page
 * already has every row, so a reload would only add a wait (link audit 2026-10-20).
 */
export function onlyParamChanged(current: URL, next: URL, param: string): boolean {
  if (current.pathname !== next.pathname) return false;
  const a = new URLSearchParams(current.search);
  const b = new URLSearchParams(next.search);
  if (a.get(param) === b.get(param)) return false;
  a.delete(param);
  b.delete(param);
  a.sort();
  b.sort();
  return a.toString() === b.toString();
}
