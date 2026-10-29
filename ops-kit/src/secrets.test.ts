import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsAccountIds, awsNames, findSecrets, hostAws, SECRET_KINDS } from "./secrets.ts";

// Made-up values, put together here so that no file of the repository holds one in a single piece
const A = (n: number) => "A".repeat(n);
const code = ["QWJK", "ZRTP"].join("-");
const account = "4".repeat(12);
const hit: Record<string, string> = {
  "approval-url": `承認: https://device.example/?user_code=${code}`,
  "device-code": `コード ${code} を入力してください`,
  "aws-key": `key: ${"AKIA"}${A(16)}`,
  "github-token": `token ${"ghp"}_${A(36)}`,
  "gitlab-token": `PRIVATE-TOKEN: ${"glpat"}-${A(20)}`,
  "private-key": `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`,
  "bearer-token": `Authorization: Bearer ${A(24)}`,
  "account-id": `aws sso login --profile AdministratorAccess-${account}`,
  "sso-start-url": `開始 URL https://d-${"9".repeat(10)}.awsapps.com/start`,
  "invite-secret": `https://trip.example/c/abc#k=${A(22)}`,
  "aws-profile": "aws sso login --profile x-admin",
};
// Made-up names, as a host's AWS config would declare them
const names = ["x-admin", "y-session"];
const host = { names, accountIds: [] };

describe("findSecrets", () => {
  test("every kind has a value that hits, reported as kind and line", () => {
    expect(Object.keys(hit).sort()).toEqual([...SECRET_KINDS].sort());
    for (const [kind, line] of Object.entries(hit)) {
      expect(findSecrets(`一行目\n${line}`, host).filter((h) => h.kind === kind)).toEqual([{ kind, line: 2 }]);
    }
  });

  test("a code with one letter, and an account id under a label on the line above", () => {
    expect(findSecrets(`コード ${["A123", "4567"].join("-")}`)).toEqual([{ kind: "device-code", line: 1 }]);
    // an account id under a label hits; the same digits further down, with no label, are not under it
    expect(findSecrets(`アカウント ID:\n${account}\n\n${account}`)).toEqual([{ kind: "account-id", line: 2 }]);
    expect(findSecrets(`device code:\n${code}`)).toEqual([{ kind: "device-code", line: 2 }]);
    // the label in Markdown, and a blank line or a code fence between the label and the value
    for (const label of ["**Device code:**", "## Device code", "device codes:", "passcode:", "user_code:", "`device_code`:"]) expect({ label, hits: findSecrets(`${label}\n${code}`) }).toEqual({ label, hits: [{ kind: "device-code", line: 2 }] });
    expect(findSecrets(`**アカウント ID:**\n\n${account}`)).toEqual([{ kind: "account-id", line: 3 }]);
    expect(findSecrets(`device code:\n\`\`\`\n${code}\n\`\`\``)).toEqual([{ kind: "device-code", line: 3 }]);
    // a sentence above is not a label: the line below is read on its own
    expect(findSecrets(`aws sso login --profile <profile> を実行した\nrun ${account} finished`)).toEqual([]);
  });

  test("a hit never carries the value", () => {
    for (const line of Object.values(hit)) expect(JSON.stringify(findSecrets(line))).not.toMatch(/QWJK|AAAA|4444|9999/);
  });

  test("ordinary text does not hit", () => {
    const fine = [
      "PR #12（`sb/3-example-topic`）、コミット 0a1b2c3、2026-01-02 03:04",
      "コードは XXXX-XXXX の形。URL は `?user_code=…` 付き",
      "承認 URL `?user_code=XXXX-XXXX` は Issue に書かない",
      "code review of 2026-0929, build 1234-5678", // digits only: a date, a number
      `Codex のレビュー: ${["R123", "4567"].join("-")} を見て decode する`, // no word "code" on the line
      "`#k=` のあとに XXXXXXXXXXXXXXXXXXXXXX と伏せる: https://trip.example/c/abc#k=XXXXXXXXXXXXXXXXXXXXXX",
      "docs の #key=section-heading-example と #token=see-the-design-document へのリンク",
      "Bearer authentication と Bearer tokens の説明",
      "aws sso login --profile <profile>（アカウント ID は <account-id>）",
      "the example account 123456789012 in arn:aws:iam::123456789012:role/x",
      "comment 5892517698, run 17654321098, at 1790692590044 ms",
      "しおりの URL（`#k=…` の無い方）と `#k=<secret>`",
      "開始 URL は https://d-xxxxxxxxxx.awsapps.com/start の形",
      "Bearer <token> を付ける。AKIA で始まる鍵",
      "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    ];
    for (const line of fine) expect({ line, hits: findSecrets(line) }).toEqual({ line, hits: [] });
  });

  test("the wider rules of #775: a short fine-grained token, a lowercase bearer, a key heading with digits", () => {
    for (const [kind, line] of [
      ["github-token", `token ${"github_pat"}_${A(22)}`],
      ["bearer-token", `authorization: bearer ${A(20)}==`],
      ["private-key", `-----BEGIN ${"EC2"} PRIVATE KEY-----`],
      // the boundaries: a key right after a lowercase letter, a token right after "=", "=" inside a bearer token
      ["aws-key", `id=x${"AKIA"}${A(16)}`],
      ["github-token", `t=${"ghp"}_${A(36)}`],
      ["gitlab-token", `glab config set token ${"glrt"}-${A(24)}`],
      ["bearer-token", `Bearer ${A(18)}==`],
    ] as const) expect({ line, hits: findSecrets(line) }).toEqual({ line, hits: [{ kind, line: 1 }] });
  });
});

describe("account-id", () => {
  // made up, as a host's config would hold it; put together so that no file holds it in one piece
  const known = ["2468", "1357", "9024"].join("");
  const config = ["[profile x-admin]", `sso_account_id = ${known}`, "[profile y-role]", `role_arn = arn:aws:iam::${"3".repeat(12)}:role/deploy`].join("\n");
  const own = { names: [], accountIds: awsAccountIds(config) };
  const uuidEndingIn = (digits: string) => `<!-- manager-op:3f2a1b4c-1d2e-4a5b-8c9d-${digits} -->`;

  test("known account ids hit wherever they are written, with no word around them", () => {
    expect(awsAccountIds(config)).toEqual([known, "3".repeat(12)]);
    for (const l of [known, `メモ ${known} を見た`, `dev${known}-admin`, uuidEndingIn(known), `issue comment id ${"3".repeat(12)} was deleted`]) {
      expect({ l, hits: findSecrets(l, own) }).toEqual({ l, hits: [{ kind: "account-id", line: 1 }] });
    }
    // the same lines say nothing on a host without that config
    for (const l of [known, `dev${known}-admin`, uuidEndingIn(known)]) expect({ l, hits: findSecrets(l) }).toEqual({ l, hits: [] });
  });

  test("account context: an ARN, a word named as a profile, a word about an account or AWS on the line or the label", () => {
    for (const l of [
      `arn:aws:iam::${account}:role/x`,
      `https://console.aws.example/iam?arn=arn%3Aaws%3Aiam%3A%3A${account}%3Arole%2Fx`,
      `aws sso login --profile dev${account}-admin`,
      `AWS_PROFILE=dev${account}-admin`,
      `aws profile Admin-${account}`,
      `aws profile ${account}_Admin`,
      `aws profile task_${account}-admin`,
      `Account ID ${account}`,
      `アカウント ${account} に入った`,
      `role ${account} を使う`,
    ]) expect({ l, hits: findSecrets(l) }).toEqual({ l, hits: [{ kind: "account-id", line: 1 }] });
    expect(findSecrets(`## AWS\n${account}`)).toEqual([{ kind: "account-id", line: 2 }]);
  });

  test("no context: twelve digits of a UUID, a hash, an id or a count are no account", () => {
    for (const l of [
      uuidEndingIn(account),
      `commit ab${account}cdef0123456789abcdef012345`,
      `aws の鍵は DER の接頭辞 302e${"1".repeat(12)}f32b${"7".repeat(12)}a に seed を足す`,
      `| 9 | task_${"5972953".concat("02356")} | 完了 |`,
      "issue comment id 589251769812 was deleted",
      `run ${account} finished`,
      // the examples of the cloud's documents, even in an ARN
      "arn:aws:iam::123456789012:role/x and account 000000000000",
    ]) expect({ l, hits: findSecrets(l) }).toEqual({ l, hits: [] });
  });

  test("a hit never carries the value of the config", () => {
    const hits = findSecrets(`一行目\n${known}\n${uuidEndingIn(known)}`, own);
    expect(hits).toEqual([{ kind: "account-id", line: 2 }, { kind: "account-id", line: 3 }]);
    expect(JSON.stringify(hits)).not.toContain(known);
  });
});

// The cases of the test of a repository that kept a scan of its own (named in #775), with its kinds read as ours
// (device-login-url → approval-url, aws-access-key → aws-key, bearer → bearer-token, aws-account-id → account-id). The
// common rules have to find at least what that scan finds before the repository can drop it
describe("own-scan parity", () => {
  const cut = (...parts: string[]) => parts.join("");
  const kinds = (text: string) => findSecrets(text).map((h) => h.kind);
  const hits: Array<[string, string]> = [
    ["approval-url", `承認: https://device.sso.us-east-1.amazonaws.com/?${cut("user", "_code=")}${cut("WXYZ", "QRST")}`],
    ["device-code", `デバイスの${cut("コード")}は ${cut("QZXW", "-", "RT7K")} です`],
    ["aws-key", `key ${cut("AK", "IA")}${cut("EXAMPLE", "FAKE", "Q1W2E")}`],
    ["github-token", `token ${cut("gh", "p_")}${"a1B2".repeat(9)}`],
    ["private-key", cut("-----BEGIN OPENSSH ", "PRIVATE KEY-----")],
    ["bearer-token", `Authorization: ${cut("Bear", "er")} ${cut("eyJhbGciOi", "Jub25lIn0.", "e30.x")}`],
    ["account-id", `arn:aws:iam::${cut("1098", "7654", "3210")}:role/dev`],
    ["sso-start-url", `開始 URL ${cut("https://d-9", "0000abcd", ".awsapps.com/start")}`],
    ["invite-secret", `https://trip.example/i/abc${cut("#k", "=")}${cut("Zm9vYmFy", "LWJhel9x", "dXg")}`],
    // the review of that scan
    ["account-id", `--profile dev${cut("1098", "7654", "3210")}-admin`],
    ["approval-url", `https://device.sso.us-east-1.amazonaws.com/?${cut("user", "_code=")}%57${cut("XYZ", "QRST")}`],
    ["approval-url", `https://example.invalid/?${cut("user", "_code=")}/${cut("WXYZ", "QRST")}`],
    ["approval-url", `https://example.invalid/?${cut("user", "_code=")}(${cut("WXYZ", "QRST")})`],
  ];
  const misses = [
    `承認 URL は ?${cut("user", "_code=")}<伏せた> の形（値を伏せた）`,
    `const url = \`https://d.example/?${cut("user", "_code=")}\${code}\`; // a template placeholder in code, not a value`,
    `ブランチ ${cut("ABCD", "-", "EFGH")} を切った（この行に例の語は無い）`,
    `${cut("AK", "IA")} で始まる鍵は書かない`,
    `${cut("gh", "p_")}… のトークンは書かない`,
    "-----BEGIN PUBLIC KEY-----",
    `Authorization: ${cut("Bear", "er")} <token>`,
    "2026-09-29 に #387、commit 7301cd1a9b2c3d4e5f60718293a4b5c6d7e8f901 と 13 桁の時刻 1790740862511",
    "SSO の開始 URL は https://<伏せた>.awsapps.com/start の形",
    `参加者のリンクは ${cut("#k", "=")}… の形（値を伏せた）`,
    // the numbers an Issue holds
    "#387 の Task #389、PR #394",
    `commit ${cut("ab", "123456789012", "cdef0123456789abcdef012345")}`,
    "2026-09-29T21:17:00+09:00、resets_at 1790758800、updated_at 1790740862511",
    "https://github.com/owner/repo/issues/387#issuecomment-5903787010",
    "device code は `aws sso login` が出す。値を伏せた。番号だけの 1234-5678 は code の隣でも当たらない",
    // a withheld user_code
    `?${cut("user", "_code=")}伏せた、?${cut("user", "_code=")}…、?${cut("user", "_code=")}<値を伏せた>`,
    `(?${cut("user", "_code=")}XXXX-XXXX)`,
  ];

  test("every hit of that scan is a hit of the same kind", () => {
    for (const [kind, line] of hits) expect({ line, kinds: kinds(line) }).toEqual({ line, kinds: [kind] });
  });

  test("every miss of that scan is a miss", () => {
    for (const line of misses) expect({ line, hits: findSecrets(line) }).toEqual({ line, hits: [] });
  });
});

describe("aws-profile", () => {
  const config = ["[default]", "region = ap-northeast-1", "[profile x-admin]", "sso_session = y-session", "[sso-session y-session]", "sso_region = ap-northeast-1", "[ profile  x-admin ]"].join("\n");

  test("the names come from the profile and sso-session sections, not default", () => {
    expect(awsNames(config)).toEqual(names);
  });

  test("a line holding a name as a word hits, as kind and line only", () => {
    const text = "一行目\naws --profile X-Admin を使った\n(y-session)";
    const hits = findSecrets(text, host);
    expect(hits).toEqual([{ kind: "aws-profile", line: 2 }, { kind: "aws-profile", line: 3 }]);
    expect(JSON.stringify(hits)).not.toMatch(/x-admin|y-session/i);
  });

  test("an empty section name is no name, and a withheld form is no hit even for a profile called profile", () => {
    expect(awsNames("[profile   ]\n[sso-session ]\n")).toEqual([]);
    expect(findSecrets("通常の文:  done", { names: awsNames("[profile   ]"), accountIds: [] })).toEqual([]);
    expect(findSecrets("aws --profile <profile>", { names: ["profile"], accountIds: [] })).toEqual([]);
    expect(findSecrets("aws --profile profile", { names: ["profile"], accountIds: [] })).toEqual([{ kind: "aws-profile", line: 1 }]);
  });

  test("a longer word, default, a withheld name and a text without a name do not hit", () => {
    for (const l of ["x-admin-host", "myx-admin", "x-admin_2", "--profile default", "--profile <profile>", "--profile <sso-session>", "何も無い行"]) {
      expect({ l, hits: findSecrets(l, host) }).toEqual({ l, hits: [] });
    }
  });

  test("a name that is a plain word hits only where it is named as a profile or a session", () => {
    // a made-up example (#2078): a dictionary word that says it is a stand-in, not a name on any host
    const plain = { names: ["placeholder"], accountIds: [] };
    for (const l of ["aws sso login --profile placeholder", "AWS_PROFILE=placeholder", "[profile Placeholder]", "sso_session = placeholder", '"profile": "placeholder"']) {
      expect({ l, hits: findSecrets(l, plain) }).toEqual({ l, hits: [{ kind: "aws-profile", line: 1 }] });
    }
    expect(findSecrets("プロファイル名は placeholder", plain)).toEqual([{ kind: "aws-profile", line: 1 }]);
    for (const l of ["a placeholder is a place", "the placeholder profile is a page", "placeholder-side", "profile placeholders", "profile for the placeholder"]) {
      expect({ l, hits: findSecrets(l, plain) }).toEqual({ l, hits: [] });
    }
  });

  test("with no names nothing hits, and a host without a config has none", () => {
    expect(findSecrets("aws sso login --profile x-admin")).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "kit.awsnames."));
    expect(hostAws({ AWS_CONFIG_FILE: join(dir, "missing") })).toEqual({ names: [], accountIds: [] });
    const file = join(dir, "config");
    writeFileSync(file, `${config}\nsso_account_id = ${account}`);
    expect(hostAws({ AWS_CONFIG_FILE: file })).toEqual({ names, accountIds: [account] });
  });
});
