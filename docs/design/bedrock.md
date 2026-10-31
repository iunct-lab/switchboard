# Running Claude and Codex on Amazon Bedrock

Switchboard can run the Claude and Codex runners on Amazon Bedrock instead of the user's own login (the Claude account,
the OpenAI subscription). It is a choice the user makes on the settings screen, per runner, and it is never made for them.

## What is switched

- The setting is `bedrock` in the daemon settings: runner to `{ region }`. No row (the default) means the runner runs on
  its own login. Only a runner whose adapter has Bedrock models (`bedrockModels`) can be switched: Claude and Codex;
  DAK cannot.
- Only the region is saved. There is no field for a key, a profile or a token, and none is read.
- It takes effect for the tasks that start after the change; a running task keeps what it started with. A session is not
  meant to be resumed across the two without starting over.

## Nothing switches by itself

If the runner's own login lapses, the runner shows as logged out and the tasks that need it stop with the usual message. The
daemon does not start a task on Bedrock because of that, including tasks that start on a schedule or by themselves.
The child process gets the Bedrock variables or arguments only when the setting exists, and the Claude adapter drops any
`CLAUDE_CODE_USE_BEDROCK` the daemon itself was started with.

## How the child runs

### Claude

With the setting, the `claude` child gets `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION=<region>`; nothing else changes
(the model still goes through `--model`). Model ids are the Bedrock form of the same models: `global.anthropic.<model>`,
the global inference profile. A turn on Bedrock says nothing about the Claude login, so the logged-out state is left as it was.

### Codex

With the setting, `codex app-server` is started with two more config overrides after the adapter's own:
`-c model_provider="amazon-bedrock"` and `-c model_providers.amazon-bedrock.aws.region="<region>"`; without it the
arguments are unchanged. `~/.codex/config.toml` is not written. Model ids are Codex's own Bedrock ids of the same models,
`openai.<model>` (for example `openai.gpt-6-luna`); a model that Codex has no Bedrock id for is not offered. The Bedrock
API key that Codex can also use is neither used nor stored: Codex takes the standard AWS credentials, like Claude. A turn
on Bedrock says nothing about the OpenAI login, so its state is left as it was.

## Credentials

Switchboard holds no AWS key and stores none. The `claude` and `codex` CLIs find AWS credentials the way any AWS tool does
(environment, shared config, or the instance role on an EC2 host). The cloud-run mode of Claude (Teleport) is not
affected: it runs on Anthropic's side.

## What the host can call

The host's instance role, and the boundary that caps every role of the stack, allow `bedrock:InvokeModel` and
`bedrock:InvokeModelWithResponseStream` on any model and inference profile; the versions are not pinned, so a new
model needs no deploy. Codex reaches the OpenAI models through Bedrock Mantle rather than `InvokeModel`, so they also
allow `bedrock-mantle:CreateInference` on the projects of the stack's own region only: a Codex region set to another
region is refused. Key creation and any other Bedrock action are not allowed. The model list on the settings screen shows
every Bedrock model of the adapter; what the account can call is decided by IAM.

## Showing it

While a runner is on Bedrock, its row in the settings says so ("Amazon Bedrock as a third-party platform"), and the row
offers the way back to the runner's own login. Usage on Bedrock is billed by AWS: the ledger prices a Bedrock model id like
the same Anthropic or OpenAI model (a price row or alias written for the Bedrock id itself wins) and counts it as actual cost, whatever the
runner's plan says. Bedrock's regional price differences are not modelled.

## Not done

Choosing per task, a limit-driven switch to Bedrock, keys on the screen, Codex's interactive Bedrock setup, and the cloud-run mode.
