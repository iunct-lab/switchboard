import type { Artifact } from "@switchboard/protocol";

/** How the 成果物 tab shows one: in a sandboxed frame, as an image, as text, or by handing it to the browser. */
export type ArtifactView = "frame" | "image" | "text" | "external";

export function viewOf(a: Pick<Artifact, "kind" | "mime">): ArtifactView {
  if (a.kind === "url") return "external";
  const mime = a.mime.toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml" || mime === "image/svg+xml") return "frame";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/yaml" || mime === "application/xml") return "text";
  return "external";
}

/** The tab's name: the count shows once there is something. */
export function artifactsLabel(n: number): string {
  return n > 0 ? `成果物（${n}）` : "成果物";
}

/**
 * Which artifact the 成果物 tab shows once its list was read (#1778): the requested one when it is in the list; otherwise the
 * current one when it still is, else the first (null on an empty list). `gone` says a requested one is not in the list.
 */
export function pickArtifact(list: Pick<Artifact, "id">[], want: string | undefined, current: string | null): { id: string | null; gone: boolean } {
  const has = (id: string | null | undefined) => !!id && list.some((a) => a.id === id);
  if (want && has(want)) return { id: want, gone: false };
  return { id: has(current) ? current : (list[0]?.id ?? null), gone: !!want };
}
