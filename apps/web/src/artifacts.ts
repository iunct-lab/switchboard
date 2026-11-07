import type { Artifact } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { panels as m } from "./i18n/panels.ts";

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

/**
 * What コピー on the artifact's bar copies (#3687): a file's text (text, Markdown, a page's or an SVG's source), a link's
 * URL, or nothing (an image, a folder, a file only the browser can open).
 */
export function copyKind(a: Pick<Artifact, "kind" | "mime">): "content" | "url" | null {
  if (a.kind === "url") return "url";
  if (a.kind !== "file") return null;
  const how = viewOf(a);
  return how === "text" || how === "frame" ? "content" : null;
}

/** A Markdown file (#3677): shown as text, with the プレビュー / テキスト switch. A URL artifact never is. */
export function isMarkdown(a: Pick<Artifact, "kind" | "mime">): boolean {
  return a.kind !== "url" && a.mime.toLowerCase() === "text/markdown";
}

/**
 * A throwaway app (#3683): an artifact whose page read the API through the screen on some day, or did so now. Its row
 * offers 要望にする; once Switchboard started a request for it, the row links that Task.
 */
export function appRequestOf(use: { appDays: number; appRequestTaskId: string | null }, usedNow: boolean): { offer: boolean; taskId: string | null } {
  return { offer: usedNow || use.appDays > 0, taskId: use.appRequestTaskId };
}

/**
 * The draft 要望にする opens the feedback dialog with: the same words the daemon files on the 3rd day. It is sent to the
 * daemon as the request's text, so it is not translated (docs/design/ui-language.md).
 */
export function appRequestDraft(title: string): string {
  // ui-strings: value "使い捨てアプリ「…」を一般機能にしたい。" — sent to the daemon as the request's text
  return `使い捨てアプリ「${title}」を一般機能にしたい。`;
}

/** The tab's name: the count shows once there is something. */
export function artifactsLabel(n: number): string {
  return n > 0 ? t(m.artifactsCount, { n }) : t(m.artifacts);
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

/**
 * Whether a page or SVG cannot be shown in its frame (#4062): reading its text answered an error (the file is gone, the
 * key expired). The frame would show the server's own error body; the screen says so in words instead.
 */
export const frameUnavailable = (readStatus: number | null): boolean => readStatus !== null && readStatus >= 400;
