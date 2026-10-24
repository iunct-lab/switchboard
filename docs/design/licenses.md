# Dependency licenses

Switchboard is Apache-2.0. `bun run licenses:check` (`scripts/check-licenses.ts`) reads `bun pm licenses --json` — every installed package, transitive and dev included — and fails when one has a license outside `scripts/licenses.allow.json`. CI runs it right after `bun install --frozen-lockfile`, so a pull request that brings in such a dependency goes red (PBI #23).

## Why these licenses

What is shipped (the bundle, a release built by sb-rescue, a future single binary) contains the dependencies, so their licenses have to allow redistribution inside an Apache-2.0 work without changing its terms.

| License | Allowed | Why |
|---|---|---|
| MIT, ISC, 0BSD, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, Unlicense, CC0-1.0, Python-2.0 | yes | permissive: keep the notice, nothing more |
| Apache-2.0 | yes | the same license |
| CC-BY-4.0 | yes, for data | `caniuse-lite` (browser-support data used by the web build). Attribution only; not a license for code. **The check does not enforce "for data"**: CC-BY-4.0 is in `allowed` for every package, so a code package under CC-BY passes CI — the reviewer of a dependency change has to look |
| GPL-*, AGPL-*, LGPL-*, MPL-*, EPL-*, SSPL, BUSL, … | no | copyleft or source-available terms would reach into or restrict the Apache-2.0 work |
| unknown, empty, `UNLICENSED` | no | no license means no permission to redistribute |

SPDX expressions: an `OR` passes when one of its choices is allowed (the dependency may be used under that one); an `AND` needs every part. One pair of parentheses around the whole expression is read; a parenthesised group joined to another part, such as `(MIT OR ISC) AND GPL-3.0`, is not parsed and fails (why: "SPDX expression with nested groups"), so an unreadable expression never passes.

## Exceptions

A dependency outside the list can be allowed on its own, with a reason and a date to look at it again:

```json
"exceptions": [
  { "name": "some-pkg", "license": "MPL-2.0", "reason": "build-time only, not in any shipped file", "until": "2027-03-31" }
]
```

The exception covers that package under that license only. After `until` it fails again (the date is compared in UTC, the way CI runs). An exception without `reason`, an `until` that is not an existing `YYYY-MM-DD` date, or an allow list without its `allowed` / `exceptions` arrays stops the check as a configuration error.

## Reading `bun pm licenses`

`bun pm licenses` lists the packages **installed in `node_modules`** per license, not every entry of `bun.lock`: platform-specific packages for other OSes (`@esbuild/win32-x64` on Linux CI) are not seen. CI checks the Linux set; a local run checks yours. Without `node_modules` the check fails (exit 2) rather than passing. `bun pm licenses` lists the packages per license; `--json` gives `{ "<license>": [{ name, versions, license, paths, … }] }`. When the check fails it prints `name@version  license  (why)` per package; `bun pm why <name>` shows which dependency pulled it in.

## Not covered

- The root `NOTICE` (attribution of included third-party material, linked from README's License section; #24, #77) is maintained by hand, not by this check
- The runners (claude, codex, DAK): installed by the user, not shipped
