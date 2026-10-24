/**
 * Copy text for the copy buttons (#695). `navigator.clipboard` exists only on HTTPS and localhost; opened over plain
 * HTTP (a phone on the LAN, docs/design/mobile-approval.md) the old `execCommand("copy")` still works. When neither
 * does, the caller gets an error to show instead of a button that silently does nothing.
 */
export type CopyEnv = { clipboard?: { writeText(t: string): Promise<void> }; execCopy: (t: string) => boolean };

export async function copyText(text: string, env: CopyEnv = browserEnv()): Promise<void> {
  if (env.clipboard) {
    try {
      await env.clipboard.writeText(text);
      return;
    } catch {
      // denied or not focused: try the old way below
    }
  }
  let copied = false;
  try {
    copied = env.execCopy(text);
  } catch {
    copied = false;
  }
  if (!copied) throw new Error("クリップボードにコピーできませんでした");
}

function browserEnv(): CopyEnv {
  return { clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined, execCopy };
}

function execCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } finally {
    area.remove();
    restore?.focus();
  }
}
