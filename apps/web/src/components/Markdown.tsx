import { createElement, Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, safeHref, type MdBlock, type MdInline } from "../markdown.ts";
import { useMdView } from "../mdView.ts";
import { t } from "../i18n.ts";
import { common as m } from "../i18n/common.ts";

// Renders Markdown as React elements (never as an HTML string): text goes in as text, so raw HTML in a runner's reply stays
// visible characters. Links open in a new tab; a link whose URL is not http(s) or mailto is shown as plain text.

function inline(nodes: MdInline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text": return <Fragment key={i}>{n.text}</Fragment>;
      case "code": return <code key={i}>{n.text}</code>;
      case "strong": return <strong key={i}>{inline(n.children)}</strong>;
      case "em": return <em key={i}>{inline(n.children)}</em>;
      case "br": return <br key={i} />;
      case "link": {
        const href = safeHref(n.url);
        return href === null
          ? <span key={i}>{inline(n.children)}</span>
          : <a key={i} href={href} target="_blank" rel="noopener noreferrer">{inline(n.children)}</a>;
      }
    }
  });
}

/** An item's only paragraph renders without `<p>` so a plain list stays compact. */
function item(blocks: MdBlock[]): ReactNode[] {
  const tight = blocks.filter((b) => b.t === "paragraph").length === 1;
  return blocks.map((b, i) => (tight && b.t === "paragraph" ? <Fragment key={i}>{inline(b.inline)}</Fragment> : block(b, i)));
}

function block(b: MdBlock, key: number): ReactNode {
  switch (b.t) {
    case "heading": return createElement(`h${b.level}`, { key }, inline(b.inline));
    case "paragraph": return <p key={key}>{inline(b.inline)}</p>;
    case "hr": return <hr key={key} />;
    case "code": return <pre key={key}><code className={b.lang ? `language-${b.lang}` : undefined}>{b.text}</code></pre>;
    case "quote": return <blockquote key={key}>{b.blocks.map(block)}</blockquote>;
    case "list": {
      const items = b.items.map((it, i) => <li key={i}>{item(it)}</li>);
      return b.ordered ? <ol key={key} start={b.start === 1 ? undefined : b.start}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "table": {
      const align = (i: number) => (b.align[i] ? { textAlign: b.align[i]! } : undefined);
      return (
        <table key={key}>
          <thead><tr>{b.head.map((c, i) => <th key={i} style={align(i)}>{inline(c)}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, i) => <td key={i} style={align(i)}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>
      );
    }
  }
}

export function Markdown(props: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(props.text), [props.text]);
  return <div className="md">{blocks.map(block)}</div>;
}

/** 「プレビュー / テキスト」: one value for the whole page (the 会話 tab's replies and .md artifacts), kept in this browser. */
export function MdViewToggle() {
  const [view, setView] = useMdView();
  return (
    <span className="md-view" role="group" aria-label={t(m.mdViewLabel)}>
      <button className={view === "preview" ? "ghost on" : "ghost"} aria-pressed={view === "preview"} onClick={() => setView("preview")}>
        {t(m.mdPreview)}
      </button>
      <button className={view === "text" ? "ghost on" : "ghost"} aria-pressed={view === "text"} onClick={() => setView("text")}>
        {t(m.mdText)}
      </button>
    </span>
  );
}
