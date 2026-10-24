import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Task, Workspace } from "@switchboard/protocol";
import { api, type FeedbackSource } from "../api.ts";
import { feedbackTargets, type FeedbackTarget } from "../feedbackTarget.ts";
import { AttachButton, AttachmentBar, useAttachments, useDropZone } from "./Attachments.tsx";

async function captureTab(): Promise<File> {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen capture unavailable");
  const options: DisplayMediaStreamOptions & { preferCurrentTab: boolean } = { video: { displaySurface: "browser" }, preferCurrentTab: true, audio: false };
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const video = document.createElement("video");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    video.srcObject = stream;
    video.muted = true;
    // Wait for a decoded frame, not just metadata (which can still produce a blank canvas).
    const frame = new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve()));
    await Promise.race([
      (async () => { await video.play(); await frame; })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Screen capture timed out")), 10_000); }),
    ]);
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) throw new Error("No video frame");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("PNG encoding failed")), "image/png"));
    return new File([blob], `screenshot-${new Date().toISOString().replace(/:/g, "-")}.png`, { type: "image/png" });
  } finally {
    clearTimeout(timeout);
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
}

/** 改善要望にする (#1221): the text the dialog opens with and the task it was drafted from. */
export interface FeedbackPrefill {
  text: string;
  source: FeedbackSource;
}

/**
 * `workspaces` / `workspace`: where 要望として登録 files the request (that workspace's repository and Project); the
 * dialog opens on `workspace` (the backlog's narrowed workspace), else the meta workspace. すぐ直す always fixes Switchboard.
 */
export function FeedbackDialog({ open, screen, workspaces, workspace, prefill, onClose, onSent, onError }: { open: boolean; screen: string; workspaces: Workspace[]; workspace?: FeedbackTarget; prefill?: FeedbackPrefill; onClose: () => void; onSent: (task: Task) => void; onError: (message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // The prop now, not when capture() began: whatever closes the dialog meanwhile must win over the reopen.
  const isOpen = useRef(open);
  isOpen.current = open;
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [capturing, setCapturing] = useState(false);
  // Not remembered: every dialog starts on 要望として登録 (#263).
  const [mode, setMode] = useState<"request" | "fix">("request");
  const [target, setTarget] = useState("");
  // opened before the list was read: the meta workspace, where the daemon files a request that names none
  const targets = feedbackTargets(workspaces, workspace);
  const shown = target || targets.initial;
  const submitting = useRef(false);
  // whether the text came from a prefill (#1221), so a close without sending clears it
  const prefilled = useRef(false);
  const attach = useAttachments(setMessage);
  const drop = useDropZone(attach.add, setMessage);
  const locked = sending || capturing;
  useEffect(() => {
    if (open) {
      setMode("request"); // every opening starts on 要望として登録, also after closing without sending
      setTarget(targets.initial);
      // a draft from a task's evaluations (#1221) goes in once, when the dialog opens, over whatever was kept from a closed dialog; the
      // person edits it from there, and closing unsent drops it (the next plain open must not send it without its 出典)
      if (prefill) {
        setText(prefill.text);
        prefilled.current = true;
      }
      dialog.current?.showModal();
    } else {
      if (prefilled.current) {
        setText("");
        prefilled.current = false;
      }
      dialog.current?.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  async function capture() {
    setCapturing(true);
    setMessage(null);
    // Out of the way while the tab is captured, or the dialog and its backdrop are what the picture shows (#262).
    // close() fires no `cancel`, so App's feedbackOpen stays true and the text and attachments are kept.
    dialog.current?.close();
    try {
      for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
      await attach.add([await captureTab()]);
    }
    catch { setMessage("画面を撮れませんでした。貼り付けかドロップで添付してください"); }
    finally {
      if (isOpen.current && !dialog.current?.open) dialog.current?.showModal();
      setCapturing(false);
      // the fieldset is still disabled until that state renders: focus the text once it has
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || attach.busy || locked || submitting.current) return;
    submitting.current = true;
    setSending(true);
    setMessage(null);
    try {
      const task = await api.feedback(text, attach.ids, screen, mode, mode === "request" && shown ? shown : undefined, mode === "request" ? prefill?.source : undefined);
      attach.clear();
      setText("");
      prefilled.current = false;
      setMode("request");
      onClose();
      onSent(task);
    } catch (e) {
      const error = String((e as Error).message ?? e);
      setMessage(error);
      onError(error);
    } finally { submitting.current = false; setSending(false); }
  }
  return (
    <dialog ref={dialog} className="feedback-dialog" aria-labelledby="feedback-title" onCancel={(e) => { e.preventDefault(); if (!locked) onClose(); }}>
      <form onSubmit={submit}>
        <h2 id="feedback-title">フィードバック</h2>
        <fieldset disabled={locked} className="row feedback-mode">
          <legend className="hint">送り方</legend>
          <label><input type="radio" name="feedback-mode" value="request" checked={mode === "request"} onChange={() => setMode("request")} /> 要望として登録</label>
          <label><input type="radio" name="feedback-mode" value="fix" checked={mode === "fix"} onChange={() => setMode("fix")} /> すぐ直す</label>
        </fieldset>
        {mode === "request" && targets.list.length > 1 && (
          <fieldset disabled={locked} className="row feedback-target">
            <label htmlFor="feedback-workspace">登録先</label>
            <select id="feedback-workspace" value={shown} onChange={(e) => setTarget(e.target.value)}>
              {targets.list.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </fieldset>
        )}
        <p className="hint">{mode === "fix" ? "Switchboard を直す Task をすぐ始めます（要望 Issue は作りません）。" : `要望や不具合を送ると、${targets.list.find((w) => w.id === shown)?.name ?? "登録先"} のリポジトリに要望 Issue と PBI・Task が作られます。`}</p>
        <p className="hint feedback-screen">送信元: {screen}</p>
        <fieldset disabled={locked} className={`dropzone ${drop.dropping ? "dropping" : ""}`} {...(!locked ? drop.handlers : {})}>
          <label htmlFor="feedback-text">本文（必須）</label>
          <textarea ref={textarea} id="feedback-text" rows={7} required maxLength={20_000} value={text} onChange={(e) => setText(e.target.value)} onPaste={drop.onPaste} placeholder="気づいたこと、できるようにしたいこと" />
          <div className="row">
            <button type="button" onClick={capture}>画面を撮る</button>
            <AttachButton onFiles={attach.add} />
            <span className="hint">画像は貼り付け・ドロップもできます</span>
          </div>
          <AttachmentBar items={attach.items} onRemove={attach.remove} busy={attach.busy} />
        </fieldset>
        {capturing && <p role="status">画面を撮っています…</p>}
        {message && <p className="error" role="alert">{message}</p>}
        <div className="feedback-actions">
          <button type="button" className="ghost" disabled={locked} onClick={onClose}>閉じる</button>
          <button type="submit" className="pri" disabled={!text.trim() || attach.busy || locked}>{sending ? "送信中…" : mode === "fix" ? "直す" : "登録"}</button>
        </div>
      </form>
    </dialog>
  );
}
