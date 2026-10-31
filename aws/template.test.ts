import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/**
 * aws/template.yaml (#229) read as text: CloudFormation's short tags (!Ref, !Sub …) are not plain YAML, and
 * `sam validate --lint` (run by hand, see aws/README.md) checks the rest. These pin what the PBI's criteria rest on.
 */
const text = await Bun.file(new URL("./template.yaml", import.meta.url)).text();

/** The body of one top-level resource: from `  Name:` to the next resource at the same indent. */
function resource(name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no resource ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z]/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** One VPC origin inside the `Fn::ForEach::Edge` loop (#465): from its `<name>${Gen}:` key to the next key at that indent. */
function edgeOrigin(name: string): string {
  const start = text.indexOf(`${name}\${Gen}:\n`);
  if (start < 0) throw new Error(`no origin ${name}`);
  const rest = text.slice(start);
  const next = rest.slice(1).search(/\n {4,6}[A-Za-z][A-Za-z]*\$\{Gen\}:|\n {2}[A-Za-z]/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The instance role's ssm:GetParameter statement, as text. */
function hostSsmStatement(): string {
  const role = resource("InstanceRole");
  const start = role.indexOf("Action: [ssm:GetParameter, ssm:GetParameters]");
  return role.slice(start, role.indexOf("- Effect:", start));
}

/** The parameters the instance role may read: the names in its ssm:GetParameter statement. */
function hostParams(): Set<string> {
  return new Set([...hostSsmStatement().matchAll(/parameter\/switchboard\/([a-z0-9-]+|\*)'/g)].map((m) => m[1]!));
}

describe("aws/template.yaml (#229)", () => {
  test("has the resources the host needs", () => {
    for (const r of ["Data", "Sg", "RescueSg", "Boundary", "InstanceRole", "InstanceProfile", "LaunchTemplate", "Instance", "SchedulerRole", "StartPage", "StartPageAccess", "Cdn", "Starter", "DeployRole", "GitHubOidcRole", "BudgetLow", "BudgetHigh"]) {
      expect(text).toContain(`\n  ${r}:\n`);
    }
    for (const o of ["Origin", "InstanceId", "DataBucket", "StarterUrl", "OidcRoleArn"]) expect(text).toMatch(new RegExp(`\\n  ${o}:\\n    Value:`));
  });

  test("the security groups let in CloudFront's prefix list and nothing else, one group per port (the list weighs ~55 rules)", () => {
    for (const [name, port] of [["Sg", 47831], ["RescueSg", 47841]] as const) {
      const sg = resource(name);
      const rules = sg.split("\n").filter((l) => l.includes("IpProtocol"));
      expect(rules).toHaveLength(1);
      expect(rules[0]).toContain(`FromPort: ${port}, ToPort: ${port}, SourcePrefixListId: !Ref CloudFrontPrefixListId`);
      expect(sg).not.toMatch(/CidrIp|SourceSecurityGroup|0\.0\.0\.0\/0/);
    }
    expect(text).toContain("Groups: [!Ref Sg, !Ref RescueSg]");
  });

  test("the instance is on-demand unless Market is spot, and stops (not terminates) on interruption and on shutdown", () => {
    const lt = resource("LaunchTemplate");
    // on-demand by default (#443); Spot only when Market says so, and then it stops (not terminates) on interruption
    expect(text).toMatch(/  Market:\n    Type: String\n    Default: on-demand\n    AllowedValues: \[on-demand, spot\]/);
    expect(lt).toContain("- { MarketType: spot, SpotOptions: { SpotInstanceType: persistent, InstanceInterruptionBehavior: stop } }");
    expect(lt).toContain("InstanceMarketOptions: !If\n          - Spot");
    expect(text).toContain("  Spot: !Equals [!Ref Market, spot]\n");
    // the Spot request's tags only with Spot: a tag specification for a resource the launch does not create fails it
    expect(lt).toContain("- !If [Spot, { ResourceType: spot-instances-request,");
    expect(lt).not.toMatch(/^ {10}- \{ ResourceType: spot-instances-request/m);
    expect(lt).toContain("InstanceInterruptionBehavior: stop");
    expect(lt).toContain("InstanceInitiatedShutdownBehavior: stop");
    expect(lt).toContain("HttpTokens: required");
  });

  test("two monthly budgets, about 1,000 and 3,000 yen", () => {
    const amounts = [...text.matchAll(/BudgetLimit: \{ Amount: (\d+), Unit: USD \}/g)].map((m) => Number(m[1]));
    expect(amounts.sort((a, b) => a - b)).toEqual([7, 20]);
    expect(resource("BudgetLow")).toContain("Address: !Ref BudgetEmail");
    // only this project's resources: another project may share the account (review #338)
    for (const b of ["BudgetLow", "BudgetHigh"]) expect(resource(b)).toContain("CostFilters: { TagKeyValue: [!Sub 'user:Project$${CostTag}'] }");
  });

  test("backups survive the instance role: versioning on, and the role cannot remove a version or loosen the bucket", () => {
    expect(resource("Data")).toContain("VersioningConfiguration: { Status: Enabled }");
    const role = resource("InstanceRole");
    const deny = role.slice(role.indexOf("Effect: Deny"));
    for (const a of ["s3:DeleteObjectVersion", "s3:PutBucketVersioning", "s3:PutLifecycleConfiguration"]) expect(deny).toContain(a);
    // the role reads only its own parameters
    expect(hostParams().size).toBeGreaterThan(0);
    expect(role).not.toMatch(/ssm:\*|Action: '\*'/);
  });

  test("no author-specific user or path: the host user, HOME and repos directory are parameters", () => {
    for (const p of ["HostUser", "HostHome", "ReposDir"]) expect(text).toContain(`\n  ${p}:\n`);
    expect(text).not.toMatch(/\/Users\/|\/Volumes\//);
  });

  test("the OIDC role trusts only the repository's main branch", () => {
    const oidc = resource("GitHubOidcRole");
    // with the prefix only the id-pinned subject; without it only the name (review #466: never both)
    expect(oidc).toContain("- ImmutableSub\n                  - !Sub '${GitHubSubPrefix}:ref:refs/heads/main'\n                  - !Sub 'repo:${GitHubRepo}:ref:refs/heads/main'");
    expect(text).toContain("AllowedPattern: '(repo:[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+)?'");
    expect(oidc).toContain("'token.actions.githubusercontent.com:aud': sts.amazonaws.com");
  });

  test("CloudFront sends the shared header to the host, and a stopped host is answered by the start page", () => {
    const cdn = resource("Cdn");
    expect(cdn.match(/HeaderName: x-switchboard-edge, HeaderValue: !Ref EdgeHeaderValue/g)).toHaveLength(3); // host, rescue, auth (#211)
    expect(cdn).toContain("ResponsePagePath: /_start/index.html");
    expect(text).toMatch(/EdgeHeaderValue:\n {4}Type: String\n {4}NoEcho: true/);
  });

  test("CloudFront reaches the instance as a VPC origin by id, never its public address in plain text (review #338)", () => {
    const cdn = resource("Cdn");
    expect(cdn).not.toContain("PublicDnsName");
    // the only custom origin is the Starter's Function URL (#211), over https only
    expect(cdn.match(/CustomOriginConfig: \{[^}]*\}/g)).toEqual(["CustomOriginConfig: { OriginProtocolPolicy: https-only, OriginSSLProtocols: [TLSv1.2] }"]);
    expect(cdn.match(/VpcOriginConfig: \{ VpcOriginId: !GetAtt \[!Sub '(Host|Rescue)VpcOrigin\$\{LaunchGeneration\}', Id\]/g)).toHaveLength(2);
    expect(cdn.match(/ConnectionAttempts: 1/g)).toHaveLength(2); // a stopped host falls through to the start page quickly
    for (const o of ["HostVpcOrigin", "RescueVpcOrigin"]) {
      const r = edgeOrigin(o);
      expect(r).toContain("Arn: !Sub 'arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Instance}'");
      expect(r).not.toContain("InstanceGeneration"); // an origin in use cannot be replaced by a rename (re-review #338)
    }
    expect(resource("InstanceRole")).not.toContain("cloudfront:"); // nothing on the host rewrites the distribution (only the Starter does, #1639)
  });

  test("VPC origins take their logical ids from LaunchGeneration, so a launch template change creates new ones (#465)", () => {
    // LanguageExtensions before Serverless (CloudFormation's order); Fn::ForEach is the only way to a logical id from a parameter
    expect(text).toStartWith("AWSTemplateFormatVersion: '2010-09-09'\nTransform: [AWS::LanguageExtensions, AWS::Serverless-2016-10-31]\n");
    // the default is the generation the stack has now: this change alone creates and deletes no origin
    expect(text).toMatch(/\n {2}LaunchGeneration:\n {4}Type: String\n {4}Default: '4'\n {4}AllowedPattern: '\[0-9\]\+'\n/);
    const loop = text.slice(text.indexOf("\n  Fn::ForEach::Edge:\n"), text.indexOf("\n  Cdn:\n"));
    expect(loop).toStartWith("\n  Fn::ForEach::Edge:\n    - Gen\n    - [!Ref LaunchGeneration]\n");
    expect(loop).toContain("\n    - HostVpcOrigin${Gen}:\n");
    expect(loop).toContain("\n      RescueVpcOrigin${Gen}:\n");
    expect(edgeOrigin("HostVpcOrigin")).toContain("Name: !Sub '${AWS::StackName}-host-${Gen}'");
    expect(edgeOrigin("RescueVpcOrigin")).toContain("Name: !Sub '${AWS::StackName}-rescue-${Gen}'");
    // Cdn keeps its logical id (a loop's keys must carry the identifier, so it stays outside and finds them by the parameter)
    expect(text).toContain("\n  Cdn:\n    Type: AWS::CloudFront::Distribution\n");
    expect(text).not.toMatch(/VpcOrigin[0-9]/);
    // every role that creates the change set may run both transforms
    for (const r of ["Boundary", "DeployRole", "GitHubOidcRole"]) {
      const body = r === "Boundary" ? text.slice(text.indexOf("\n  Boundary:\n"), text.indexOf("\n  InstanceRole:\n")) : resource(r);
      expect(body).toContain("!Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/LanguageExtensions'");
    }
  });

  test("the Spot request is persistent (stop on interruption); nothing automatic terminates the instance or cancels the request (re-review #338)", () => {
    expect(resource("LaunchTemplate")).toContain("SpotInstanceType: persistent");
    expect(text).not.toContain("InstanceGeneration");
    expect(text).not.toContain("ec2:CancelSpotInstanceRequests");
  });

  test("作り直す is a root volume replacement: the Starter may start, stop and replace the root of its one instance, and nothing else (re-review #338, #1394)", () => {
    const starter = resource("Starter");
    expect(starter).toContain("Action: [ec2:StartInstances, ec2:StopInstances, ec2:CreateReplaceRootVolumeTask]\n              Resource: !Sub 'arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Instance}'");
    for (const gone of ["cloudformation:", "iam:PassRole", "DeployRole", "SB_STACK_NAME", "ec2:TerminateInstances", "ec2:RebootInstances"]) expect(starter).not.toContain(gone);
    expect(resource("Boundary")).toContain("Action: [ec2:StartInstances, ec2:StopInstances, ec2:CreateReplaceRootVolumeTask]");
  });

  test("the boundary names this stack's resources; '*' only for Describe and for KMS through SSM / EC2 (re-review #338)", () => {
    const boundary = resource("Boundary");
    for (const st of boundary.split("- Sid: ").slice(1)) {
      if (!st.includes("Resource: '*'")) continue;
      const sid = st.split("\n")[0];
      expect(["Describe", "ManagedKeysThroughServices", "AgentMetrics", "CostRead"]).toContain(sid);
      if (sid === "ManagedKeysThroughServices") expect(st).toContain("kms:ViaService");
      if (sid === "AgentMetrics") expect(st).toContain("'cloudwatch:namespace': CWAgent");
    }
    expect(boundary).toContain("Resource: !Sub 'arn:aws:iam::${AWS::AccountId}:role/${AWS::StackName}-*'");
    expect(boundary).toContain("'aws:ResourceTag/aws:cloudformation:stack-name': !Ref AWS::StackName");
    const deploy = resource("DeployRole");
    expect(deploy).not.toMatch(/Effect: Allow[^-]*iam:UpdateAssumeRolePolicy/);
    expect(deploy).toContain("StringNotEquals: { 'aws:ResourceTag/aws:cloudformation:stack-name': !Ref AWS::StackName }");
  });

  test("the instance role writes only the replica and the archives; releases are read-only (review #338)", () => {
    const role = resource("InstanceRole");
    expect(role).toContain("Action: [s3:GetObject, s3:PutObject, s3:DeleteObject]\n                Resource: [!Sub '${Data.Arn}/litestream/*', !Sub '${Data.Arn}/archive/*']");
    expect(role).not.toContain("Resource: !Sub '${Data.Arn}/*'");
    expect(role).not.toContain("host/");
  });

  test("the host role can put and get under history/ but not delete, and history/ has no expiration (#1436)", () => {
    const role = resource("InstanceRole");
    const history = role.split("- Effect: ").filter((st) => st.includes("/history/*"));
    expect(history.map((st) => st.match(/Action: (.*)/)![1]).sort()).toEqual(["s3:GetObject", "s3:PutObject"]);
    // write-once: an overwrite would leave the old version to old-versions' 30-day expiry
    expect(history.find((st) => st.includes("s3:PutObject"))).toContain("Condition: { StringEquals: { 's3:if-none-match': '*' } }");
    expect(role).not.toMatch(/s3:DeleteObject[^\n]*\n[^\n]*history\//);
    const rules = resource("Data").slice(resource("Data").indexOf("LifecycleConfiguration:"));
    expect(rules).not.toContain("history/");
    expect(rules).toContain("{ Id: archives, Status: Enabled, Prefix: archive/, ExpirationInDays: 30 }");
  });

  test("request logs (#1490): CloudFront's standard log goes to Data's cdn-logs/ for 90 days or more, without cookies, and the host sees the viewer address", () => {
    const cdn = resource("Cdn");
    expect(cdn).toContain("Logging: { Bucket: !GetAtt Data.DomainName, Prefix: cdn-logs/, IncludeCookies: false }");
    const data = resource("Data");
    expect(data).toContain("OwnershipControls: { Rules: [{ ObjectOwnership: BucketOwnerPreferred }] }");
    expect(data).toContain("PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }");
    const days = Number(data.match(/Id: cdn-logs, Status: Enabled, Prefix: cdn-logs\/, ExpirationInDays: (\d+)/)?.[1]);
    expect(days).toBeGreaterThanOrEqual(90);
    // the host's default behaviour forwards CloudFront's own headers (CloudFront-Viewer-Address); /rescue is unchanged
    const behaviours = cdn.split("CacheBehaviors:");
    expect(behaviours[0]).toContain("OriginRequestPolicyId: 33f36d7e-f396-46d9-90e0-52428a34d9dc");
    expect(behaviours[1]).not.toContain("33f36d7e-f396-46d9-90e0-52428a34d9dc");
  });

  test("the daemon's log group (#1490) keeps 90 days or more; the host role may only write to it — no delete, no retention change; nothing reads cdn-logs/", () => {
    const group = resource("HostLogs");
    expect(group).toContain("LogGroupName: /switchboard/host");
    expect(Number(group.match(/RetentionInDays: (\d+)/)?.[1])).toBeGreaterThanOrEqual(90);
    const role = resource("InstanceRole");
    const own = role.split("- Effect: ").find((st) => st.includes("HostLogs.Arn"))!;
    expect(own).toContain("Action: [logs:CreateLogStream, logs:PutLogEvents, logs:DescribeLogStreams]");
    expect(role).not.toMatch(/logs:(Delete|PutRetention)/);
    expect(resource("Boundary")).not.toMatch(/logs:(Delete|PutRetention)/);
    expect(role).not.toContain("cdn-logs");
  });

  test("every role but DeployRole carries the boundary; DeployRole makes roles only with it and never changes it (review #338)", () => {
    for (const r of ["InstanceRole", "SchedulerRole", "Starter", "GitHubOidcRole"]) expect(resource(r)).toContain("PermissionsBoundary: !Ref Boundary");
    const deploy = resource("DeployRole");
    expect(deploy).toContain("Condition: { StringEquals: { 'iam:PermissionsBoundary': !Ref Boundary } }");
    // no Allow on IAM for every resource
    for (const st of deploy.split("- Effect: ").slice(1)) if (st.startsWith("Allow") && st.includes("iam:")) expect(st).not.toContain("Resource: '*'");
    expect(deploy).toMatch(/Effect: Deny\n {16}Action: \[iam:DeleteRolePermissionsBoundary, iam:UpdateAssumeRolePolicy, iam:CreatePolicyVersion/);
    expect(deploy).not.toMatch(/Action: \[ec2:\*, s3:\*/);
  });

  test("additional host roles are optional and scoped to the supplied ARNs", () => {
    expect(text).toContain("  HostAssumeRoleArns:\n    Type: CommaDelimitedList\n    Default: ''");
    expect(text).toContain("  HasHostAssumeRoles: !Not [!Equals [!Join ['', !Ref HostAssumeRoleArns], '']]");
    for (const name of ["Boundary", "InstanceRole"]) {
      const block = resource(name);
      expect(block).toMatch(/- !If\n +\- HasHostAssumeRoles\n +\- (Sid: HostAssumeRoles\n +)?Effect: Allow\n +Action: sts:AssumeRole\n +Resource: !Ref HostAssumeRoleArns\n +\- !Ref AWS::NoValue/);
    }
    expect(text.match(/Action: sts:AssumeRole\n/g)).toHaveLength(2);
  });

  test("UpdateStack on the SAM template may create the transforms' change set (review #344, #465)", () => {
    expect(resource("GitHubOidcRole")).toContain("Resource: [!Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/Serverless-2016-10-31', !Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/LanguageExtensions']");
    // Describe has no resource-level permissions: never behind a tag condition
    expect(resource("GitHubOidcRole")).toMatch(/Action: ec2:DescribeInstances\n {16}Resource: '\*'\n(?! {16}Condition)/);
  });

  test("DeployRole may create the transforms' change set and nothing else in CloudFormation (#759, #465)", () => {
    const deploy = resource("DeployRole");
    expect(deploy).toContain("- Effect: Allow\n                Action: cloudformation:CreateChangeSet\n                Resource: [!Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/Serverless-2016-10-31', !Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/LanguageExtensions']");
    // every action, wildcards too; not the condition keys or ARNs (aws:cloudformation:…)
    expect([...deploy.matchAll(/(?<!aws:)cloudformation:[^\s,\]']+/g)].map((m) => m[0])).toEqual(["cloudformation:CreateChangeSet"]);
  });

  test("the host scripts come from the repository, so the first boot needs no upload (review #338)", () => {
    const lt = resource("LaunchTemplate");
    expect(lt).toContain("clone --depth 1");
    expect(lt).toContain("bash /opt/switchboard-host/aws/host/bootstrap.sh");
    expect(lt).not.toContain("s3://${Data}/host/");
  });

  test("the AMI is a pinned parameter, not resolved from SSM on every deploy (a new AMI would replace Instance and orphan its Spot request)", () => {
    expect(text).not.toContain("{{resolve:ssm:/aws/service/ami-amazon-linux-latest");
    expect(text).toMatch(/\n  ImageId:\n    Type: AWS::EC2::Image::Id/);
    expect(text).toContain("ImageId: !Ref ImageId");
  });

  test("passkey login (#211): /_auth* goes to the Starter uncached, with the shared header and without the viewer's Host", () => {
    const cdn = resource("Cdn");
    expect(cdn).toContain("- Id: auth\n            DomainName: !Select [2, !Split ['/', !GetAtt StarterUrl.FunctionUrl]]");
    const auth = cdn.slice(cdn.indexOf("- Id: auth"), cdn.indexOf("- Id: startpage"));
    expect(auth).toContain("OriginProtocolPolicy: https-only");
    expect(auth).toContain("HeaderName: x-switchboard-edge, HeaderValue: !Ref EdgeHeaderValue");
    const behavior = cdn.slice(cdn.indexOf("- PathPattern: /_auth*"), cdn.indexOf("- PathPattern: /_start/*"));
    expect(behavior).toContain("TargetOriginId: auth");
    expect(behavior).toContain("AllowedMethods: [GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE]");
    expect(behavior).toContain("CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    expect(behavior).toContain("OriginRequestPolicyId: !Ref AuthRequestPolicy");
    // its own Host stays (not forwarded); CloudFront-Viewer-Address goes, for the per-viewer rate limit (review #349)
    const policy = resource("AuthRequestPolicy");
    expect(policy).toContain("Headers: [content-type, user-agent, x-switchboard-ask, CloudFront-Viewer-Address]");
    expect(policy.split("\n").find((l) => l.includes("Headers: ["))).not.toMatch(/\bhost\b/i);
    expect(resource("Starter")).toContain("ReservedConcurrentExecutions: 5");
  });

  test("the Starter reads the login secrets, may delete only the registration code, and touches only auth/passkeys.json", () => {
    const starter = resource("Starter");
    for (const p of ["session-signing-key", "register-code", "edge-header", "start-token"]) expect(starter).toContain(`parameter/switchboard/${p}'`);
    expect(starter).toMatch(/Action: ssm:DeleteParameter\n\s+Resource: !Sub 'arn:aws:ssm:\$\{AWS::Region\}:\$\{AWS::AccountId\}:parameter\/switchboard\/register-code'/);
    expect(starter).toContain("Resource: !Sub '${Data.Arn}/auth/passkeys.json'");
    expect(starter).toContain("Condition: { StringLike: { 's3:prefix': 'auth/*' } }");
    expect(starter).toContain("SB_PUBLIC_ORIGIN: !Ref PublicOrigin");
    // the instance role (agents) cannot add a passkey: it writes only litestream/ and archive/
    expect(resource("InstanceRole")).not.toContain("auth/");
  });

  test("the rescue page's outside URL (#399): /switchboard/web-url is the distribution's https origin, readable by the instance", () => {
    const param = resource("WebUrlParam");
    expect(param).toContain("Name: /switchboard/web-url");
    expect(param).toContain("Value: !Sub 'https://${Cdn.DomainName}'");
    expect(hostParams().has("web-url")).toBe(true);
  });

  test("the host role cannot read the cookie signing key; the Starter can (#701)", () => {
    expect(hostParams().has("session-signing-key")).toBe(false);
    expect(hostParams().has("*")).toBe(false);
    expect(resource("InstanceRole")).not.toContain("parameter/switchboard/session-signing-key");
    expect(resource("Starter")).toContain("parameter/switchboard/session-signing-key'");
    // the host reads the public key, and no longer the old HMAC key the Starter used to sign with
    expect(hostParams().has("session-public-key")).toBe(true);
    expect(hostParams().has("session-key")).toBe(false);
  });

  test("the instance role's SSM reads are a list of names, without register-code (#700)", () => {
    expect(hostParams().has("*")).toBe(false);
    expect(hostParams().has("register-code")).toBe(false);
  });

  /** The names the host's scripts read: the LaunchTemplate's UserData (github-token) and aws/host/. */
  async function scriptParams(): Promise<Set<string>> {
    const dir = new URL("./host/", import.meta.url);
    const texts = [resource("LaunchTemplate")];
    // cloudwatch-agent.json names a log group (/switchboard/host, #1490), not a parameter
    for (const f of new Bun.Glob("*").scanSync(fileURLToPath(dir))) if (!f.endsWith(".test.ts") && f !== "cloudwatch-agent.json") texts.push(await Bun.file(new URL(f, dir)).text());
    return new Set(texts.flatMap((t) => [...t.matchAll(/\/switchboard\/([a-z0-9-]+)/g)].map((m) => m[1]!)));
  }

  /** Read on the host by a program outside this repository (DAK's agent/ssm_exec.py, #1155), not by a script here. */
  const EXTERNAL_PARAMS = ["anthropic-api-key"];

  test("the names the host's scripts read + the one DAK reads = the instance role's SSM resources (#700, #1155)", async () => {
    const read = await scriptParams();
    for (const p of EXTERNAL_PARAMS) expect(read.has(p)).toBe(false); // it is DAK's, not a script's: the list below is the only place it is named
    expect([...read, ...EXTERNAL_PARAMS].sort()).toEqual([...hostParams()].sort());
  });

  test("the host permits only the named Anthropic parameter in addition to existing script parameters", async () => {
    const scripts = await scriptParams();
    const extra = [...hostParams()].filter((p) => !scripts.has(p));
    expect(extra).toEqual(["anthropic-api-key"]);
    for (const p of ["*", "register-code", "session-signing-key"]) expect(hostParams().has(p)).toBe(false);
    // hostParams() reads exact names only: look at the statement's text for a pattern (anthropic-*, sw*) that it would skip
    expect(hostSsmStatement()).not.toMatch(/parameter\/switchboard\/[^'\n]*[*?]/);
    expect(resource("InstanceRole")).toContain("parameter/switchboard/anthropic-api-key'");
    // the key is DAK's alone: neither the Starter nor the deploy role reads it, and nothing here writes it
    for (const r of ["Starter", "DeployRole", "GitHubOidcRole", "SchedulerRole"]) expect(resource(r)).not.toContain("anthropic-api-key");
  });
});

describe("aws/template.yaml memory alarms (#540)", () => {
  /** A resource that may be the last one: cut at the Outputs section. */
  const alarm = (name: string) => resource(name).split("\nOutputs:")[0];
  const line = (body: string, key: string) => body.split("\n").find((l) => l.startsWith(`      ${key}:`));

  test("memory alarm: mem_used_percent >= 80 on every one of 5 minutes, for this instance, with no action", () => {
    const a = alarm("MemoryAlarm");
    expect(a).toContain("Type: AWS::CloudWatch::Alarm");
    expect(line(a, "AlarmName")).toContain("!Sub '${AWS::StackName}-memory'");
    expect(line(a, "Namespace")).toBe("      Namespace: CWAgent");
    expect(line(a, "MetricName")).toBe("      MetricName: mem_used_percent");
    expect(line(a, "Dimensions")).toBe("      Dimensions: [{ Name: InstanceId, Value: !Ref Instance }]");
    expect(line(a, "Statistic")).toBe("      Statistic: Maximum");
    expect(line(a, "Period")).toBe("      Period: 60");
    expect(line(a, "EvaluationPeriods")).toBe("      EvaluationPeriods: 5");
    expect(line(a, "DatapointsToAlarm")).toBe("      DatapointsToAlarm: 5");
    expect(line(a, "Threshold")).toBe("      Threshold: 80");
    expect(line(a, "ComparisonOperator")).toBe("      ComparisonOperator: GreaterThanOrEqualToThreshold");
    expect(line(a, "AlarmDescription")).toContain("stop the instance and start it again");
  });

  test("swap alarm: swap_used_percent >= 20 on every one of 3 minutes (the unit's 512M cap of the 2 GiB file)", () => {
    const a = alarm("SwapAlarm");
    expect(line(a, "AlarmName")).toContain("!Sub '${AWS::StackName}-swap'");
    expect(line(a, "Namespace")).toBe("      Namespace: CWAgent");
    expect(line(a, "MetricName")).toBe("      MetricName: swap_used_percent");
    expect(line(a, "Dimensions")).toBe("      Dimensions: [{ Name: InstanceId, Value: !Ref Instance }]");
    expect(line(a, "Statistic")).toBe("      Statistic: Maximum");
    expect(line(a, "Period")).toBe("      Period: 60");
    expect(line(a, "EvaluationPeriods")).toBe("      EvaluationPeriods: 3");
    expect(line(a, "Threshold")).toBe("      Threshold: 20");
  });

  test("read alarm: EC2's own EBSReadBytes over 15 GB per 5 minutes, 3 times in a row, so it fires without the agent", () => {
    const a = alarm("ReadThrashAlarm");
    expect(line(a, "AlarmName")).toContain("!Sub '${AWS::StackName}-disk-read'");
    expect(line(a, "Namespace")).toBe("      Namespace: AWS/EC2");
    expect(line(a, "MetricName")).toBe("      MetricName: EBSReadBytes");
    expect(line(a, "Dimensions")).toBe("      Dimensions: [{ Name: InstanceId, Value: !Ref Instance }]");
    expect(line(a, "Statistic")).toBe("      Statistic: Sum");
    expect(line(a, "Period")).toBe("      Period: 300");
    expect(line(a, "EvaluationPeriods")).toBe("      EvaluationPeriods: 3");
    expect(line(a, "DatapointsToAlarm")).toBe("      DatapointsToAlarm: 3");
    expect(line(a, "Threshold")).toBe("      Threshold: 15000000000");
  });

  test("missing data: a stopped instance or a silent agent is not an alarm; and an alarm does nothing but change state (no mail, no stop or reboot)", () => {
    for (const n of ["MemoryAlarm", "SwapAlarm", "ReadThrashAlarm"]) {
      const a = alarm(n);
      expect(line(a, "TreatMissingData")).toBe("      TreatMissingData: notBreaching");
      expect(a).not.toMatch(/ec2:(stop|reboot|terminate|recover)|OKActions|InsufficientDataActions/i);
    }
    // the host's alarms are watched, not mailed: no action of any kind (the Starter's own alarm mails, #1639)
    for (const n of ["MemoryAlarm", "SwapAlarm", "ReadThrashAlarm"]) expect(alarm(n)).not.toMatch(/AlarmActions/);
  });

  test("the launch template and UserData are untouched by this: the instance is not replaced by adding alarms", () => {
    expect(resource("LaunchTemplate")).not.toMatch(/cloudwatch|CWAgent|alarm/i);
    expect(resource("Instance")).not.toMatch(/cloudwatch|CWAgent|alarm/i);
  });

  test("host bedrock-mantle (#1731): InstanceRole and Boundary have only CreateInference, on the account's projects", () => {
    for (const name of ["InstanceRole", "Boundary"]) {
      const body = resource(name);
      expect([...body.matchAll(/bedrock-mantle:[A-Za-z*]+/g)].map((m) => m[0])).toEqual(["bedrock-mantle:CreateInference"]);
      expect(body).toContain("Resource: !Sub 'arn:aws:bedrock-mantle:${AWS::Region}:${AWS::AccountId}:project/*'");
    }
  });

  test("host bedrock (#1730): InstanceRole and Boundary invoke any model but have no other bedrock action", () => {
    const resources = [
      "arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:inference-profile/*",
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:::foundation-model/*",
    ];
    for (const name of ["InstanceRole", "Boundary"]) {
      const body = resource(name);
      expect([...body.matchAll(/(?<!aws:)bedrock:[A-Za-z*]+/g)].map((m) => m[0])).toEqual(["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
      // the statement's whole Resource list, to its last line
      const list = body.match(/Action: \[bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream\]\n( +)Resource:\n((?:\1  - .*\n)+)/)?.[2];
      expect(list).toBeDefined();
      const lines = list!.trim().split("\n").map((l) => l.replace(/^\s*- (!Sub )?'?|'?$/g, ""));
      expect(lines).toEqual(resources);
      expect(body).not.toMatch(/(?<!aws:)bedrock:(CreateApiKey|\*|Create|Put|Delete|List)/);
    }
    // no key of any kind is made by this stack for it
    expect(text).not.toMatch(/iam:CreateAccessKey|bedrock:CreateApiKey|AWS::IAM::AccessKey|AWS::IAM::User\b/);
  });

  test("the instance role reads cost and budgets, and changes neither (#2278)", () => {
    for (const name of ["InstanceRole", "Boundary"]) {
      const body = resource(name);
      expect([...body.matchAll(/(?<![\w:])(ce|budgets):[A-Za-z*]+/g)].map((m) => m[0])).toEqual(["ce:GetCostAndUsage", "ce:GetCostForecast", "budgets:ViewBudget"]);
      expect(body).toMatch(/Action: \[ce:GetCostAndUsage, ce:GetCostForecast\]\n +Resource: '\*'\n/);
      expect(body).toMatch(/Action: budgets:ViewBudget\n +Resource: !Sub 'arn:aws:budgets::\$\{AWS::AccountId\}:budget\/\*'\n/);
      expect(body).not.toMatch(/budgets:(Modify|Create|Delete|Update|\*)|ce:(Update|Create|Delete|Put|Tag|Untag|\*)/);
    }
  });

  test("cloudwatch permissions: PutMetricData for CWAgent only (host and boundary), and the deploy role names this stack's alarms", () => {
    const put = "Action: cloudwatch:PutMetricData";
    for (const name of ["InstanceRole", "Boundary"]) {
      const body = resource(name);
      const at = body.indexOf(put);
      expect(at).toBeGreaterThan(0);
      const st = body.slice(at, at + 260);
      expect(st).toContain("Resource: '*'");
      expect(st).toContain("Condition: { StringEquals: { 'cloudwatch:namespace': CWAgent } }");
      expect(body.split(put)).toHaveLength(2);
      expect(body).not.toMatch(/cloudwatch:\*|cloudwatch:(Get|List|Describe|Delete|Put(?!MetricData))/);
    }
    expect(resource("Boundary")).toContain("- Sid: AgentMetrics");
    const deploy = resource("DeployRole");
    expect(deploy).toContain("Action: [cloudwatch:PutMetricAlarm, cloudwatch:DeleteAlarms, cloudwatch:TagResource, cloudwatch:UntagResource, cloudwatch:ListTagsForResource]\n                Resource: !Sub 'arn:aws:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:${AWS::StackName}-*'");
    expect(deploy).toContain("Action: cloudwatch:DescribeAlarms\n                Resource: '*'");
    expect(deploy).not.toMatch(/cloudwatch:\*|sns:\*|PutMetricData/);
    // nothing else in the boundary changed: its statements are the ones before plus Countries (#1639), AgentMetrics and HostLogs (#1490), CostRead and BudgetRead (#2278), BedrockMantle (#1731)
    const sids = resource("Boundary").split("- Sid: ").slice(1).map((x) => x.split("\n")[0]);
    expect(sids).toEqual(["Parameters", "RegisterCode", "Buckets", "Wake", "ThisInstance", "RootReplacement", "Describe", "Stack", "Bedrock", "BedrockMantle", "CostRead", "BudgetRead", "OwnRoles", "Countries", "AgentMetrics", "OwnLogs", "HostLogs", "Offload", "HostAssumeRoles", "ManagedKeysThroughServices"]);
  });
});

describe("aws/template.yaml offload (#678)", () => {
  /** One statement of a policy: from its `- Effect:` / `- Sid:` line to the next one. */
  const statements = (body: string, sep: string) => body.split(sep).slice(1);
  const offloadArn = "!GetAtt Offload.Arn";
  const logsArn = "!GetAtt OffloadLogs.Arn";

  test("the offload project is arm, privileged, 60 minutes at most, 2 at a time, tagged Project, no VPC, no source", () => {
    const p = resource("Offload");
    expect(p).toContain("Type: AWS::CodeBuild::Project");
    expect(p).toContain("Name: !Sub '${AWS::StackName}-offload'");
    expect(p).toContain("Environment: { Type: ARM_CONTAINER, ComputeType: BUILD_GENERAL1_LARGE, Image: aws/codebuild/amazonlinux-aarch64-standard:3.0, PrivilegedMode: true }");
    expect(p).toContain("TimeoutInMinutes: 60\n");
    expect(p).toContain("QueuedTimeoutInMinutes: 15\n");
    expect(p).toContain("ConcurrentBuildLimit: 2\n");
    expect(p).toContain("Tags: [{ Key: Project, Value: !Ref CostTag }]");
    expect(p).toContain("ServiceRole: !GetAtt OffloadRole.Arn");
    expect(p).toContain("GroupName: !Ref OffloadLogs");
    expect(p).toContain("Artifacts: { Type: NO_ARTIFACTS }");
    expect(p).not.toMatch(/VpcConfig|Cache:|SecondarySources|FileSystemLocations/);
    // the buildspec is fixed here: the host only names the upload and the command, and the command's exit code is
    // the log's last `sb-offload: exit N` line (the build itself succeeds)
    expect(p).toContain("Type: NO_SOURCE");
    // the buildspec as CodeBuild reads it: every command a string (an unquoted `echo "a: b"` is a YAML map, review #684)
    const spec = p.slice(p.indexOf("BuildSpec: !Sub |\n") + "BuildSpec: !Sub |\n".length, p.indexOf("      Artifacts:"));
    const commands = (Bun.YAML.parse(spec.replace(/^ {10}/gm, "")) as { phases: { build: { commands: unknown[] } } }).phases.build.commands;
    expect(commands).toEqual([
      'mkdir -p /sb/work && cd /sb/work && aws s3 cp "s3://${Data}/$SB_OFFLOAD_KEY" - | tar -xzf -',
      // on a line of its own even when the command's output does not end in a newline (review #684)
      'cd /sb/work && sh -c "$SB_OFFLOAD_CMD"; c=$?; echo; echo "sb-offload: exit $c"',
    ]);
    const logs = resource("OffloadLogs");
    expect(logs).toContain("LogGroupName: !Sub '/aws/codebuild/${AWS::StackName}-offload'");
    expect(logs).toContain("RetentionInDays: 7");
    // the host finds the project here, not in UserData
    const param = resource("OffloadProject");
    expect(param).toContain("Name: /switchboard/offload-project");
    expect(param).toContain("Value: !Ref Offload");
  });

  test("the offload role carries the boundary and may only write its log group and read offload/", () => {
    const role = resource("OffloadRole");
    expect(role).toContain("RoleName: !Sub '${AWS::StackName}-offload'");
    expect(role).toContain("PermissionsBoundary: !Ref Boundary");
    expect(role).toContain("Principal: { Service: codebuild.amazonaws.com }");
    const allows = statements(role, "- Effect: ").map((st) => st.split("\n").slice(0, 3).join("\n"));
    expect(allows).toEqual([
      `Allow\n                Action: [logs:CreateLogStream, logs:PutLogEvents]\n                Resource: ${logsArn}`,
      "Allow\n                Action: s3:GetObject\n                Resource: !Sub '${Data.Arn}/offload/*'",
    ]);
    // the build gets no parameter, no secret and no other bucket path: only the upload it is told to unpack
    expect(role).not.toMatch(/ssm:|secretsmanager:|kms:|sts:AssumeRole\n|s3:PutObject|s3:\*/);
  });

  test("the instance role may start, watch and stop only the offload project, read only its logs and write only offload/; the boundary allows the same", () => {
    const role = resource("InstanceRole");
    expect(role).toContain(`Action: [codebuild:StartBuild, codebuild:BatchGetBuilds, codebuild:StopBuild]\n                Resource: ${offloadArn}`);
    expect(role).toContain(`Action: logs:GetLogEvents\n                Resource: ${logsArn}`);
    expect(role).toContain("Action: [s3:PutObject, s3:DeleteObject]\n                Resource: !Sub '${Data.Arn}/offload/*'");
    // nothing broader: no other CodeBuild action (no project edits, no role override), no other log group
    expect(role.match(/codebuild:/g)).toHaveLength(3);
    expect(role).not.toMatch(/codebuild:\*|iam:PassRole\n\s+Resource: !GetAtt OffloadRole|logs:\*/);
    const boundary = resource("Boundary");
    const offload = statements(boundary, "- Sid: ").find((st) => st.startsWith("Offload\n"));
    // by name: OffloadRole carries the boundary, so naming the project by !GetAtt would be a cycle
    expect(offload).toContain("Action: [codebuild:StartBuild, codebuild:BatchGetBuilds, codebuild:StopBuild, logs:GetLogEvents]\n            Resource:\n              - !Sub 'arn:aws:codebuild:${AWS::Region}:${AWS::AccountId}:project/${AWS::StackName}-offload'\n              - !Sub 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${AWS::StackName}-offload:*'");
    expect(offload).not.toContain("!GetAtt");
    // the S3 part is the boundary's Buckets (this stack's Data/*), and the offload role writes its logs under OwnLogs
    expect(boundary).toContain("Resource: [!GetAtt Data.Arn, !Sub '${Data.Arn}/*', !GetAtt StartPage.Arn, !Sub '${StartPage.Arn}/*']");
    expect(boundary).toContain("!Sub 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${AWS::StackName}-*'");
    // the deploy role may make and change this stack's projects and their log groups, nothing else of CodeBuild
    const deploy = resource("DeployRole");
    expect(deploy).toContain("Action: codebuild:*\n                Resource: !Sub 'arn:aws:codebuild:${AWS::Region}:${AWS::AccountId}:project/${AWS::StackName}-*'");
    expect(deploy).toContain("!Sub 'arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${AWS::StackName}-*'");
    // a stack updated through DeployRole keeps it as its role, so it may also make the project's parameter
    expect(deploy).toContain("- !Sub 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/switchboard/offload-project'");
  });

  test("offload/ expires after a day; the launch template and UserData are untouched", () => {
    expect(resource("Data")).toContain("- { Id: offload, Status: Enabled, Prefix: offload/, ExpirationInDays: 1, NoncurrentVersionExpiration: { NoncurrentDays: 1 } }");
    // a change to UserData replaces the instance (and its VPC origins): the project name is read from Parameter Store
    expect(resource("LaunchTemplate")).not.toMatch(/offload|Offload|codebuild/i);
    expect(resource("Instance")).not.toMatch(/offload/i);
  });
});

const waf = await Bun.file(new URL("./waf.yaml", import.meta.url)).text();

describe("aws/template.yaml emergency switches (#1492)", () => {
  const param = (name: string) => text.slice(text.indexOf(`\n  ${name}:\n`) + 1).split(/\n {2}[A-Za-z]/)[0]!;

  test("both parameters default to empty, and CloudFront's Restrictions / WebACLId vanish when they are", () => {
    expect(param("AllowedCountries")).toContain("Type: CommaDelimitedList");
    expect(param("AllowedCountries")).toContain("Default: ''");
    expect(param("WebAclArn")).toContain("Default: ''");
    expect(param("WebAclArn")).toContain("^$|^arn:aws:wafv2:us-east-1:");
    expect(text).toContain("HasGeo: !Not [!Equals [!Join ['', !Ref AllowedCountries], '']]");
    const cdn = resource("Cdn");
    expect(cdn).toContain("Restrictions: !If [HasGeo, { GeoRestriction: { RestrictionType: whitelist, Locations: !Ref AllowedCountries } }, !Ref 'AWS::NoValue']");
    expect(cdn).toContain("WebACLId: !If [HasWebAcl, !Ref WebAclArn, !Ref 'AWS::NoValue']");
  });

  test("only the distribution carries them: the instance is not replaced by this", () => {
    expect(text.match(/Restrictions:|WebACLId:/g)?.length).toBe(2);
    expect(resource("LaunchTemplate")).not.toMatch(/Restrictions|WebACL|AllowedCountries/);
    expect(resource("Instance")).not.toMatch(/Restrictions|WebACL|AllowedCountries/);
  });

  test("waf.yaml: a CloudFront-scoped Web ACL that allows by default and rate-limits per IP, the login's path separately", () => {
    expect(waf).toContain("Scope: CLOUDFRONT");
    expect(waf).toContain("DefaultAction: { Allow: {} }");
    expect(waf.match(/RateBasedStatement/g)?.length).toBe(2);
    expect(waf.match(/AggregateKeyType: IP/g)?.length).toBe(2);
    const auth = waf.slice(waf.indexOf("- Name: auth-rate"), waf.indexOf("- Name: all-rate"));
    expect(auth).toContain("SearchString: /_auth/");
    expect(auth).toContain("PositionalConstraint: STARTS_WITH");
    expect(waf.slice(waf.indexOf("- Name: all-rate"))).not.toContain("ScopeDownStatement");
    // limits, windows and the block action are what the emergency switch promises
    expect(auth).toContain("Action: { Block: {} }");
    expect(auth).toContain("Limit: 100");
    expect(auth).toContain("EvaluationWindowSec: 300");
    const all = waf.slice(waf.indexOf("- Name: all-rate"));
    expect(all).toContain("Action: { Block: {} }");
    expect(all).toContain("Limit: 2000, EvaluationWindowSec: 300");
    // the sampled requests keep no login cookie
    expect(waf).toContain("DataProtectionConfig:");
    expect(waf).toContain("FieldKeys: [cookie]");
    expect(waf).toContain("FieldType: SINGLE_HEADER");
    expect(waf).toContain("Action: SUBSTITUTION");
  });

  test("the deploy role may read a Web ACL of this account in us-east-1 only, and WebAclArn is checked by pattern", () => {
    const role = resource("DeployRole");
    expect(role).toContain("Action: wafv2:GetWebACL");
    expect(role).toContain("arn:aws:wafv2:us-east-1:${AWS::AccountId}:global/webacl/*");
    expect(text).toContain("HasWebAcl: !Not [!Equals [!Ref WebAclArn, '']]");
  });
});

describe("aws/template.yaml temporary countries (#1639)", () => {
  test("the Starter ticks every 5 minutes and knows the base countries", () => {
    const starter = resource("Starter");
    expect(starter).toContain("SB_ALLOWED_COUNTRIES: !Join [',', !Ref AllowedCountries]");
    expect(starter).toContain("Schedule: rate(5 minutes)");
    expect(starter).toContain("parameter/switchboard/distribution-id");
    expect(starter).toContain("${Data.Arn}/auth/countries.json");
  });

  test("only the Starter's role may change the geo restriction, on this distribution only", () => {
    const policy = resource("StarterCountriesPolicy");
    expect(policy).toContain("Roles: [!Ref StarterRole]");
    expect([...policy.matchAll(/cloudfront:[A-Za-z]+/g)].map((m) => m[0])).toEqual(["cloudfront:GetDistributionConfig", "cloudfront:UpdateDistribution"]);
    expect(policy).toContain("distribution/${Cdn}'");
    expect(policy).not.toContain("distribution/*");
    // nothing on the host can loosen the entrance (#701)
    expect(resource("InstanceRole")).not.toContain("cloudfront:");
    expect(resource("DistributionIdParam")).toContain("Value: !Ref Cdn");
  });

  test("the boundary allows it (without naming the distribution: that would be a cycle) and the DeployRole can place it", () => {
    const boundary = resource("Boundary");
    expect(boundary).toContain("Sid: Countries");
    expect(boundary).toContain("Action: [cloudfront:GetDistributionConfig, cloudfront:UpdateDistribution]");
    expect(boundary).not.toContain("${Cdn}");
    const deploy = resource("DeployRole");
    expect(deploy).toContain("parameter/switchboard/distribution-id");
    expect(deploy).toContain("events:PutRule");
    expect(deploy).toContain("rule/${AWS::StackName}-*");
  });

  test("a failing Starter mails: three 5-minute windows with errors, to the budget address", () => {
    const a = resource("StarterErrorsAlarm").split("\nOutputs:")[0]!;
    for (const l of ["Namespace: AWS/Lambda", "MetricName: Errors", "Dimensions: [{ Name: FunctionName, Value: !Ref Starter }]", "Statistic: Sum", "Period: 300", "EvaluationPeriods: 3", "DatapointsToAlarm: 3", "Threshold: 1", "AlarmActions: [!Ref StarterAlarmTopic]"]) expect(a).toContain(l);
    expect(resource("StarterAlarmTopic")).toContain("Subscription: [{ Protocol: email, Endpoint: !Ref BudgetEmail }]");
    const deploy = resource("DeployRole");
    expect(deploy).toContain("sns:CreateTopic");
    expect(deploy).toContain("sns:ListTagsForResource"); // CloudFormation reads the topic back
    expect(deploy).toContain("arn:aws:sns:${AWS::Region}:${AWS::AccountId}:${AWS::StackName}-*");
    expect(deploy).not.toMatch(/sns:\*/);
  });
});
