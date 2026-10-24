/**
 * Reading `/api/health` again while the page stays open (#1600): the archive banner and the runners' logins change
 * after the first read, and a phone keeps the page open for days. Again when the page comes back to the front, and
 * every `everyMs` while it is visible; never while hidden. Returns the stop.
 */
export function watchHealth(doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">, refresh: () => void, everyMs: number): () => void {
  const again = () => {
    if (doc.visibilityState === "visible") refresh();
  };
  doc.addEventListener("visibilitychange", again);
  const timer = setInterval(again, everyMs);
  return () => {
    doc.removeEventListener("visibilitychange", again);
    clearInterval(timer);
  };
}
