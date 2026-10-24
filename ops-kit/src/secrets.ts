import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Values that let someone sign in or act as the user, found in a text before it is written to an Issue, a pull request
 * or a comment (#661). A hit names the kind and the line, never the value: the report itself goes to a terminal, a log
 * or an Issue.
 */
export interface SecretHit {
  kind: string;
  /** 1-based. */
  line: number;
}

/**
 * What a host's AWS config (`AWS_CONFIG_FILE`, else `~/.aws/config`) says about the accounts it signs in to: the profile
 * and SSO session names, and the account ids (`sso_account_id`, the ARNs). Read where the check runs, compared in memory,
 * never written out.
 */
export interface HostAws {
  names: readonly string[];
  accountIds: readonly string[];
}

/** No config: a place without one (Actions, a user's machine) checks the shapes alone. */
export const NO_HOST: HostAws = { names: [], accountIds: [] };

/** A placeholder written in place of a value (`XXXX-XXXX`, `xxxxxxxx`, `…`), which is how a text should show one. */
const placeholder = (s: string) => /^[Xx.…*<>_-]+$/.test(s);

/**
 * `find` reads one line; `before` is the label it stands under, else empty. A label is a short line that ends with a
 * colon or is a heading, Markdown marks aside ("**Device code:**", "## アカウント ID"), right above the line or with
 * only blank lines and a code fence between. An ordinary sentence above says nothing about the line below.
 */
const RULES: Array<{ kind: string; find: (line: string, before: string, host: HostAws) => boolean }> = [
  // The value is any printable ASCII up to a delimiter (%57…, /…, (…) included); a withheld value (<伏せた>, …) starts
  // with none, and the brackets around a placeholder do not make it a value
  // `${…}` is a template placeholder in code (a test that builds the URL), never a value
  { kind: "approval-url", find: (l) => [...l.matchAll(/[?&#]user_code=((?:(?![&#"'`<>])[!-~]){4,})/g)].some((m) => !m[1]!.startsWith("${") && !placeholder(m[1]!.replace(/[()[\]{}]/g, ""))) },
  {
    // A device code is two groups of four; alone that is also a ticket id or a version, so the line has to call it a
    // code. Digits only is a date or a number (2026-0929), never a code
    kind: "device-code",
    // "code" as a word (device code, user_code, codes, passcode), not inside another one (Codex, decode)
    find: (l, before) => /(?<![A-Za-z])(pass)?codes?(?![A-Za-z])|コード/i.test(`${before}\n${l}`) && [...l.matchAll(/(?<![A-Za-z0-9-])([A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Za-z0-9-])/g)].some((m) => !placeholder(m[1]!) && /[A-Z]/.test(m[1]!)),
  },
  { kind: "aws-key", find: (l) => /(?<![A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/.test(l) || /aws_(secret_access_key|session_token)\s*[=:]\s*["']?[A-Za-z0-9/+=]{20,}/i.test(l) },
  { kind: "github-token", find: (l) => /(?<![A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/.test(l) },
  { kind: "private-key", find: (l) => /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----/.test(l) },
  // 20 and more: a token is that long, and a sentence about "Bearer authentication" or "Bearer tokens" is not one
  { kind: "bearer-token", find: (l) => /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i.test(l) },
  // Twelve digits are also a part of a UUID, a hash or an id by chance, so they hit by value or by context (#2345), not
  // by excepting shapes: see accountIdAt
  { kind: "account-id", find: (l, before, host) => [...l.matchAll(/(?<![0-9])[0-9]{12}(?![0-9])/g)].some((m) => accountIdAt(l, before, m.index!, host)) },
  { kind: "sso-start-url", find: (l) => [...l.matchAll(/([a-z0-9-]+)\.awsapps\.com\/start/g)].some((m) => !placeholder(m[1]!.replace(/^d-/, "")) && m[1] !== "example") },
  { kind: "invite-secret", find: (l) => [...l.matchAll(/#k=([A-Za-z0-9_-]{16,})/g)].some((m) => !placeholder(m[1]!)) },
  // A profile or SSO session name has no shape of its own, so the names come from the host's AWS config (`host.names`). A
  // name is a word: a longer word that continues it (`<name>-host`) is another word. A name that is a plain word of
  // letters (an ordinary noun, as in prose) hits only where it is named as a profile or a session: it is also what a
  // sentence says without leaking anything (a repository can have hundreds of such lines)
  { kind: "aws-profile", find: (l, _before, host) => host.names.some((n) => (/^[A-Za-z]+$/.test(n) ? namedAsProfile(l, n) : wordIn(l, n))) },
];

const notWord = /[A-Za-z0-9_-]/;

const NAMED_AS_PROFILE = /(profile|sso[-_ ]?session|プロファイル名?|セッション名?)(は|が|を)?\W{0,4}$/i;
const ARN_BEFORE_ACCOUNT = /arn(?::|%3A)aws[a-z-]*(?::|%3A)[a-z0-9-]+(?::|%3A)[a-z0-9-]*(?::|%3A)$/i;
// a word about an account or about AWS, on the line or in the label above it
const ACCOUNT_CONTEXT = /account|アカウント|プロファイル|(?<![A-Za-z])(aws|iam|sso|arn|role|profile)(?![A-Za-z])/i;

/**
 * Whether the twelve digits at `at` are an account id. One of the host's own accounts is, wherever it is written (bare,
 * inside a profile name, where a UUID ends). Any other is only with context: inside an ARN, inside a word named as a
 * profile, or standing apart from letters (`-` and `_` join it to a name) on a line that speaks of an account or AWS.
 * Twelve digits that touch letters (inside hex) take no context, and the two numbers the cloud's documents use as
 * examples are none. An account outside the config written bare with no context is not seen (the answer to #2345).
 */
function accountIdAt(line: string, before: string, at: number, host: HostAws): boolean {
  const id = line.slice(at, at + 12);
  if (host.accountIds.includes(id)) return true;
  if (id === "123456789012" || id === "000000000000") return false;
  const head = line.slice(0, at);
  if (ARN_BEFORE_ACCOUNT.test(head)) return true;
  let start = at;
  while (start > 0 && notWord.test(line[start - 1]!)) start--;
  if (NAMED_AS_PROFILE.test(line.slice(0, start))) return true;
  return !/[A-Za-z0-9]/.test(line[at - 1] ?? "") && !/[A-Za-z0-9]/.test(line[at + 12] ?? "") && ACCOUNT_CONTEXT.test(`${before}\n${line}`);
}

function wordIn(line: string, name: string): boolean {
  return wordAt(line, name, () => true);
}

/** `--profile <name>`, `AWS_PROFILE=<name>`, `[profile <name>]`, `sso_session = <name>`, `"profile": "<name>"`. */
function namedAsProfile(line: string, name: string): boolean {
  return wordAt(line, name, (before) => NAMED_AS_PROFILE.test(before));
}

function wordAt(line: string, name: string, beforeOk: (before: string) => boolean): boolean {
  const lower = line.toLowerCase();
  const n = name.toLowerCase();
  for (let at = lower.indexOf(n); at >= 0; at = lower.indexOf(n, at + 1)) {
    const [prev, next] = [lower[at - 1] ?? "", lower[at + n.length] ?? ""];
    // `<name>` is how a text withholds a value, even when the host's profile is called "profile"
    if (prev === "<" && next === ">") continue;
    if (!notWord.test(next) && !notWord.test(prev) && beforeOk(line.slice(0, at))) return true;
  }
  return false;
}

/** The profile and SSO session names a config file declares (`[profile <name>]`, `[sso-session <name>]`); not `default`. */
export function awsNames(config: string): string[] {
  const names = new Set<string>();
  for (const line of config.split("\n")) {
    const m = /^\s*\[\s*(?:profile|sso-session)\s+(\S.*?)\s*\]\s*$/.exec(line);
    if (m && m[1] !== "default") names.add(m[1]!);
  }
  return [...names];
}

/** The twelve-digit numbers a config file holds (`sso_account_id = …`, the account inside `role_arn = arn:aws:iam::…`). */
export function awsAccountIds(config: string): string[] {
  return [...new Set(config.match(/(?<![0-9])[0-9]{12}(?![0-9])/g) ?? [])];
}

/** This host's AWS config (`AWS_CONFIG_FILE`, else `~/.aws/config`), read once; nothing where there is no config. */
export function hostAws(env: NodeJS.ProcessEnv = process.env): HostAws {
  try {
    const config = readFileSync(env.AWS_CONFIG_FILE || join(homedir(), ".aws", "config"), "utf8");
    return { names: awsNames(config), accountIds: awsAccountIds(config) };
  } catch {
    return NO_HOST;
  }
}

export const SECRET_KINDS = RULES.map((r) => r.kind);

function labelAbove(lines: string[], i: number): string {
  for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
    const line = lines[j]!.trim();
    if (line === "" || /^(```|~~~)/.test(line)) continue;
    // the marks are dropped only to see the shape; the rules read the line as written (user_code keeps its "_")
    const bare = line.replace(/[*_`]/g, "").trim();
    return bare.length <= 40 && (/[:：]$/.test(bare) || /^#+ /.test(bare)) ? line : "";
  }
  return "";
}

export function findSecrets(text: string, host: HostAws = NO_HOST): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const above = labelAbove(lines, i);
    for (const r of RULES) if (r.find(line, above, host)) hits.push({ kind: r.kind, line: i + 1 });
  });
  return hits;
}
