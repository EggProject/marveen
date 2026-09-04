# .github/workflows

CI for the marveen repo. One workflow file, `ci.yml`, with two independent jobs.

## Triggers

- Every `pull_request`.
- `push` to `feature-develop` (repo default branch) and `develop` (release target named in CONTRIBUTING.md).

Topic branches are covered by their PR run, so they are not gated on push.

## Jobs

Both run on `ubuntu-latest` and are **independent** (no `needs:`). A red lint must not hide a green test
result, and vice versa.

| Job | Runs | Status today |
| --- | --- | --- |
| `lint` | `bun run typecheck` → `bun run lint` | **red** |
| `coverage` | `bun run coverage` (all 11092 tests + coverage) + PR comment + artifact | **red** |

### Why there is no separate `test` job

There was one, running `bun run test` without instrumentation. It was removed: `bun run coverage` executes the
same 382 files and 11092 tests, so a test failure fails the `coverage` job just as loudly, and the split
measured at zero benefit. The jobs ran in parallel, so the total run was 2m39s either way, and a public repo
bills 0 minutes — the second job bought a distinct check name and nothing else.

**The consequence to know:** a red X on `coverage` means EITHER a real test failure OR the coverage threshold.
The step log separates them — vitest prints its pass/fail counts before the
`ERROR: Coverage for ... does not meet global threshold` lines — and so does the PR comment.

If you later want the two as independent required checks (e.g. block merges on test failures while coverage
stays advisory), do NOT reintroduce a second suite run. Split the threshold enforcement into a job that consumes
the uploaded coverage artifact instead.

### Why lint is red

`bun run typecheck` fails with ~1700 pre-existing TS errors (1673 of them in `src/__tests__/`, 30 in `src/`,
mostly `src/db.ts`). `bun run lint` reports ~9900 ESLint errors. Both predate this workflow — the strict ESLint
setup was added deliberately with the existing violations left unfixed.

### Why coverage is red

`vitest.config.ts` pins a 100% `perFile` coverage threshold. 44 files are currently below it (overall: lines
99.94%, statements 99.84%, functions 99.72%, branches 98.99%). **The tests themselves all pass** — this is
purely the threshold gate.

The report steps are `if: always()`, so the coverage comment and artifact are published even when the threshold
fails. That is the point: you need the numbers most when the gate is red.

### The suite must stay platform-independent

The first CI run failed 22 files / 50 tests on Linux while all 11088 passed on macOS — nine separate root causes,
every one of them a test that inherited an input from the host instead of controlling it (tmpdir, XDG_RUNTIME_DIR,
birthtime, readdir order, bash version, installed binaries, system timezone, DISPLAY).

Reproduce the Linux behaviour locally before pushing:

```
TZ=UTC TMPDIR=/tmp XDG_RUNTIME_DIR=/run/user/1001 PATH=/opt/homebrew/bin:$PATH bun --bun vitest run
```

## Conventions to keep

- **Every action is pinned to a full-length commit SHA** with the tag in a trailing comment
  (`# v7.0.1`). Tags are mutable and a compromised upstream can move them; a SHA cannot be moved. This is
  GitHub's own secure-use recommendation. When bumping, re-resolve the SHA (`gh api repos/OWNER/REPO/commits/TAG
  --jq .sha`) and update the comment in the same edit.
- **`permissions: contents: read` at workflow level.** Only `coverage` widens it, to `pull-requests: write`, and
  only for its PR comment.
- **No `pull_request_target`.** It would run with repo secrets against untrusted fork code — the "pwn request"
  pattern. The consequence is that the coverage comment is skipped on fork PRs (their `GITHUB_TOKEN` is
  read-only); the artifact still uploads.
- **`bun install` is repeated per job.** With the `~/.bun/install/cache` restore keyed on `hashFiles('bun.lock')`
  this costs seconds, and it buys job independence. `oven-sh/setup-bun` caches only the bun executable, not the
  package cache — the explicit `actions/cache` step is not redundant.
- **No `bun-version` input.** `setup-bun` reads `packageManager` (`bun@1.3.14`) from `package.json`, so the
  version pin lives in exactly one place.
- **`actions/setup-node` in the lint job is required, not decorative.** `bun run lint` executes
  `node_modules/.bin/eslint`, whose shebang is `#!/usr/bin/env node`; Bun honours the shebang unless `--bun` is
  passed, so ESLint runs under Node. Pinning Node via `.nvmrc` also makes `NODE_OPTIONS=--max-old-space-size` in
  the lint script effective — it is a V8 flag and a no-op under Bun's JSC engine.
- **`concurrency` with `cancel-in-progress`.** Force-push-heavy PR branches otherwise pile up runs.

## Not covered here

- No Playwright smoke job. `tests/smoke/**` needs a running dashboard at `DASHBOARD_URL`; run it locally with
  `bun run smoke`.
- No Node or OS matrix. The project runs on Bun; a matrix would double the cost for little signal.
- No Codecov, no GitHub native code coverage. Native PR coverage needs Cobertura XML, which the vitest istanbul
  provider does not emit, and Code Quality became a paid product on 2026-07-20.
- No `dependabot.yml` yet. Worth adding for the `github-actions` ecosystem so the SHA pins do not rot.
