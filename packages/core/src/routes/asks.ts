import { AskAnswerInput, type AskList } from "@switchboard/protocol";
import type { Routes, ServerContext } from "../server/context.ts";
import { answerConfigChange, configSourceOf, isConfigAsk } from "../server/workspace-config.ts";

/** The routes under /api/asks. */
export function asksRoutes(sc: Pick<ServerContext, "grantSource" | "currentAsks" | "json" | "bad" | "batchAnswers" | "confirmProceeding" | "humanCheck" | "screenLook" | "logOp" | "submitAnswer" | "db" | "cfg" | "broadcast" | "authorize" | "recentRefusal">): Routes {
  /**
   * `humanCheck` for an answer that is recorded as the person's own word: refused to a Task's token. Where the passkey
   * login is off this is a check of how the request looks, not a proof (server/guards.ts).
   */
  const person = async (req: Request, srv: Parameters<typeof sc.humanCheck>[1]): Promise<Response | null> => {
    const refusal = await sc.humanCheck(req, srv);
    return refusal?.status === 403 ? sc.json({ error: "この回答は利用者のものとして記録されるので、画面（ブラウザ）から答えます。Task のトークンからは答えられません", reason: "human" }, 403) : refusal;
  };
  return {
    /**
     * The questions waiting on the user across the Tasks and every workspace's backlog: the
     * open ones and those answered / resolved within the day, one per question. The backlog is the stored copy, as GET
     * /api/backlog reads it without refresh — no GitHub call.
     */
    "/api/asks": async () => {
      const { backlog: b, asks, batches } = await sc.currentAsks();
      return sc.json({ fetchedAt: b.fetchedAt, asks, errors: b.errors, batches } satisfies AskList);
    },
    /**
     * Answers one question and goes on: `{ id, answer }` as on screen. 200 = written (and the
     * work asked to go on), `ask` with its resume; `already` = it was answered before (a resend, or a second click while
     * the first was written) and nothing was written again. 409 = the question changed (AskChanged), nothing written.
     */
    "/api/asks/answer": {
      POST: async (req, srv) => {
        const parsed = AskAnswerInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const { id, answer, policy, taskIds, askIds } = parsed.data;
        // a batch is answered by pressing its one button: never a policy, never a text of the person's own
        if (id.startsWith("batch:")) {
          if (policy || answer.kind !== "allow") return sc.bad("まとまりへの回答は allow だけです（方針には保存できません）");
          const r = await sc.batchAnswers.answer(id, taskIds);
          return sc.json(r.body, r.status);
        }
        // a Workspace's questions the work went on from, confirmed at once: one button, never a policy
        if (id.startsWith("proceed-all:")) {
          if (policy || answer.kind !== "confirm" || !answer.ok) return sc.bad("まとめての確定は confirm（ok）だけです（方針には保存できません）");
          // what is confirmed is what the screen showed, by id: without the list nothing is (a question read anew here was not seen)
          if (!askIds?.length) return sc.bad("まとめての確定には、画面に出ていた問いの id（askIds）が要ります");
          // the confirmation is written on the Issues as the person's and counted as theirs: not a Task's to give
          const refusal = await person(req, srv);
          if (refusal) return refusal;
          return sc.json(await sc.confirmProceeding(id.slice("proceed-all:".length), askIds));
        }
        // a change of a workspace's settings (what the local CI runs, what the merge gate is): the person's to confirm, as a
        // policy is — refused to a Task's token; never a policy (server/workspace-config.ts says what that does not prove)
        if (isConfigAsk(id)) {
          if (policy || answer.kind !== "confirm") return sc.bad("設定の変更への回答は confirm だけです（方針には保存できません）");
          const refusal = await person(req, srv);
          if (refusal) return refusal;
          const by = await configSourceOf(sc, req, srv);
          sc.logOp(req, srv, "workspace.config.answer", { detail: { ask: id, ok: answer.ok, by } });
          const r = answerConfigChange(sc, id, answer.ok, answer.text, by);
          return sc.json(r.body, r.status);
        }
        // one such question alone (confirmed or overturned): the same — its `## 回答` is recorded as the person's
        if (id.startsWith("proceed:")) {
          const refusal = await person(req, srv);
          if (refusal) return refusal;
        }
        // a grant allows one operation once: never saved to be used again
        if (policy && answer.kind === "grant") return sc.bad("許可文は方針に保存できません");
        if (policy) {
          const refusal = await sc.humanCheck(req, srv);
          if (refusal) return refusal;
          sc.logOp(req, srv, "policy.save", { detail: { ask: id, scope: policy.scope, target: policy.target } });
        }
        // how the answer came in is kept with a merge grant read from it (merge-grants.ts): a call that does not look like
        // the screen's still answers the question, and its grant is recorded as a bare call's, which no check counts
        const r = await sc.submitAnswer(id, answer, policy, null, null, false, (await sc.grantSource(req, srv)).via);
        return sc.json(r.body, r.status);
      },
    },
  };
}
