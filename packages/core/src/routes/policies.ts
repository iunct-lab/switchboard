import { PolicyPatch, type AnswerPolicy, type PolicyList } from "@switchboard/protocol";
import { checkPolicy, readPolicies, writePolicies } from "../policies.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/policies. */
export function policiesRoutes(sc: Pick<ServerContext, "json" | "db" | "humanCheck" | "bad" | "approval" | "logOp">): Routes {
  return {
    /** The saved answer policies, newest change first. */
    "/api/policies": {
      GET: () => sc.json({ policies: readPolicies(sc.db).sort((a, b) => b.updatedAt - a.updatedAt) } satisfies PolicyList),
    },
    /** Edits a policy's target / conditions / expiry with the same checks as saving, or revokes / restores it. */
    "/api/policies/:id": {
      PATCH: async (req, srv) => {
        const refusal = await sc.humanCheck(req, srv);
        if (refusal) return refusal;
        const parsed = PolicyPatch.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const list = readPolicies(sc.db);
        const p = list.find((x) => x.id === String(req.params.id));
        if (!p) return sc.bad("not found", 404);
        const patch = parsed.data;
        const edits = patch.target !== undefined || patch.when !== undefined || patch.expiresAt !== undefined;
        if (p.scope === "once" && edits) return sc.bad("今回のみの方針は編集できません。無効にするだけです", 409);
        const now = Date.now();
        let next: AnswerPolicy = { ...p };
        if (edits) {
          const confirmHit = sc.approval.confirmOf(p.workspaceId, p.kind, p.op, patch.target ?? p.target);
          const checked = checkPolicy({ scope: p.scope, target: patch.target ?? p.target, when: patch.when ?? p.when, expiresAt: patch.expiresAt === undefined ? p.expiresAt : patch.expiresAt }, { subject: p.from, workspaceId: p.workspaceId, pbi: p.pbi, askId: p.askId ?? "", answer: p.answer, confirmHit, runnerRefusal: false, now });
          if (!checked.ok) return sc.bad(checked.error);
          next = { ...next, target: checked.policy.target, when: checked.policy.when, expiresAt: checked.policy.expiresAt };
        }
        if (patch.revoked !== undefined) next = { ...next, revokedAt: patch.revoked ? (p.revokedAt ?? now) : null };
        next = { ...next, updatedAt: now };
        writePolicies(sc.db, list.map((x) => (x.id === p.id ? next : x)));
        sc.logOp(req, srv, "policy.edit", { detail: { id: p.id, scope: p.scope, target: next.target, revoked: next.revokedAt !== null } });
        return sc.json(next);
      },
    },
  };
}
