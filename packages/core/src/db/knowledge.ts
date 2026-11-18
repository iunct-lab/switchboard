/** The knowledge index. */

import type { KnowledgeDoc, KnowledgeSearchHit } from "@switchboard/protocol";
import { safeJson } from "./util.ts";
import { LedgerQueries } from "./ledger.ts";

/** The knowledge index. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class KnowledgeQueries extends LedgerQueries {
  /* ---------- knowledge index (derived from the Markdown folder; rebuildable) ---------- */

  knowledgeUpsert(doc: KnowledgeDoc, body: string) {
    this.sqlite.transaction(() => {
      this.sqlite
        .query(
          `INSERT INTO knowledge_docs (path, title, kind, frontmatter, mtime, size) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET title = excluded.title, kind = excluded.kind, frontmatter = excluded.frontmatter, mtime = excluded.mtime, size = excluded.size`,
        )
        .run(doc.path, doc.title, doc.kind, JSON.stringify(doc.frontmatter), doc.mtime, doc.size);
      this.sqlite.query("DELETE FROM knowledge_fts WHERE path = ?").run(doc.path);
      this.sqlite.query("INSERT INTO knowledge_fts (path, title, body) VALUES (?, ?, ?)").run(doc.path, doc.title, body);
    })();
  }

  knowledgeDelete(path: string) {
    this.sqlite.transaction(() => {
      this.sqlite.query("DELETE FROM knowledge_docs WHERE path = ?").run(path);
      this.sqlite.query("DELETE FROM knowledge_fts WHERE path = ?").run(path);
    })();
  }

  knowledgeGet(path: string): KnowledgeDoc | null {
    const r = this.sqlite.query("SELECT * FROM knowledge_docs WHERE path = ?").get(path);
    return r ? rowToKnowledge(r) : null;
  }

  knowledgeList(): KnowledgeDoc[] {
    return this.sqlite.query("SELECT * FROM knowledge_docs ORDER BY kind, path").all().map(rowToKnowledge);
  }

  /**
   * Trigram MATCH for terms ≥ 3 chars plus LIKE filters for shorter ones (the trigram tokenizer accelerates LIKE too).
   * With no MATCH term the query is LIKE-only and ranked by title.
   */
  knowledgeSearch(ftsQuery: string, like: string[], limit: number): KnowledgeSearchHit[] {
    const likeSql = like.map(() => " AND (f.body LIKE ? OR f.title LIKE ?)").join("");
    const likeArgs = like.flatMap((w) => [`%${w.replace(/[%_\\]/g, "\\$&")}%`, `%${w.replace(/[%_\\]/g, "\\$&")}%`]);
    if (ftsQuery) {
      return this.sqlite
        .query(
          `SELECT f.path AS path, d.title AS title, d.kind AS kind, snippet(knowledge_fts, 2, '[', ']', '…', 12) AS snippet, bm25(knowledge_fts) AS rank
           FROM knowledge_fts f JOIN knowledge_docs d ON d.path = f.path WHERE knowledge_fts MATCH ?${likeSql} ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, ...likeArgs, limit) as KnowledgeSearchHit[];
    }
    const rows = this.sqlite
      .query(`SELECT f.path AS path, d.title AS title, d.kind AS kind, substr(f.body, 1, 160) AS snippet, 0 AS rank FROM knowledge_fts f JOIN knowledge_docs d ON d.path = f.path WHERE 1=1${likeSql} ORDER BY d.title LIMIT ?`)
      .all(...likeArgs, limit) as KnowledgeSearchHit[];
    return rows.map((r) => ({ ...r, snippet: r.snippet.replace(/\s+/g, " ").trim() }));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToKnowledge(r: any): KnowledgeDoc {
  return { path: r.path, title: r.title, kind: r.kind, frontmatter: safeJson(r.frontmatter, {}), mtime: r.mtime, size: r.size };
}
