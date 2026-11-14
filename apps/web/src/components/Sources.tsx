import { useEffect, useState } from "react";
import type { SourceView } from "@switchboard/protocol";
import { api } from "../api.ts";
import { sourceHeaders, sourceTableRows } from "../sources.ts";
import { t } from "../i18n.ts";
import { insights as m } from "../i18n/insights.ts";

/** 出どころごとの成績: what each source's requests came to in the daemon's default period. Read once each time Insights opens; no sorting, filtering or period. */
export function Sources() {
  const [view, setView] = useState<SourceView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .sources()
      .then((v) => live && setView(v))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="card" data-sources>
      <h5>{view ? t(m.sourcesHeading, { n: view.days }) : t(m.sourcesTitle)}</h5>
      {failed ? <div className="muted">{t(m.loadFailedShort)}</div> : !view && <div className="muted">{t(m.loading)}</div>}
      {view && (
        <>
          <div className="table-scroll">
            <table className="pricing">
              <thead>
                <tr>
                  {sourceHeaders(view).map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sourceTableRows(view).map((r, i) => (
                  <tr key={i}>
                    <td style={r.child ? { paddingLeft: "1.5em" } : undefined}>{r.label}</td>
                    {r.cells.map((c, j) => (
                      <td key={j}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.unread.length > 0 && <div className="muted" data-sources-unread>{t(m.sourcesUnread, { list: view.unread.join(", ") })}</div>}
        </>
      )}
    </section>
  );
}
