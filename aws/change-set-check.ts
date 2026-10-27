/**
 * May this change set be executed (#465)? Reads `aws cloudformation describe-change-set --output json` on stdin.
 * Two shapes are refused, with one line saying why:
 * - a VPC origin modified in place while Instance is replaced: CloudFront refuses it (CannotUpdateEntityWhileInUse) and
 *   the stack rolls back. That is a deploy that changes the launch template without a new LaunchGeneration.
 * - any change to the launch template or Instance: it replaces the instance (the runners' logins on its disk go, a Spot
 *   request has to be cancelled first), so it is a person's deploy. `--allow-replace` (that person) lets this one through.
 * scripts/host-ops.ts (the GitHub workflow's deploy) runs the check without the flag; aws/README.md, a person, with it.
 */
export interface ChangeSet {
  Changes?: { ResourceChange?: { Action?: string; LogicalResourceId?: string; ResourceType?: string; Replacement?: string } }[];
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export function checkChangeSet(cs: ChangeSet, opts: { allowReplace?: boolean } = {}): Verdict {
  const changes = (cs.Changes ?? []).map((c) => c.ResourceChange ?? {});
  const instance = changes.find((c) => c.LogicalResourceId === "Instance");
  const replaced = instance?.Replacement === "True" || instance?.Replacement === "Conditional";
  const inPlace = changes.find((c) => c.ResourceType === "AWS::CloudFront::VpcOrigin" && c.Action === "Modify");
  if (replaced && inPlace) {
    return { ok: false, reason: `VPC origin ${inPlace.LogicalResourceId} would be updated in place while Instance is replaced (CannotUpdateEntityWhileInUse): deploy again with LaunchGeneration=$(date -u +%Y%m%d%H%M) (aws/README.md)` };
  }
  if (!opts.allowReplace && changes.some((c) => c.LogicalResourceId === "Instance" || c.LogicalResourceId === "LaunchTemplate")) {
    return { ok: false, reason: "this change set replaces the instance (the launch template or Instance changes): that deploy is a person's (aws/README.md)" };
  }
  return { ok: true };
}

if (import.meta.main) {
  const flags = process.argv.slice(2);
  if (flags.some((f) => f !== "--allow-replace")) {
    console.error("usage: aws cloudformation describe-change-set --change-set-name <arn> --output json | bun aws/change-set-check.ts [--allow-replace]");
    process.exit(2);
  }
  let cs: ChangeSet;
  try {
    cs = JSON.parse(await Bun.stdin.text());
  } catch {
    console.error("stdin is not describe-change-set's JSON");
    process.exit(2);
  }
  const v = checkChangeSet(cs, { allowReplace: flags.includes("--allow-replace") });
  if (!v.ok) {
    console.error(v.reason);
    process.exit(1);
  }
}
