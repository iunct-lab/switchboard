import type { AnswerPolicy, AskAnswer, AskAnswerResult, AskBatch, AskBatchResult, AskList, PendingApproval, PolicyInput, PolicyList, PolicyPatch } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const asksApi = {
  /** Unanswered permission asks across tasks, newest first. */
  approvals: () => req<PendingApproval[]>("/api/approvals"),
  /** Every question waiting on the user, and those answered / resolved within the day. */
  asks: () => req<AskList>("/api/asks"),
  /** answers one question by its id; a 409 carries `body` (AskChanged: what changed, the question now). */
  /** one press for a batch — sso logs in once, deploy approves the chosen Tasks. */
  /** `askIds` (deploy): the chosen Tasks' questions as the card showed them (`AskBatch.asks[].askId`); a 409 = one of them changed, nothing sent. */
  answerBatch: (id: AskBatch["id"], taskIds?: string[], askIds?: string[]) => req<AskBatchResult>("/api/asks/answer", { method: "POST", body: JSON.stringify({ id, answer: { kind: "allow" }, ...(taskIds ? { taskIds } : {}), ...(askIds ? { askIds } : {}) }) }),
  /** 「全部推奨のままで確定」: every open question of the Workspace that went on by its recommendation gets its confirmation. */
  /** `askIds`: the questions the screen shows under the button — only these are confirmed. */
  confirmProceeding: (workspaceId: string, askIds: string[]) => req<{ confirmed: string[] }>("/api/asks/answer", { method: "POST", body: JSON.stringify({ id: `proceed-all:${workspaceId}`, answer: { kind: "confirm", ok: true }, askIds }) }),
  answerAsk: (id: string, answer: AskAnswer, policy?: PolicyInput) => req<AskAnswerResult>("/api/asks/answer", { method: "POST", body: JSON.stringify({ id, answer, ...(policy ? { policy } : {}) }) }),
  /** the saved answer policies, and one edited / revoked. */
  listPolicies: () => req<PolicyList>("/api/policies"),
  patchPolicy: (id: string, patch: PolicyPatch) => req<AnswerPolicy>(`/api/policies/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
};
