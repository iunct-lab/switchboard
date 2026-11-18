import { AttachmentError, extValue, formatBytes, isActiveContent, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_REQUEST } from "../attachments.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/attachments. */
export function attachmentsRoutes(sc: Pick<ServerContext, "bad" | "attachments" | "json">): Routes {
  return {
    // Attachments. Upload first (multipart, one or more `file` fields), then send the ids with a turn.
    "/api/attachments": {
      POST: async (req) => {
        // The whole body is buffered by formData(); an upload that cannot fit is refused from its length first.
        const declared = Number(req.headers.get("content-length") ?? 0);
        if (declared > MAX_ATTACHMENTS_PER_REQUEST * MAX_ATTACHMENT_BYTES) return sc.bad(`upload is ${formatBytes(declared)}; max ${formatBytes(MAX_ATTACHMENT_BYTES)} per file, ${MAX_ATTACHMENTS_PER_REQUEST} files`, 413);
        const form = await req.formData().catch(() => null);
        if (!form) return sc.bad("multipart/form-data with one or more `file` fields required");
        // Bun's FormData and the DOM lib disagree on the entry type; a non-string entry is a File either way.
        const files = form.getAll("file").filter((f) => typeof f !== "string") as unknown as File[];
        if (!files.length) return sc.bad("no `file` field");
        if (files.length > MAX_ATTACHMENTS_PER_REQUEST) return sc.bad(`too many files (${files.length}; max ${MAX_ATTACHMENTS_PER_REQUEST} per upload)`, 413);
        const big = files.find((f) => f.size > MAX_ATTACHMENT_BYTES);
        if (big) return sc.bad(`${big.name} is ${formatBytes(big.size)}; max ${formatBytes(MAX_ATTACHMENT_BYTES)} per file`, 413);
        const saved = [];
        for (const f of files) saved.push(sc.attachments.save({ name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }));
        return sc.json(saved, 201);
      },
    },
    "/api/attachments/:id": {
      GET: async (req) => {
        const a = sc.attachments.get(String(req.params.id));
        if (!a) return sc.bad("not found", 404);
        const file = Bun.file(a.path);
        if (!(await file.exists())) return sc.bad(`the file is gone (${a.path})`, 410);
        // Served on the UI's own origin: no document may run here. `sandbox` strips scripts and same-origin from
        // whatever is opened directly (an <img> is unaffected); HTML / SVG / XML additionally download instead of opening.
        return new Response(file, {
          headers: {
            "content-type": a.mime,
            "content-disposition": `${isActiveContent(a.mime) ? "attachment" : "inline"}; filename*=UTF-8''${extValue(a.name)}`,
            "content-security-policy": "sandbox",
            "cache-control": "private, max-age=3600",
            "x-content-type-options": "nosniff",
          },
        });
      },
      DELETE: (req) => {
        try {
          sc.attachments.remove(String(req.params.id));
          return sc.json({ ok: true });
        } catch (e) {
          return e instanceof AttachmentError ? sc.bad(e.message, e.status) : sc.bad(String((e as Error).message ?? e), 500);
        }
      },
    },
  };
}
