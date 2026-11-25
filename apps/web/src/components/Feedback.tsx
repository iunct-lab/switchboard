import { useEffect, useRef, useState } from "react";
import type { CreateTaskInput, RunnerId, Task, Workspace } from "@switchboard/protocol";
import { type Health } from "../api/daemon.ts";
import { type FeedbackSource, type FeedbackUpstream } from "../api/feedback.ts";
import { type FeedbackTarget } from "../feedbackTarget.ts";
import { useAttachments } from "./Attachments.tsx";
import { Compose } from "./Compose.tsx";
import { copyText } from "../clipboard.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";
import { task as taskMsgs } from "../i18n/task.ts";
import { feedbackScreens, panels as m } from "../i18n/panels.ts";

/**
 * The screen's name as the dialog shows it: the name sent (`screenLabel`, which goes into the Task's prompt as it is) read in
 * the screen's language. A tab's name is shown as sent; a Task's line (`Task「title」(id)`) keeps its title and id, with the
 * language's quotes.
 */
export function shownScreen(screen: string): string {
  const task = /^Task「(.*)」\((.+)\)$/s.exec(screen);
  if (task) return t(m.sentFromTask, { title: task[1]!, id: task[2]! });
  return Object.hasOwn(feedbackScreens, screen) ? t(feedbackScreens[screen as keyof typeof feedbackScreens]) : screen;
}

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

/**
 * 改善要望にする: the text the dialog opens with and the task it was drafted from. `artifact`: 要望にする on a
 * throwaway app — its title and its Task (the title when the screen around the artifact knows it), shown in 送信元.
 */
export interface FeedbackPrefill {
  text: string;
  source: FeedbackSource;
  artifact?: { title: string; taskId: string; taskTitle?: string };
}

/** 送信元 of 要望にする: the artifact's title, and its Task unless the screen already names that Task (the Task screen). */
export function sentFromArtifact(screen: string, a: NonNullable<FeedbackPrefill["artifact"]>): string {
  return screen.endsWith(`(${a.taskId})`) ? t(m.sentFromArtifact, { screen: shownScreen(screen), title: a.title }) : t(m.sentFromTaskArtifact, { screen: shownScreen(screen), task: a.taskTitle ?? a.taskId, title: a.title });
}

/**
 * 要望にする on a throwaway app: the artifact sits several components below App (Task screen, Insights,
 * 判断待ち), so it asks App to open the dialog with this event instead of a callback through each of them.
 */
export const OPEN_FEEDBACK_EVENT = "switchboard:open-feedback";
export function requestFeedback(prefill: FeedbackPrefill): void {
  dispatchEvent(new CustomEvent<FeedbackPrefill>(OPEN_FEEDBACK_EVENT, { detail: prefill }));
}

/**
 * The instruction form in a dialog, for every screen but Home (Home draws `Compose` itself). Drawn only while open: a closed
 * dialog would leave a second `.compose` on the page. What the dialog keeps for itself is what a close must not lose: the
 * text (a draft that came with a source is dropped on a close without sending, so the next plain opening cannot send it
 * under that source) and the attachments. `workspace` is where the form starts (the Backlog's narrowed repository).
 */
export function FeedbackDialog({ open, screen, health, workspaces, runnerOk, workspace, prefill, onCreate, onOpenSettings, onClose, onSent, onError }: { open: boolean; screen: string; health: Health | null; workspaces: Workspace[]; runnerOk: Set<RunnerId>; workspace?: FeedbackTarget; prefill?: FeedbackPrefill; onCreate: (input: CreateTaskInput) => Promise<void>; onOpenSettings: () => void; onClose: () => void; onSent: (task: Task) => void; onError: (message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  // The prop now, not when capture() began: whatever closes the dialog meanwhile must win over the reopen.
  const isOpen = useRef(open);
  isOpen.current = open;
  const [text, setText] = useState("");
  const attach = useAttachments(onError);
  // a send or a capture under way: Esc does not close the dialog meanwhile
  const locked = useRef(false);
  // whether the text came from a prefill, so a close without sending clears it
  const prefilled = useRef(false);
  useEffect(() => {
    if (open) {
      // a draft from a task's evaluations goes in once, when the dialog opens, over whatever was kept from a closed dialog; the
      // person edits it from there, and closing unsent drops it
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
  // Out of the way while the tab is captured, or the dialog and its backdrop are what the picture shows.
  // close() fires no `cancel`, so App's feedbackOpen stays true and the text and attachments are kept.
  async function capture(): Promise<File> {
    dialog.current?.close();
    try {
      for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
      return await captureTab();
    } finally {
      if (isOpen.current && !dialog.current?.open) dialog.current?.showModal();
    }
  }
  return (
    <dialog ref={dialog} className="feedback-dialog" aria-label={t(home.newTaskHeading)} onCancel={(e) => { e.preventDefault(); if (!locked.current) onClose(); }}>
      {open && (
        <Compose
          health={health}
          workspaces={workspaces}
          runnerOk={runnerOk}
          onCreate={onCreate}
          onError={onError}
          onOpenSettings={onOpenSettings}
          screen={screen}
          onSent={(task) => { prefilled.current = false; onClose(); onSent(task); }}
          initialWorkspace={workspace}
          prefill={prefill}
          draft={{ text, onText: setText }}
          attach={attach}
          capture={capture}
          onCancel={onClose}
          onBusy={(busy) => { locked.current = busy; }}
          note={prefill?.artifact ? sentFromArtifact(screen, prefill.artifact) : t(m.sentFrom, { screen: shownScreen(screen) })}
        />
      )}
    </dialog>
  );
}

/** `owner/name` of a GitHub form link, so the link says whose form it opens. */
export function formRepo(url: string): string {
  return new URL(url).pathname.split("/").slice(1, 3).join("/");
}

/** Where a request for Switchboard itself goes when this instance does not develop it: the form link, else the text to copy. */
export function FeedbackUpstreamBox({ upstream, onCopyError }: { upstream: FeedbackUpstream["upstream"]; onCopyError: (message: string) => void }) {
  return (
    <div className="feedback-upstream" role="status">
      {upstream.url
        ? <a href={upstream.url} target="_blank" rel="noreferrer">{t(m.upstreamOpen, { repo: formRepo(upstream.url) })}</a>
        : <>
            <p className="hint">{t(m.upstreamCopyHint)}</p>
            <pre className="feedback-upstream-text">{upstream.text}</pre>
            <button type="button" onClick={() => void copyText(upstream.text).catch((e) => onCopyError(String((e as Error).message ?? e)))}>{t(taskMsgs.copy)}</button>
          </>}
    </div>
  );
}
