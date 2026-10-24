import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import type { Attachment } from "@switchboard/protocol";
import { api } from "../api.ts";

/** Same limits as the daemon (`packages/core/src/attachments.ts`); checked here first so a too-big drop never leaves the browser. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

/** What a transcript row carries (the `attachment` AgentEvent); the full record adds `path` and `taskId`. */
export type AttachmentRef = { id: string; name: string; mime: string; size: number };

export const isImage = (mime: string) => mime.startsWith("image/");

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Files chosen for the next turn (#125). Each is uploaded as soon as it is added (so the daemon's answer — a limit,
 * a bad mime — shows before 送信), removed with DELETE if taken off again, and sent as ids with the turn.
 * `busy` is true while any upload is in flight: the turn must not go out before the ids exist. `clear()` after a
 * successful turn also disowns uploads still in flight (they are deleted when they land, not shown as new chips).
 */
export function useAttachments(onError: (msg: string) => void) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [inFlight, setInFlight] = useState(0);
  const committed = useRef(0);
  committed.current = items.length;
  const pending = useRef(0); // files uploading right now, for the per-turn limit across overlapping adds
  const generation = useRef(0); // bumped by clear(): an upload started before it belongs to a turn already sent
  const add = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      const big = list.find((f) => f.size > MAX_ATTACHMENT_BYTES);
      if (big) {
        onError(`${big.name} は ${formatBytes(big.size)} あります。添付は 1 件 ${formatBytes(MAX_ATTACHMENT_BYTES)} までです`);
        return;
      }
      const have = committed.current + pending.current;
      if (have + list.length > MAX_ATTACHMENTS) {
        onError(`添付は 1 回 ${MAX_ATTACHMENTS} 件までです（いま ${have} 件）`);
        return;
      }
      const gen = generation.current;
      pending.current += list.length;
      setInFlight((n) => n + 1);
      try {
        const saved = await api.uploadAttachments(list);
        if (gen !== generation.current) {
          for (const a of saved) void api.deleteAttachment(a.id).catch(() => {});
          return;
        }
        setItems((prev) => [...prev, ...saved]);
      } catch (e) {
        onError(String((e as Error).message ?? e));
      } finally {
        pending.current -= list.length;
        setInFlight((n) => n - 1);
      }
    },
    [onError],
  );
  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((a) => a.id !== id));
    void api.deleteAttachment(id).catch(() => {}); // an upload nobody sends is swept by the daemon anyway
  }, []);
  const clear = useCallback(() => {
    generation.current++;
    setItems([]);
  }, []);
  /** Chips whose ids the daemon says were already sent (a retry after a half-failed turn) are dropped. */
  const dropSent = useCallback((ids: string[]) => setItems((prev) => prev.filter((a) => !ids.includes(a.id))), []);
  return { items, ids: items.map((a) => a.id), add, remove, clear, dropSent, busy: inFlight > 0 };
}

const hasFiles = (e: DragEvent | globalThis.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/** Split a drop into files and skipped folders (Chrome hands a folder over as an empty File). */
function droppedFiles(dt: DataTransfer): { files: File[]; folders: number } {
  const items = Array.from(dt.items ?? []);
  if (!items.length || typeof items[0]!.webkitGetAsEntry !== "function") return { files: Array.from(dt.files), folders: 0 };
  const files: File[] = [];
  let folders = 0;
  for (const it of items) {
    if (it.kind !== "file") continue;
    const entry = it.webkitGetAsEntry();
    if (entry?.isDirectory) {
      folders++;
      continue;
    }
    const f = it.getAsFile();
    if (f) files.push(f);
  }
  return { files, folders };
}

/**
 * Drag & drop onto a container and paste into its textarea. `dropping` highlights the target while a file hovers.
 * A paste that carries text (a spreadsheet range, a document selection with an image) pastes as text; only a
 * files-only clipboard (a screenshot, a copied image) becomes an attachment.
 */
export function useDropZone(add: (files: File[]) => void, onError: (msg: string) => void) {
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0); // enter/leave fire for every child; count them so the highlight does not flicker
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDropping(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDropping(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDropping(false);
      const { files, folders } = droppedFiles(e.dataTransfer);
      if (folders) onError("フォルダは添付できません。中のファイルを選んでください");
      if (files.length) add(files);
    },
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length || e.clipboardData.getData("text/plain")) return; // text (or a mixed paste) pastes as text
    e.preventDefault();
    add(files);
  };
  return { dropping, handlers, onPaste };
}

/**
 * Mounted once (App): a file dropped anywhere outside a dropzone must not navigate the tab to the file (the browser
 * default), which would lose the composer and orphan uploaded chips. Inside a dropzone the zone's own handler runs
 * first; here we only cancel the default.
 */
export function usePageDropGuard() {
  useEffect(() => {
    const over = (e: globalThis.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!(e.target instanceof Element && e.target.closest(".dropzone")) && e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    const drop = (e: globalThis.DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
}

/** The 添付 button: a hidden file input. */
export function AttachButton(props: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          props.onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <button type="button" disabled={props.disabled} onClick={() => ref.current?.click()} title={`ファイルを添付（ドロップや貼り付けでも）。1 件 ${formatBytes(MAX_ATTACHMENT_BYTES)}、${MAX_ATTACHMENTS} 件まで`}>
        添付
      </button>
    </>
  );
}

/** Chips for the files waiting to go with the next turn. */
export function AttachmentBar(props: { items: Attachment[]; onRemove: (id: string) => void; busy?: boolean }) {
  if (!props.items.length && !props.busy) return null;
  return (
    <div className="attach-bar" aria-label="添付">
      {props.items.map((a) => (
        <span key={a.id} className="attach-chip" title={`${a.name} · ${a.mime} · ${formatBytes(a.size)}`}>
          {isImage(a.mime) ? <AttachmentImage a={a} className="thumb" /> : <span className="ico">📄</span>}
          <span className="n">{a.name}</span>
          <span className="m">{formatBytes(a.size)}</span>
          <button type="button" className="x" aria-label={`${a.name} を外す`} onClick={() => props.onRemove(a.id)}>
            ×
          </button>
        </span>
      ))}
      {props.busy && <span className="hint">アップロード中…</span>}
    </div>
  );
}

/** The bytes as an object URL, fetched with the API token (an <img src> could not carry it off-loopback, #31); revoked on unmount. */
function useAttachmentUrl(id: string): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setFailed(false);
    api
      .attachmentBlob(id)
      .then((b) => {
        if (cancelled) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return { src, failed };
}

/** An attachment as an <img> (an image element never runs a script, whatever the file is). */
export function AttachmentImage(props: { a: AttachmentRef; className?: string; onClick?: () => void }) {
  const { src, failed } = useAttachmentUrl(props.a.id);
  if (failed) return <span className={`${props.className ?? ""} ph gone`} title={`${props.a.name}: 取得できません（ファイルが無い、または権限）`} />;
  if (!src) return <span className={`${props.className ?? ""} ph`} title={props.a.name} />;
  return <img className={props.className} src={src} alt={props.a.name} title={props.a.name} onClick={props.onClick} />;
}

/** A non-image attachment: a download through fetch (so the token goes along); the plain href still works on loopback. */
function AttachmentLink(props: { a: AttachmentRef }) {
  const [failed, setFailed] = useState(false);
  return (
    <a
      href={api.attachmentUrl(props.a.id)}
      className={failed ? "gone" : ""}
      title={failed ? "取得できません（ファイルが無い、または権限）" : `${props.a.mime} · ${formatBytes(props.a.size)}`}
      onClick={(e) => {
        e.preventDefault();
        api
          .attachmentBlob(props.a.id)
          .then((b) => {
            const u = URL.createObjectURL(b);
            const el = document.createElement("a");
            el.href = u;
            el.download = props.a.name;
            el.click();
            setTimeout(() => URL.revokeObjectURL(u), 10_000);
          })
          .catch(() => setFailed(true));
      }}
    >
      📄 {props.a.name} <span className="m">{formatBytes(props.a.size)}</span>
      {failed && <span className="m"> — 取得できません</span>}
    </a>
  );
}

/**
 * Attachments inside a transcript row: images inline, everything else a download link. A click on an image opens
 * it full size in an in-app overlay (never a new document: an SVG opened as a page would run its scripts here).
 */
export function AttachmentGallery(props: { items: AttachmentRef[] }) {
  const [open, setOpen] = useState<AttachmentRef | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!props.items.length) return null;
  return (
    <div className="attach-gallery">
      {props.items.map((a) => (isImage(a.mime) ? <AttachmentImage key={a.id} a={a} onClick={() => setOpen(a)} /> : <AttachmentLink key={a.id} a={a} />))}
      {open && (
        <div className="lightbox" role="dialog" aria-label={open.name} onClick={() => setOpen(null)}>
          <AttachmentImage a={open} className="full" />
          <div className="hint">{open.name} · クリックか Esc で閉じる</div>
        </div>
      )}
    </div>
  );
}
