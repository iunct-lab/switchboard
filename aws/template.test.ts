// test-reads: aws/template.yaml aws/waf.yaml aws/host/
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

/**
 * aws/template.yaml read as text: CloudFormation's short tags (!Ref, !Sub …) are not plain YAML, and
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

/** One VPC origin inside the `Fn::ForEach::Edge` loop: from its `<name>${Gen}:` key to the next key at that indent. */
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

describe("aws/template.yaml", () => {
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
    // on-demand by default; Spot only when Market says so, and then it stops (not terminates) on interruption
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
    // only this project's resources: another project may share the account
    for (const b of ["BudgetLow", "BudgetHigh"]) expect(resource(b)).toContain("CostFilters: { TagKeyValue: [!Join ['', ['user:Project$', !Ref CostTag]]] }");
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
    // with the prefix only the id-pinned subject; without it only the name (never both)
    expect(oidc).toContain("- ImmutableSub\n                  - !Sub '${GitHubSubPrefix}:ref:refs/heads/main'\n                  - !Sub 'repo:${GitHubRepo}:ref:refs/heads/main'");
    expect(text).toContain("AllowedPattern: '(repo:[A-Za-z0-9_.-]+@[0-9]+/[A-Za-z0-9_.-]+@[0-9]+)?'");
    expect(oidc).toContain("'token.actions.githubusercontent.com:aud': sts.amazonaws.com");
  });

  test("the OIDC role makes or updates a change set only naming DeployRole, so it cannot use a role attached to the stack", () => {
    const oidc = resource("GitHubOidcRole");
    const statements = oidc.split("- Effect: Allow").slice(1);
    const writes = statements.filter((st) => /cloudformation:(CreateChangeSet|UpdateStack)\b/.test(st) && st.includes(":stack/${AWS::StackName}/*"));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("Action: [cloudformation:CreateChangeSet, cloudformation:UpdateStack]");
    expect(writes[0]).toContain("Condition: { StringEquals: { 'cloudformation:RoleArn': !GetAtt DeployRole.Arn } }");
    // nothing else in the role makes or updates a stack, or deletes one
    expect(oidc.match(/cloudformation:(CreateChangeSet|UpdateStack|CreateStack|DeleteStack)\b/g)).toEqual(["cloudformation:CreateChangeSet", "cloudformation:UpdateStack", "cloudformation:CreateChangeSet"]);
    expect(oidc).toContain("Action: cloudformation:CreateChangeSet\n                Resource: [!Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/");
  });

  test("CloudFront sends the shared header to the host, and a stopped host is answered by the start page", () => {
    const cdn = resource("Cdn");
    expect(cdn.match(/HeaderName: x-switchboard-edge, HeaderValue: !Ref EdgeHeaderValue/g)).toHaveLength(3); // host, rescue, auth
    expect(cdn).toContain("ResponsePagePath: /_start/index.html");
    expect(text).toMatch(/EdgeHeaderValue:\n {4}Type: String\n {4}NoEcho: true/);
  });

  test("CloudFront reaches the instance as a VPC origin by id, never its public address in plain text", () => {
    const cdn = resource("Cdn");
    expect(cdn).not.toContain("PublicDnsName");
    // the only custom origin is the Starter's Function URL, over https only
    expect(cdn.match(/CustomOriginConfig: \{[^}]*\}/g)).toEqual(["CustomOriginConfig: { OriginProtocolPolicy: https-only, OriginSSLProtocols: [TLSv1.2] }"]);
    expect(cdn.match(/VpcOriginConfig: \{ VpcOriginId: !GetAtt \[!Sub '(Host|Rescue)VpcOrigin\$\{LaunchGeneration\}', Id\]/g)).toHaveLength(2);
    expect(cdn.match(/ConnectionAttempts: 1/g)).toHaveLength(2); // a stopped host falls through to the start page quickly
    for (const o of ["HostVpcOrigin", "RescueVpcOrigin"]) {
      const r = edgeOrigin(o);
      expect(r).toContain("Arn: !Sub 'arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Instance}'");
      expect(r).not.toContain("InstanceGeneration"); // an origin in use cannot be replaced by a rename
    }
    expect(resource("InstanceRole")).not.toContain("cloudfront:"); // nothing on the host rewrites the distribution (only the Starter does)
  });

  test("VPC origins take their logical ids from LaunchGeneration, so a launch template change creates new ones", () => {
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

  test("the Spot request is persistent (stop on interruption); nothing automatic terminates the instance or cancels the request", () => {
    expect(resource("LaunchTemplate")).toContain("SpotInstanceType: persistent");
    expect(text).not.toContain("InstanceGeneration");
    expect(text).not.toContain("ec2:CancelSpotInstanceRequests");
  });

  test("作り直す is a root volume replacement: the Starter may start, stop and replace the root of its one instance, and nothing else", () => {
    const starter = resource("Starter");
    expect(starter).toContain("Action: [ec2:StartInstances, ec2:StopInstances, ec2:CreateReplaceRootVolumeTask]\n              Resource: !Sub 'arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Instance}'");
    for (const gone of ["cloudformation:", "iam:PassRole", "DeployRole", "SB_STACK_NAME", "ec2:TerminateInstances", "ec2:RebootInstances"]) expect(starter).not.toContain(gone);
    expect(resource("Boundary")).toContain("Action: [ec2:StartInstances, ec2:StopInstances, ec2:CreateReplaceRootVolumeTask]");
  });

  test("the boundary names this stack's resources; '*' only for Describe, ECR's GetAuthorizationToken (no resource level) and for KMS through SSM / EC2", () => {
    const boundary = resource("Boundary");
    for (const st of boundary.split("- Sid: ").slice(1)) {
      if (!st.includes("Resource: '*'")) continue;
      const sid = st.split("\n")[0];
      expect(["Describe", "ManagedKeysThroughServices", "AgentMetrics", "CostRead", "EcrAuthToken"]).toContain(sid);
      if (sid === "ManagedKeysThroughServices") expect(st).toContain("kms:ViaService");
      if (sid === "AgentMetrics") expect(st).toContain("'cloudwatch:namespace': CWAgent");
    }
    expect(boundary).toContain("Resource: !Sub 'arn:aws:iam::${AWS::AccountId}:role/${AWS::StackName}-*'");
    expect(boundary).toContain("'aws:ResourceTag/aws:cloudformation:stack-name': !Ref AWS::StackName");
    const deploy = resource("DeployRole");
    expect(deploy).not.toMatch(/Effect: Allow[^-]*iam:UpdateAssumeRolePolicy/);
    expect(deploy).toContain("StringNotEquals: { 'aws:ResourceTag/aws:cloudformation:stack-name': !Ref AWS::StackName }");
  });

  test("the instance role writes only the replica and the archives; releases are read-only", () => {
    const role = resource("InstanceRole");
    expect(role).toContain("Action: [s3:GetObject, s3:PutObject, s3:DeleteObject]\n                Resource: [!Sub '${Data.Arn}/litestream/*', !Sub '${Data.Arn}/archive/*']");
    expect(role).not.toContain("Resource: !Sub '${Data.Arn}/*'");
    expect(role).not.toContain("host/");
  });

  test("the host role can put and get under history/ but not delete, and history/ has no expiration", () => {
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

  test("request logs: CloudFront's standard log goes to Data's cdn-logs/ for 90 days or more, without cookies, and the host sees the viewer address", () => {
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

  test("the daemon's log group keeps 90 days or more; the host role may only write to it — no delete, no retention change; nothing reads cdn-logs/", () => {
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

  test("every role but DeployRole carries the boundary; DeployRole makes roles only with it and never changes it", () => {
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

  test("the host may invoke only the DAK function named by DakFunctionArn", () => {
    expect(text).toContain("  DakFunctionArn:\n    Type: String\n    Default: ''");
    expect(text).toMatch(/DakFunctionArn:[^]*?AllowedPattern: '\^\$\|\^arn:aws:lambda:/);
    expect(text).toContain("  HasDakFunction: !Not [!Equals [!Ref DakFunctionArn, '']]");
    for (const name of ["Boundary", "InstanceRole"]) {
      const block = resource(name);
      expect(block).toMatch(/- !If\n +\- HasDakFunction\n +\- (Sid: DakFunction\n +)?Effect: Allow\n +Action: \[lambda:InvokeFunction, lambda:GetFunction\]\n +Resource: !Ref DakFunctionArn\n +\- !Ref AWS::NoValue/);
      // the only lambda statement, and it names no function by pattern
      expect(block.match(/lambda:/g)).toHaveLength(2);
      expect(block.match(/Resource: .*DakFunctionArn.*/g)!.every((l) => !l.includes("*"))).toBe(true);
    }
  });

  test("UpdateStack on the SAM template may create the transforms' change set", () => {
    expect(resource("GitHubOidcRole")).toContain("Resource: [!Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/Serverless-2016-10-31', !Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/LanguageExtensions']");
    // Describe has no resource-level permissions: never behind a tag condition
    expect(resource("GitHubOidcRole")).toMatch(/Action: ec2:DescribeInstances\n {16}Resource: '\*'\n(?! {16}Condition)/);
  });

  test("DeployRole may create the transforms' change set and nothing else in CloudFormation", () => {
    const deploy = resource("DeployRole");
    expect(deploy).toContain("- Effect: Allow\n                Action: cloudformation:CreateChangeSet\n                Resource: [!Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/Serverless-2016-10-31', !Sub 'arn:aws:cloudformation:${AWS::Region}:aws:transform/LanguageExtensions']");
    // every action, wildcards too; not the condition keys or ARNs (aws:cloudformation:…)
    expect([...deploy.matchAll(/(?<!aws:)cloudformation:[^\s,\]']+/g)].map((m) => m[0])).toEqual(["cloudformation:CreateChangeSet"]);
  });

  test("the host scripts come from the repository, so the first boot needs no upload", () => {
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

  test("passkey login: /_auth* goes to the Starter uncached, with the shared header and without the viewer's Host", () => {
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
    // its own Host stays (not forwarded); CloudFront-Viewer-Address goes, for the per-viewer rate limit
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

  test("the rescue page's outside URL: /switchboard/web-url is the distribution's https origin, readable by the instance", () => {
    const param = resource("WebUrlParam");
    expect(param).toContain("Name: /switchboard/web-url");
    expect(param).toContain("Value: !Sub 'https://${Cdn.DomainName}'");
    expect(hostParams().has("web-url")).toBe(true);
  });

  test("the host role cannot read the cookie signing key; the Starter can", () => {
    expect(hostParams().has("session-signing-key")).toBe(false);
    expect(hostParams().has("*")).toBe(false);
    expect(resource("InstanceRole")).not.toContain("parameter/switchboard/session-signing-key");
    expect(resource("Starter")).toContain("parameter/switchboard/session-signing-key'");
    // the host reads the public key, and no longer the old HMAC key the Starter used to sign with
    expect(hostParams().has("session-public-key")).toBe(true);
    expect(hostParams().has("session-key")).toBe(false);
  });

  test("the instance role's SSM reads are a list of names, without register-code", () => {
    expect(hostParams().has("*")).toBe(false);
    expect(hostParams().has("register-code")).toBe(false);
  });

  /** The names the host's scripts read: the LaunchTemplate's UserData (github-token) and aws/host/. */
  async function scriptParams(): Promise<Set<string>> {
    const dir = new URL("./host/", import.meta.url);
    const texts = [resource("LaunchTemplate")];
    // cloudwatch-agent.json names a log group (/switchboard/host), not a parameter
    for (const f of new Bun.Glob("*").scanSync(fileURLToPath(dir))) if (!f.endsWith(".test.ts") && f !== "cloudwatch-agent.json") texts.push(await Bun.file(new URL(f, dir)).text());
    return new Set(texts.flatMap((t) => [...t.matchAll(/\/switchboard\/([a-z0-9-]+)/g)].map((m) => m[1]!)));
  }

  /** Read on the host by a program outside this repository (DAK's agent/ssm_exec.py), not by a script here. */
  const EXTERNAL_PARAMS = ["anthropic-api-key"];
  /** Read by the daemon itself (packages/core/src/s3.ts), not by a host script; it is here so that UserData does not change. */
  const DAEMON_PARAMS = ["uplink-bucket"];

  test("the names the host's scripts read + the one DAK reads = the instance role's SSM resources", async () => {
    const read = await scriptParams();
    for (const p of EXTERNAL_PARAMS) expect(read.has(p)).toBe(false); // it is DAK's, not a script's: the list below is the only place it is named
    expect([...read, ...EXTERNAL_PARAMS, ...DAEMON_PARAMS].sort()).toEqual([...hostParams()].sort());
  });

  test("the host permits only the named Anthropic parameter in addition to existing script parameters", async () => {
    const scripts = await scriptParams();
    const extra = [...hostParams()].filter((p) => !scripts.has(p));
    expect(extra).toEqual(["anthropic-api-key", ...DAEMON_PARAMS]);
    for (const p of ["*", "register-code", "session-signing-key"]) expect(hostParams().has(p)).toBe(false);
    // hostParams() reads exact names only: look at the statement's text for a pattern (anthropic-*, sw*) that it would skip
    expect(hostSsmStatement()).not.toMatch(/parameter\/switchboard\/[^'\n]*[*?]/);
    expect(resource("InstanceRole")).toContain("parameter/switchboard/anthropic-api-key'");
    // the key is DAK's alone: neither the Starter nor the deploy role reads it, and nothing here writes it
    for (const r of ["Starter", "DeployRole", "GitHubOidcRole", "SchedulerRole"]) expect(resource(r)).not.toContain("anthropic-api-key");
  });
});

describe("aws/template.yaml memory alarms", () => {
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
    // the host's alarms are watched, not mailed: no action of any kind (the Starter's own alarm mails)
    for (const n of ["MemoryAlarm", "SwapAlarm", "ReadThrashAlarm"]) expect(alarm(n)).not.toMatch(/AlarmActions/);
  });

  test("the launch template and UserData are untouched by this: the instance is not replaced by adding alarms", () => {
    expect(resource("LaunchTemplate")).not.toMatch(/cloudwatch|CWAgent|alarm/i);
    expect(resource("Instance")).not.toMatch(/cloudwatch|CWAgent|alarm/i);
  });

  test("host bedrock-mantle: InstanceRole and Boundary have only CreateInference, on the account's projects in any region", () => {
    for (const name of ["InstanceRole", "Boundary"]) {
      const body = resource(name);
      expect([...body.matchAll(/(?<!aws:)bedrock-mantle:[A-Za-z*]+/g)].map((m) => m[0])).toEqual(["bedrock-mantle:CreateInference"]);
      expect(body).toContain("Resource: !Sub 'arn:aws:bedrock-mantle:*:${AWS::AccountId}:project/*'");
    }
  });

  test("host bedrock: InstanceRole and Boundary invoke any model but have no other bedrock action", () => {
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

  test("the instance role reads cost and budgets, and changes neither", () => {
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
    // nothing else in the boundary changed: its statements are the ones before plus OffloadImage and EcrAuthToken, OffloadCi, Countries, AgentMetrics and HostLogs, CostRead and BudgetRead, BedrockMantle
    const sids = resource("Boundary").split("- Sid: ").slice(1).map((x) => x.split("\n")[0]);
    expect(sids).toEqual(["Parameters", "RegisterCode", "Buckets", "UplinkBucket", "Wake", "ThisInstance", "RootReplacement", "Describe", "Stack", "Bedrock", "BedrockMantle", "CostRead", "BudgetRead", "OwnRoles", "Countries", "AgentMetrics", "OwnLogs", "HostLogs", "Offload", "OffloadImage", "OffloadCi", "EcrAuthToken", "HostAssumeRoles", "DakFunction", "ManagedKeysThroughServices"]);
  });
});

describe("aws/template.yaml offload", () => {
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
    // the buildspec as CodeBuild reads it: every command a string (an unquoted `echo "a: b"` is a YAML map)
    const spec = p.slice(p.indexOf("BuildSpec: !Sub |\n") + "BuildSpec: !Sub |\n".length, p.indexOf("      Artifacts:"));
    const commands = (Bun.YAML.parse(spec.replace(/^ {10}/gm, "")) as { phases: { build: { commands: unknown[] } } }).phases.build.commands;
    expect(commands).toEqual([
      'mkdir -p /sb/work && cd /sb/work && aws s3 cp "s3://${Data}/$SB_OFFLOAD_KEY" - | tar -xzf -',
      // on a line of its own even when the command's output does not end in a newline
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
    expect(role.match(/codebuild:/g)).toHaveLength(9); // the offload project's 3, the image project's 3 and the CI project's 3
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

describe("aws/template.yaml emergency switches", () => {
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

describe("aws/template.yaml temporary countries", () => {
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
    // nothing on the host can loosen the entrance
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

describe("aws/template.yaml offload image", () => {
  const statements = (body: string, sep: string) => body.split(sep).slice(1);

  test("the repository keeps the newest 2 images, scans on push and is tagged Project", () => {
    const repo = resource("OffloadImageRepo");
    expect(repo).toContain("Type: AWS::ECR::Repository");
    expect(repo).toContain("RepositoryName: !Sub '${AWS::StackName}-offload-image'");
    expect(repo).toContain("ImageScanningConfiguration: { ScanOnPush: true }");
    expect(repo).toContain("Tags: [{ Key: Project, Value: !Ref CostTag }]");
    const lifecycle = JSON.parse(repo.match(/LifecyclePolicyText: '(.*)'/)![1]!);
    expect(lifecycle.rules).toEqual([
      { rulePriority: 1, description: "keep the newest 2 images", selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 2 }, action: { type: "expire" } },
    ]);
  });

  test("the project builds the ci stage of one tag, arm and privileged, in no VPC", () => {
    const p = resource("OffloadImage");
    expect(p).toContain("Name: !Sub '${AWS::StackName}-offload-image'");
    expect(p).toContain("ServiceRole: !GetAtt OffloadImageRole.Arn");
    expect(p).toContain("Environment: { Type: ARM_CONTAINER, ComputeType: BUILD_GENERAL1_SMALL, Image: aws/codebuild/amazonlinux-aarch64-standard:3.0, PrivilegedMode: true }");
    expect(p).toContain("GroupName: !Ref OffloadImageLogs");
    expect(p).toContain("Type: NO_SOURCE");
    expect(p).not.toMatch(/VpcConfig|Cache:|SecondarySources|FileSystemLocations/);
    const spec = p.slice(p.indexOf("BuildSpec: !Sub |\n") + "BuildSpec: !Sub |\n".length, p.indexOf("      Artifacts:"));
    const commands = (Bun.YAML.parse(spec.replace(/^ {10}/gm, "")) as { phases: { build: { commands: unknown[] } } }).phases.build.commands;
    expect(commands).toEqual([
      'mkdir -p /sb/work && cd /sb/work && aws s3 cp "s3://${Data}/$SB_OFFLOAD_KEY" - | tar -xzf -',
      'aws ecr get-login-password | docker login --username AWS --password-stdin ${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com',
      "cd /sb/work && docker build --target ci -f container/Dockerfile -t ${OffloadImageRepo.RepositoryUri}:$SB_IMAGE_TAG .",
      "docker push ${OffloadImageRepo.RepositoryUri}:$SB_IMAGE_TAG",
      'echo "sb-offload: image $SB_IMAGE_TAG"',
    ]);
    expect(resource("OffloadImageLogs")).toContain("LogGroupName: !Sub '/aws/codebuild/${AWS::StackName}-offload-image'");
    expect(resource("OffloadImageProject")).toContain("Name: /switchboard/offload-image-project");
    expect(resource("OffloadImageProject")).toContain("Value: !Ref OffloadImage");
    expect(resource("OffloadImageRepoUri")).toContain("Name: /switchboard/offload-image-repo");
    expect(resource("OffloadImageRepoUri")).toContain("Value: !GetAtt OffloadImageRepo.RepositoryUri");
  });

  test("the build role carries the boundary and may push only to this repository", () => {
    const role = resource("OffloadImageRole");
    expect(role).toContain("PermissionsBoundary: !Ref Boundary");
    const allows = statements(role, "- Effect: ").map((st) => st.split("\n").slice(0, 3).join("\n"));
    expect(allows).toEqual([
      "Allow\n                Action: [logs:CreateLogStream, logs:PutLogEvents]\n                Resource: !GetAtt OffloadImageLogs.Arn",
      "Allow\n                Action: s3:GetObject\n                Resource: !Sub '${Data.Arn}/offload/*'",
      "Allow\n                Action: ecr:GetAuthorizationToken\n                Resource: '*'",
      "Allow\n                Action: [ecr:BatchCheckLayerAvailability, ecr:InitiateLayerUpload, ecr:UploadLayerPart, ecr:CompleteLayerUpload, ecr:PutImage, ecr:BatchGetImage, ecr:GetDownloadUrlForLayer]\n                Resource: !GetAtt OffloadImageRepo.Arn",
    ]);
    expect(role).not.toMatch(/ssm:|secretsmanager:|kms:|s3:PutObject|s3:\*|ecr:\*/);
  });

  test("the instance role starts the image project, reads its log and describes only this repository; the boundary names them, not by !GetAtt", () => {
    const role = resource("InstanceRole");
    expect(role).toContain("Action: [codebuild:StartBuild, codebuild:BatchGetBuilds, codebuild:StopBuild]\n                Resource: !GetAtt OffloadImage.Arn");
    expect(role).toContain("Action: logs:GetLogEvents\n                Resource: !GetAtt OffloadImageLogs.Arn");
    expect(role).toContain("Action: ecr:DescribeImages\n                Resource: !GetAtt OffloadImageRepo.Arn");
    expect(role.match(/ecr:/g)).toHaveLength(1);
    // the host reads the two parameters (sb-offload --ci; the list is the scripts' names)
    expect(role).toContain("parameter/switchboard/offload-image-project'");
    expect(role).toContain("parameter/switchboard/offload-image-repo'");
    const boundary = resource("Boundary");
    const image = statements(boundary, "- Sid: ").find((st) => st.startsWith("OffloadImage\n"));
    expect(image).toContain("project/${AWS::StackName}-offload-image'");
    expect(image).toContain("log-group:/aws/codebuild/${AWS::StackName}-offload-image:*'");
    expect(image).toContain("repository/${AWS::StackName}-offload-image'");
    expect(image).not.toContain("!GetAtt");
    expect(image).not.toMatch(/ecr:\*|ecr:Delete|ecr:Set/);
    const token = statements(boundary, "- Sid: ").find((st) => st.startsWith("EcrAuthToken\n"));
    expect(token).toContain("Action: ecr:GetAuthorizationToken\n            Resource: '*'");
    const deploy = resource("DeployRole");
    expect(deploy).toContain("Action: ecr:*\n                Resource: !Sub 'arn:aws:ecr:${AWS::Region}:${AWS::AccountId}:repository/${AWS::StackName}-*'");
    expect(deploy).toContain("parameter/switchboard/offload-image-project'");
    expect(deploy).toContain("parameter/switchboard/offload-image-repo'");
  });
});

describe("aws/template.yaml offload CI", () => {
  const statements = (body: string, sep: string) => body.split(sep).slice(1);

  test("the project runs the work tree in the ECR image with the service role, as Offload, and logs the tag first", () => {
    const p = resource("OffloadCi");
    expect(p).toContain("Name: !Sub '${AWS::StackName}-offload-ci'");
    expect(p).toContain("ServiceRole: !GetAtt OffloadCiRole.Arn");
    expect(p).toContain("Environment: { Type: ARM_CONTAINER, ComputeType: BUILD_GENERAL1_LARGE, Image: !Sub '${OffloadImageRepo.RepositoryUri}:latest', ImagePullCredentialsType: SERVICE_ROLE, PrivilegedMode: true }");
    expect(p).toContain("ConcurrentBuildLimit: 2");
    expect(p).toContain("TimeoutInMinutes: 60");
    expect(p).toContain("GroupName: !Ref OffloadCiLogs");
    expect(p).not.toMatch(/VpcConfig|Cache:|SecondarySources|FileSystemLocations/);
    const commands = (spec: string) => (Bun.YAML.parse(spec.replace(/^ {10}/gm, "")) as { phases: { build: { commands: unknown[] } } }).phases.build.commands;
    const body = (r: string) => r.slice(r.indexOf("BuildSpec: !Sub |\n") + "BuildSpec: !Sub |\n".length, r.indexOf("      Artifacts:"));
    // the unpack and the run are Offload's, word for word; only the tag line comes first
    const ci = commands(body(p)) as string[];
    const offload = commands(body(resource("Offload"))) as string[];
    // the recordings, the names and the compared tag's tree come between the unpack and the run
    expect([ci[0], ci[1], ci[ci.length - 1]]).toEqual(['echo "sb-offload: image $SB_IMAGE_TAG"', offload[0], offload[1]]);
    expect(ci).toHaveLength(6);
    expect(resource("OffloadCiLogs")).toContain("LogGroupName: !Sub '/aws/codebuild/${AWS::StackName}-offload-ci'");
    expect(resource("OffloadCiProject")).toContain("Name: /switchboard/offload-ci-project");
    expect(resource("OffloadCiProject")).toContain("Value: !Ref OffloadCi");
    // Offload keeps its standard image (it has docker running)
    expect(resource("Offload")).toContain("Image: aws/codebuild/amazonlinux-aarch64-standard:3.0");
  });

  test("the build role carries the boundary and may only pull from this repository", () => {
    const role = resource("OffloadCiRole");
    expect(role).toContain("PermissionsBoundary: !Ref Boundary");
    const allows = statements(role, "- Effect: ").map((st) => st.split("\n").slice(0, 3).join("\n"));
    expect(allows).toEqual([
      "Allow\n                Action: [logs:CreateLogStream, logs:PutLogEvents]\n                Resource: !GetAtt OffloadCiLogs.Arn",
      "Allow\n                Action: s3:GetObject\n                Resource: !Sub '${Data.Arn}/offload/*'",
      "Allow\n                Action: ecr:GetAuthorizationToken\n                Resource: '*'",
      "Allow\n                Action: [ecr:BatchCheckLayerAvailability, ecr:BatchGetImage, ecr:GetDownloadUrlForLayer]\n                Resource: !GetAtt OffloadImageRepo.Arn",
    ]);
    expect(role).not.toMatch(/ssm:|secretsmanager:|kms:|s3:PutObject|s3:\*|ecr:\*|ecr:Put|ecr:Upload/);
  });

  test("the recordings and the names are read from the one-time objects, read-only, and no value or token reaches the build", () => {
    const role = resource("OffloadCiRole");
    // the ci build can read offload/* and write its log, nothing else: no put, no delete, no parameter, no secret
    expect(role).not.toMatch(/s3:Put|s3:Delete|s3:Abort|ssm:|secretsmanager:|logs:\*/);
    expect(statements(role, "- Effect: ").filter((st) => /s3:/.test(st)).map((st) => st.split("\n").slice(1, 3).join("\n"))).toEqual(["                Action: s3:GetObject\n                Resource: !Sub '${Data.Arn}/offload/*'"]);
    const p = resource("OffloadCi");
    expect(p).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|[Tt]oken|EnvironmentVariables|SecretsManager|ParameterStore|SECRETS_MANAGER/);
    const spec = p.slice(p.indexOf("BuildSpec: !Sub |\n"), p.indexOf("      Artifacts:"));
    // the recordings are unpacked from their object into the CI user's folder, and never copied back
    expect(spec).toContain('if [ -n "$SB_OFFLOAD_FIXTURES" ]');
    expect(spec).toContain(".fixtures.tar.gz\" - | tar -xzf - -C \"$D\"");
    expect(spec).toContain("D=/home/switchboard/.switchboard/fixtures");
    expect(spec).not.toMatch(/s3 (mv|rm|sync)|s3 cp [^\n]* s3:/);
    // the names become ~/.aws/config without echoing a value: set +x, 600, the JSON deleted once read
    expect(spec).toContain('if [ -n "$SB_OFFLOAD_NAMES" ]');
    expect(spec).toContain("set +x");
    expect(spec).toContain("rm -f /sb/names.json");
    // a names file that cannot be read stops the build with a fixed line, not bun's message (it can quote the JSON)
    expect(spec).toMatch(/names\.json --only-show-errors \\\s+&& \( umask 077;[\s\S]*\) >\/dev\/null 2>&1 \\\s+\|\| \{ rm -f \/sb\/names\.json; echo "sb-offload: the names for the public-tree check could not be read"; exit 1; \}/);
    // the compared tag's tree: read from the same prefix, unpacked into a folder, PERF_BASE_TREE points there; the key is the only thing passed
    expect(spec).toContain('if [ -n "$SWITCHBOARD_BASE_TREE_KEY" ]');
    expect(spec).toContain('aws s3 cp "s3://${Data}/$SWITCHBOARD_BASE_TREE_KEY" - | tar -xf - -C "$B"');
    expect(spec).toContain('export PERF_BASE_TREE="$B"');
    // a tree that cannot be read does not stop the build: perf only warns, so the run goes on uncompared and says so
    expect(spec).toContain('export PERF_BASE_TREE="$B" || echo "sb-offload: base tree not unpacked; perf is not compared with it"; fi');
    expect(spec.slice(spec.indexOf("SWITCHBOARD_BASE_TREE_KEY"))).not.toMatch(/[Tt]oken|GH_|ssm |secretsmanager/);
    expect(spec).toContain("chmod 600 /home/switchboard/.aws/config");
    expect(spec).toContain("sso_account_id = ");
    expect(spec).not.toMatch(/echo [^\n]*(accountIds|sso_account_id|j\.names)/);
  });

  test("the instance role names this project and its log; the boundary names them, not by !GetAtt", () => {
    const role = resource("InstanceRole");
    expect(role).toContain("Action: [codebuild:StartBuild, codebuild:BatchGetBuilds, codebuild:StopBuild]\n                Resource: !GetAtt OffloadCi.Arn");
    expect(role).toContain("Action: logs:GetLogEvents\n                Resource: !GetAtt OffloadCiLogs.Arn");
    // the host reads the parameter (sb-offload --ci)
    expect(role).toContain("parameter/switchboard/offload-ci-project'");
    const ci = statements(resource("Boundary"), "- Sid: ").find((st) => st.startsWith("OffloadCi\n"));
    expect(ci).toContain("project/${AWS::StackName}-offload-ci'");
    expect(ci).toContain("log-group:/aws/codebuild/${AWS::StackName}-offload-ci:*'");
    expect(ci).not.toMatch(/!GetAtt|codebuild:\*|logs:\*/);
    expect(resource("DeployRole")).toContain("parameter/switchboard/offload-ci-project'");
  });
});

/** The statements of a policy text, one per `- Effect:` / `- Sid:` item. */
const statements = (block: string) =>
  block
    .split(/\n\s+- (?=Effect:|Sid:)/)
    .slice(1)
    .map((st) => st.replace(/\n\s*#[^\n]*/g, "").trim());
/** The statements of `block` that name `needle`. */
const touching = (block: string, needle: string) => statements(block).filter((st) => st.includes(needle));

describe("aws/template.yaml uplink bucket", () => {
  const COND_NEW = "Condition: { StringEquals: { 's3:if-none-match': '*' } }";
  const COND_MATCH = "Condition: { 'Null': { 's3:if-match': 'false' } }";

  test("Uplink is its own bucket, encrypted, private and versioned, kept on delete; the records expire after 90 days", () => {
    const b = resource("Uplink");
    expect(b).toContain("DeletionPolicy: Retain");
    expect(b).toContain("UpdateReplacePolicy: Retain");
    expect(b).toContain("VersioningConfiguration: { Status: Enabled }");
    expect(b).toContain("SSEAlgorithm: AES256");
    expect(b).toContain("BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true");
    expect(b).toContain("{ Id: uplink, Status: Enabled, Prefix: uplink/, ExpirationInDays: 90 }");
    expect(b).toContain("{ Id: backlog, Status: Enabled, Prefix: backlog/, ExpirationInDays: 90 }");
    expect(resource("Data")).not.toContain("uplink");
  });

  // The work machines' permissions are ONE managed policy: every prefix that names a machine names it through the policy variable
  // of the principal's tag, so the template holds no machine name and no principal (a machine is added in IAM, with no deploy).
  const TAG = "aws:PrincipalTag/switchboard-machine";
  const VAR = "${!aws:PrincipalTag/switchboard-machine}"; // inside !Sub: CloudFormation leaves it literal for IAM
  const policy = () => resource("UplinkWorkMachinePolicy");
  const NOT_LIKE = `StringNotLike: { '${TAG}': ['', '*/*', '*.*', '*:*', '*@*', '*+*', '*=*', '* *', '_*', '-*'] }`;
  const guard = (st: string) => st.includes(`'Null': { '${TAG}': 'false'`) && st.includes(NOT_LIKE);
  // made at run time: a 12-digit account id written out would read as a secret to the public tree check
  const ACCOUNT = (d: string) => d.repeat(12);

  test("the template has no work machine name and no principal: the per-machine parameter, slots and roles are gone", () => {
    expect(text).not.toMatch(/UplinkMachines|UplinkSlots|UplinkWriter|HasUplinkMachine|TooManyUplinkMachines|UplinkMachinesAtMostEight|ForEach::Uplink/);
    // the only loop left is the VPC origins'
    expect([...text.matchAll(/Fn::ForEach::(\w+):/g)].map((m) => m[1])).toEqual(["Edge"]);
    expect(text).not.toMatch(new RegExp(`arn:aws:iam::${ACCOUNT("[0-9]")}:`));
    expect(text).not.toContain("\nMappings:");
    expect(text).not.toContain("ignore_checks");
    // the one parameter of the host's own name stays
    expect(text).toMatch(/\n  InstanceMachineName:\n    Type: String\n    Default: instance\n/);
    // the transform is still needed by the VPC origins
    expect(text).toStartWith("AWSTemplateFormatVersion: '2010-09-09'\nTransform: [AWS::LanguageExtensions, AWS::Serverless-2016-10-31]\n");
    // one managed policy, no role made for a work machine, and its ARN is an output
    expect(policy()).toContain("Type: AWS::IAM::ManagedPolicy");
    expect(text).not.toContain("-uplink/");
    expect(text).toContain("\n  UplinkWorkMachinePolicyArn:\n");
    expect(text.slice(text.indexOf("\n  UplinkWorkMachinePolicyArn:\n"))).toContain("Value: !Ref UplinkWorkMachinePolicy");
  });

  test("every prefix of the managed policy that names a machine names it by the tag variable only, in each statement", () => {
    const sts = statements(policy());
    expect(sts).toHaveLength(7); // put new keys, read back, list, read leases, put a lease taken, put a lease renewed, put its own proof
    // every key under the machine segment is the variable: no other segment follows uplink/, backlog/, backlog-refused/, backlog-export/ or lease-proof/
    const keys = [...policy().matchAll(/\$\{Uplink\.Arn\}\/([a-z-]+)\/([^'\n]*)'/g)].map((m) => `${m[1]}/${m[2]}`);
    expect(keys.filter((k) => k !== "lease/*" && k !== "lease-proof/*").sort()).toEqual([
      `backlog-export/${VAR}/*`, `backlog-refused/${VAR}/*`, `backlog/${VAR}/*`, `backlog/${VAR}/*`, `lease-proof/${VAR}/*`, `uplink/${VAR}/*`,
    ]);
    const listPrefixes = /'s3:prefix': \[([^\]]*)\]/.exec(policy())![1]!;
    expect(listPrefixes).toBe(`'lease/*', !Sub 'backlog-refused/${VAR}/*', !Sub 'backlog-export/${VAR}/*'`);
    // nothing names a machine by a value
    expect(policy()).not.toMatch(/Machine:|InstanceMachineName|instance\//);
    expect(policy()).not.toMatch(/\$\{Uplink\.Arn\}\/(uplink|backlog|backlog-refused|backlog-export|lease-proof)\/(?!\$\{!aws:PrincipalTag\/switchboard-machine\}\/|\*')/);
    // a variable is only read by IAM when the policy is evaluated: the Sub wraps it with `!` so CloudFormation keeps it
    expect(policy().match(/\$\{aws:PrincipalTag/g)).toBeNull();
    expect(sts.every((st) => st.includes("Effect: Allow"))).toBe(true);
  });

  test("a principal without the tag, or with a tag holding a `/`, matches no statement of the managed policy", () => {
    for (const st of statements(policy())) expect(guard(st)).toBe(true);
    // evaluate each statement's own conditions the way IAM does: Null false = the tag exists; StringNotLike = the value
    // matches none of the patterns (`*` any run, `?` one character), read from the template, not written here
    const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    for (const st of statements(policy())) {
      const patterns = [...(/StringNotLike: \{ 'aws:PrincipalTag\/switchboard-machine': \[([^\]]*)\]/.exec(st)?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => glob(m[1]!));
      expect(patterns.length).toBeGreaterThan(0);
      const matches = (tag: string | undefined) => tag !== undefined && st.includes(`'Null': { '${TAG}': 'false'`) && !patterns.some((p) => p.test(tag));
      expect([undefined, "", "pc1/x", "pc.1", "pc1:", "a@b", "a+b", "a=b", "a b", "_pc", "-pc"].map(matches)).toEqual(Array(11).fill(false));
      expect(["pc1", "a-2_b", "PC2"].map(matches)).toEqual([true, true, true]);
    }
  });

  test("the work machine's permissions: new keys only under its own uplink/ and backlog/, reads and writes of leases, no delete, no other machine's prefix, no data bucket", () => {
    const role = policy();
    expect(role).not.toMatch(/Delete|PutObjectVersionTagging|s3:\*|Action: '\*'|Data\.Arn|\$\{Data/);
    const puts = statements(role).filter((st) => st.includes("s3:PutObject"));
    const put = (key: string) => puts.filter((st) => st.includes(key));
    // every put, by prefix: what is written, and under which condition
    expect(puts.flatMap((st) => [...st.matchAll(/\$\{Uplink\.Arn\}\/([a-z-]+\/[^'*]*)\*?/g)].map((m) => m[1])).sort()).toEqual([`backlog/${VAR}/`, `lease-proof/${VAR}/`, "lease/", "lease/", `uplink/${VAR}/`]);
    expect(put(`uplink/${VAR}/*`)[0]).toContain("StringEquals: { 's3:if-none-match': '*' }");
    expect(put(`backlog/${VAR}/*`)[0]).toContain("StringEquals: { 's3:if-none-match': '*' }");
    expect(put(`backlog/${VAR}/*`)[0]).toBe(put(`uplink/${VAR}/*`)[0]); // the same statement: one condition for both
    expect(put("lease/*").map((st) => st.includes("StringEquals: { 's3:if-none-match': '*' }") || st.includes("'s3:if-match': 'false'")).sort()).toEqual([true, true]);
    expect(put(`lease-proof/${VAR}/*`)[0]).not.toMatch(/s3:if-/); // a proof is overwritten when a lease is given back
    // reads: its own backlog edits and refusals, the leases and the proofs of everyone; the list only by prefix
    const reads = touching(role, "s3:GetObject").join("\n");
    for (const k of [`backlog/${VAR}/*`, `backlog-refused/${VAR}/*`, `backlog-export/${VAR}/*`, "lease/*", "lease-proof/*"]) expect(reads).toContain(k);
    expect(reads).not.toMatch(/uplink\/|backlog\/\*|backlog-refused\/\*|backlog-export\/\*/);
    expect(touching(role, "s3:ListBucket")).toHaveLength(1);
    // a put never reaches backlog-refused/ or backlog-export/ (only the instance writes them)
    expect(puts.join("")).not.toContain("backlog-refused");
    expect(puts.join("")).not.toContain("backlog-export");
    // the managed policy is the work machine's only grant: it does not ask for a boundary or name the instance's role
    expect(role).not.toMatch(/PermissionsBoundary|InstanceRole/);
  });

  test("the backlog copy: the instance writes backlog-export/ (over its own earlier object), a work machine reads only its own prefix, and none reaches the data bucket", () => {
    // the instance: a put on the whole prefix with no condition (an object is replaced at every round); the bucket policy's write-once rule does not name it
    const put = statements(resource("InstanceRole")).filter((st) => st.includes("${Uplink.Arn}/backlog-export/*"));
    expect(put).toHaveLength(1);
    expect(put[0]).toContain("Action: s3:PutObject");
    expect(put[0]).not.toContain("Condition");
    expect(statements(resource("UplinkPolicy")).find((st) => st.includes("Sid: WriteOnce"))).not.toContain("backlog-export");
    // the instance reads nothing of it, and the delete stays refused to it
    expect(statements(resource("InstanceRole")).filter((st) => st.includes("s3:GetObject")).join("")).not.toContain("backlog-export");
    // the work machine: the read and the list name its own machine, and it cannot put there
    expect([...policy().matchAll(/backlog-export\/\$\{!aws:PrincipalTag\/switchboard-machine\}\/\*/g)]).toHaveLength(2); // the read and the list
    expect(touching(policy(), "s3:GetObject").join("\n")).toContain(`backlog-export/${VAR}/*`);
    expect(touching(policy(), "s3:PutObject").join("\n")).not.toContain("backlog-export");
    expect(policy()).not.toMatch(/backlog-export\/\*|Data\.Arn|\$\{Data/);
  });

  test("adding a machine changes neither the Boundary, the DeployRole nor the InstanceRole: they do not name a machine", () => {
    for (const r of ["Boundary", "DeployRole"]) expect(resource(r)).not.toMatch(/Uplink(Machines|Writer|WorkMachine)|HasUplinkMachine|InstanceMachineName|PrincipalTag/);
    expect(resource("DeployRole")).toContain("role/${AWS::StackName}-*'");
  });

  test("nobody the stack makes can set or remove a tag of an IAM user: the tag is what limits a machine to its prefix, so only an IAM administrator moves it", () => {
    const boundary = text.slice(text.indexOf("\n  Boundary:\n"), text.indexOf("\n  InstanceRole:\n"));
    const tagActions = /iam:(Un)?[Tt]ag/;
    expect(boundary).not.toMatch(tagActions);
    expect(boundary).not.toMatch(/iam:\*|Action: '\*'/);
    expect(resource("InstanceRole")).not.toMatch(tagActions);
    expect(resource("GitHubOidcRole")).not.toMatch(tagActions);
    // the deploy role tags and untags the stack's own roles only (CloudFormation does it to the roles it makes), never a user or a policy
    const deploy = resource("DeployRole");
    expect(deploy).not.toMatch(/iam:(Un)?Tag(User|Policy)/);
    const withTag = statements(deploy).filter((st) => tagActions.test(st));
    expect(withTag.map((st) => /iam:TagRole/.test(st) && /iam:UntagRole/.test(st))).toContain(true);
    for (const st of withTag.filter((st) => /iam:(Un)?TagRole|iam:TagOpenID/.test(st))) expect(st).toMatch(/Resource: !Sub 'arn:aws:iam::\$\{AWS::AccountId\}:(role\/\$\{AWS::StackName\}-\*|oidc-provider\/token\.actions\.githubusercontent\.com)'/);
  });

  test("the bucket policy refuses a put over an existing key, a lease put with neither condition, and any delete by the instance or the work machine", () => {
    const pol = resource("UplinkPolicy");
    const once = statements(pol).find((st) => st.includes("Sid: WriteOnce"))!;
    expect(once).toContain("Effect: Deny");
    for (const k of ["uplink/*", "backlog/*", "backlog-refused/*"]) expect(once).toContain(`\${Uplink.Arn}/${k}'`);
    expect(once).not.toContain("lease");
    expect(once).toContain("Condition: { StringNotEquals: { 's3:if-none-match': '*' } }");
    const lease = statements(pol).find((st) => st.includes("Sid: LeaseConditional"))!;
    expect(lease).toContain("Effect: Deny");
    expect(lease).toContain("Resource: !Sub '${Uplink.Arn}/lease/*'");
    expect(lease).toContain("Condition: { 'Null': { 's3:if-none-match': 'true', 's3:if-match': 'true' } }"); // both absent
    const del = statements(pol).find((st) => st.includes("Sid: NoDelete"))!;
    expect(del).toContain("Effect: Deny");
    expect(del).toContain("[s3:DeleteObject, s3:DeleteObjectVersion]");
    expect(del).toContain("!GetAtt InstanceRole.Arn");
    const delRoles = statements(pol).find((st) => st.includes("Sid: NoDeleteWorkMachine"))!;
    expect(delRoles).toContain("Effect: Deny");
    expect(delRoles).toContain("[s3:DeleteObject, s3:DeleteObjectVersion]");
    expect(delRoles).toContain("Condition: { 'Null': { 'aws:PrincipalTag/switchboard-machine': 'false' } }");
    expect(pol.match(/Effect: Allow/g)).toBeNull();
  });

  test("the instance role reads the uplink prefixes, writes leases only conditionally, its own proofs, and refusals once; no delete, nothing else", () => {
    const sts = statements(resource("InstanceRole")).filter((st) => st.includes("Uplink.Arn"));
    const withKey = (k: string, action: string) => sts.filter((st) => st.includes(`\${Uplink.Arn}/${k}`) && st.includes(action));
    expect(sts.join("")).not.toMatch(/Delete|Effect: Deny|s3:\*/);
    const get = withKey("uplink/*", "s3:GetObject")[0]!;
    for (const k of ["uplink/*", "backlog/*", "lease/*", "lease-proof/*"]) expect(get).toContain(`\${Uplink.Arn}/${k}'`);
    // backlog-export/ is listed (never read) to find an export to write a tombstone over
    expect(sts.find((st) => st.includes("s3:ListBucket"))).toContain("'s3:prefix': ['uplink/*', 'backlog/*', 'lease/*', 'backlog-export/*']");
    expect(withKey("lease/*", "s3:PutObject").map((st) => st.includes(COND_NEW) || st.includes(COND_MATCH)).sort()).toEqual([true, true]);
    expect(withKey("lease-proof/${InstanceMachineName}/*", "s3:PutObject")[0]).not.toContain("Condition");
    expect(withKey("backlog-refused/*", "s3:PutObject")[0]).toContain(COND_NEW);
    // every put it has on the bucket, by prefix: it never writes uplink/ or backlog/ (a work machine's)
    expect(sts.filter((st) => st.includes("s3:PutObject")).flatMap((st) => [...st.matchAll(/\$\{Uplink\.Arn\}\/([a-z-]+\/[^'*]*)/g)].map((m) => m[1])).sort()).toEqual(["backlog-export/", "backlog-refused/", "lease-proof/${InstanceMachineName}/", "lease/", "lease/"]);
  });

  test("the host's proof prefix is its machine name, and no principal with the tag may write it, whatever the tag holds", () => {
    expect(text).toMatch(/\n  InstanceMachineName:\n    Type: String\n    Default: instance\n/);
    // the refusal is in the bucket policy, for any principal that has the tag at all (the tag's value is not read)
    expect(text).not.toContain("\nRules:\n");
    const deny = statements(resource("UplinkPolicy")).find((st) => st.includes("Sid: HostProofsAreTheInstancesOwn"))!;
    expect(deny).toContain("Effect: Deny");
    expect(deny).toContain("Principal: '*'");
    expect(deny).toContain("Action: s3:PutObject");
    expect(deny).toContain("Resource: !Sub '${Uplink.Arn}/lease-proof/${InstanceMachineName}/*'");
    expect(deny).toContain("Condition: { 'Null': { 'aws:PrincipalTag/switchboard-machine': 'false' } }");
    expect(deny).not.toContain("aws:PrincipalArn");
    // the instance's role carries no tag and is no role of a machine, so it still writes its own proofs
    expect(resource("InstanceRole")).not.toMatch(/PrincipalTag|Tags:/);
    expect(statements(resource("InstanceRole")).some((st) => st.includes("${Uplink.Arn}/lease-proof/${InstanceMachineName}/*") && st.includes("s3:PutObject"))).toBe(true);
    // a machine tagged with the host's own name gets the managed policy's prefix lease-proof/<the variable>/, which the deny above covers
    expect(policy()).toContain(`lease-proof/${VAR}/*`);
  });

  test("the boundary allows the same range without delete, the deploy role may make the bucket, and the name is in Parameter Store", () => {
    const b = resource("Boundary");
    const st = statements(b).find((x) => x.includes("Sid: UplinkBucket"))!;
    expect(st).toContain("Action: [s3:GetObject, s3:PutObject, s3:ListBucket]");
    expect(st).not.toContain("Delete");
    expect(b).not.toMatch(/Uplink\.Arn[^\n]*\n[^\n]*Delete/);
    expect(resource("DeployRole")).toContain("!GetAtt Uplink.Arn, !Sub '${Uplink.Arn}/*'");
    expect(resource("DeployRole")).toContain("parameter/switchboard/uplink-bucket'");
    expect(resource("UplinkBucketParam")).toContain("Name: /switchboard/uplink-bucket");
    expect(resource("UplinkBucketParam")).toContain("Value: !Ref Uplink");
  });

  test("UserData and the instance are untouched by this: the bucket's name is read from Parameter Store, and the instance is not replaced", () => {
    const lt = resource("LaunchTemplate");
    expect(lt).not.toMatch(/uplink|Uplink/);
    expect(resource("Instance")).not.toMatch(/uplink|Uplink/);
    // the line that hands the host its values is the one it was: a new name there would replace the instance
    expect(lt).toContain("SB_DATA_BUCKET='${Data}' SB_SCHEDULER_ROLE_ARN='${SchedulerRole.Arn}' bash /opt/switchboard-host/aws/host/bootstrap.sh");
    expect(lt).toContain("SB_HOST_USER='${HostUser}' SB_HOST_HOME='${HostHome}' SB_REPOS_DIR='${ReposDir}' SB_GITHUB_REPO='${GitHubRepo}' SB_DATA_BUCKET='${Data}'");
  });
});
