import { readFileSync } from "node:fs";
import { sectionName, type OpsConfig } from "./config.ts";
import { repoOf, type GhClient } from "./gh.ts";
import { hasSection, SPEAKER_MISSING, speakerOf } from "./lint.ts";
import { setField, UsageError } from "./set.ts";

/**
 * File a request Issue (`type:request`) from a body file and put it in the Project as Backlog. A body without the
 * request's required sections is refused before anything is created.
 */
export async function createRequest(gh: GhClient, cfg: OpsConfig, input: { title: string; bodyFile: string }, log: (s: string) => void = console.log): Promise<number> {
  let body: string;
  try {
    body = readFileSync(input.bodyFile, "utf8");
  } catch (e) {
    throw new UsageError(`本文のファイルを読めません: ${(e as Error).message}`);
  }
  const lacking = cfg.sections.request.filter((s) => !hasSection(body, sectionName(s))).map((s) => `## ${sectionName(s)}`);
  if (lacking.length) throw new UsageError(`要望の本文に ${lacking.join("、")} が無いので作りません`);
  if (hasSection(body, "出典") && !speakerOf(body)) throw new UsageError(`${SPEAKER_MISSING}ので作りません。利用者の文を引けなければ エージェント`);
  const repo = await repoOf(gh);
  const url = (await gh.run(["issue", "create", "-R", `${repo.owner}/${repo.name}`, "-t", input.title, "-l", "type:request", "-F", input.bodyFile])).trim();
  const m = /\/issues\/(\d+)$/.exec(url);
  if (!m) throw new Error(`作った Issue の番号が分かりません: ${url}`);
  const num = Number(m[1]);
  log(`>> 要望を作成: #${num} ${url}`);
  try {
    await setField(gh, cfg, num, "Status", "Backlog", log);
  } catch (e) {
    // The Issue exists now: running request again would file it twice
    throw new Error(`${(e as Error).message}\n要望 #${num} は作成済みです。request をやり直さず、set ${num} Status Backlog で続けてください`);
  }
  return num;
}
