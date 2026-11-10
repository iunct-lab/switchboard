# Fork and develop

The public repository is a read-only mirror: it accepts requests (Issues), not pull requests, and closes PRs automatically. To change Switchboard, fork it and develop on your own fork, with your own Issues, Project, PRs, reviews and Releases. This page is the one place that lists the steps; send anything you want upstream as a request.

You need nothing from the upstream repository's history, Project or credentials.

## 1. Clone and set up

1. Fork the public repository and clone your fork. Check with `git remote -v` that `origin` points at your fork. If you set `GH_REPO`, set it to your own `owner/name` and leave no value that points upstream (unset, it falls back to `origin`).
2. A clone made by `gh repo fork --clone`, or one with upstream added as `upstream`, makes `gh` default to upstream (`gh repo view` shows it). Run `gh repo set-default <your owner/name>`.
3. `./scripts/setup.sh` (installs Bun if it is missing and the workspace dependencies, and lists the runners found on `PATH`). Start the app as the README describes.

## 2. Run the tests

```bash
bun run typecheck
bun test packages apps ops-kit
```

The replay tests read recordings kept outside Git (see the README's Develop section); without them those tests are skipped.

## 3. Your own Project and `ops.config.json`

1. Create a GitHub Project of your own and set the repository variable that matches `envPrefix` in `ops.config.json`: `gh variable set <PREFIX>_PROJECT_URL --repo <owner/name> --body <Project URL>`. A variable of the same name in the environment takes precedence, so update it too.
2. Before `bun ops-kit/src/cli.ts bootstrap`, set `fields.area`, `fields.phase` and `milestone.pattern` in `ops.config.json` to your own values. The values in this repository are Switchboard's own packages and Phases, and `bootstrap` would copy them into your Project.
3. Check the fields and the required sections in `ops.config.json`, then run `bun ops-kit/src/cli.ts bootstrap <Project title>` to create the fields.
4. If you want new Issues added to the Project automatically, copy `ops-kit/template/.github/workflows/project-autoadd.yml` to `.github/workflows/`, replace `__PREFIX__` with your `envPrefix`, and set the `<PREFIX>_PROJECT_URL` variable and a repository secret `<PREFIX>_PROJECT_TOKEN` that can write the Project. The workflow never runs code from a PR.
5. Keep `publicSync` in `ops.config.json`. Its `target` is the upstream public repository, and the kit's tools, the `gh` front end and the app's backlog refuse writes when a clone's default write target is that repository. If you publish to a public repository of your own, change `target` to it; you have no permission to `public-sync` to upstream. If a write is refused, see [the kit's note](../ops-kit/README.md#公開側への書き込みが止まったとき).

## 4. Issue and PR templates

Replace the request-only forms in `.github/ISSUE_TEMPLATE/` with the development forms in `ops-kit/template/.github/ISSUE_TEMPLATE/`. Fill `__OWNER__`, `__REPO__`, `__AREA__` and `__TEST_ALL__` with your values and make the Area options and required sections match `ops.config.json`. Take the PR body template from `ops-kit/template/.github/PULL_REQUEST_TEMPLATE.md`, and check `.github/labels.yml` before syncing the labels.

## 5. Stop the PR auto-close workflow

Delete `.github/workflows/close-pull-requests.yml` so PRs on your fork are accepted. Then:

- Rewrite the `How this repository works` section of `README.md`, `SECURITY.md` and the links in the Issue forms to your own policy and reporting address.
- Enable Actions and Issues on the fork, and set the variable that `ci.yml` checks to `on` (`gh variable set <PREFIX>_ACTIONS --repo <owner/name> --body on`). Without the variable, jobs are skipped. If you change `envPrefix`, change the same condition in every workflow under `.github/workflows/` to `<PREFIX>_ACTIONS`.

## 6. Switchboard's own workflows

Use the workflows in `.github/workflows/` as they are, where you want them:

- `release-tag.yml`: set the repository variable `SWITCHBOARD_RELEASE_TAGS=on` to create a tag and a Release on every push to main, without waiting for CI (`scripts/release-tag.ts`). Check that Actions has write permission.
- `host.yml`: for an AWS host, follow [the AWS guide](../aws/README.md) for the first deployment into your own AWS and point the OIDC trust at your fork. Set the repository variables `SWITCHBOARD_AWS_REGION`, `SWITCHBOARD_HOST_STACK` (the region and stack name only if they differ from the defaults), `SWITCHBOARD_HOST_ROLE_ARN` (the GitHubOidcRole output) and `SWITCHBOARD_HOST_PARAMS` (parameter overrides without secrets). Token values are read from SSM; the stack decides their names.

## 7. Your own values in `CLAUDE.md`

`CLAUDE.md` holds the values specific to a repository (the repository and Project, the test commands, where to work, release rules). Replace Switchboard's values with yours. Put values that belong only to you in `private/CLAUDE.md`, which `CLAUDE.md` imports and which may be omitted. Keep owner-only values and records under `private/` and do not add rewrites for them to the public sync.

The shared skills are in `ops-kit/skills/` and the entry scripts in `scripts/setup/`; how the kit installs the skills is in [the kit's README](../ops-kit/README.md#スキルの導入). Run your flow (request, PBI, Task, PR, review, merge) on your fork's Issues and PRs.
