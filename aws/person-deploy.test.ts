// test-reads: aws/person-deploy.yaml
import { expect, test } from "bun:test";

test("the person's deploy role (aws/person-deploy.yaml) is CloudFormation's for the host stack only, and holds no permission", async () => {
  const t = await Bun.file(new URL("./person-deploy.yaml", import.meta.url)).text();
  expect(t).toContain("Principal: { Service: cloudformation.amazonaws.com }");
  expect(t).toContain("StringEquals: { 'aws:SourceAccount': !Ref AWS::AccountId }");
  expect(t).toContain("ArnLike: { 'aws:SourceArn': !Sub 'arn:aws:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/${HostStack}/*' }");
  // one resource, one principal, nothing that grants a permission: person-deploy attaches it for one deploy
  expect(t.match(/Type: AWS::/g)).toHaveLength(1);
  expect(t.match(/Principal:/g)).toHaveLength(1);
  for (const key of ["Policies:", "ManagedPolicyArns:", "PermissionsBoundary:", "AWS::IAM::Policy", "AWS::IAM::ManagedPolicy"]) expect(t).not.toContain(key);
});
