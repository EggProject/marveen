# test-suite-macos-only-portability

**Filed:** 2026-08-14
**Severity:** medium (a regression baseline that only held on one operating system)
**Status:** RESOLVED 2026-08-14 69244f0

## What

The baseline test suite passed 11088/11088 on macOS and failed **22 files / 50 tests** on the first Linux CI
run (GitHub `ubuntu-latest`, PR #1, run 31746884125). Eight independent root causes, none of them related to
each other, all sharing one shape: **the test accepted an input from the host instead of controlling it.**

The eighth surfaced only on the second CI run, once the first seven stopped masking it — and it is time-of-day
dependent, so it would have hidden again on the next attempt.

For a suite whose entire purpose is detecting regressions during a rewrite, "green" meant "green on the machine
that wrote it". That is the defect being recorded here.

## The eight root causes

### 1. Import-time binary resolution (11 suites died before running a single test)

Ten modules resolved their binaries at module scope:

```ts
const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')
```

`resolveFromPath` throws when the binary is absent, so the throw happened at IMPORT time. A clean runner has
neither `tmux` nor `claude`, so 11 suites — `federation-directory`, `inbox-nudge`, `managed-settings`,
`configurable-brand`, … — died with `Required binary not found on PATH: claude`, none of which have anything to
do with tmux or claude. The same import-time throw takes the live dashboard down during a transient PATH gap,
which is why `makeLazyBinResolver` already existed in `platform.ts` and why `agent-process.ts` already used it.

**Fix:** converted all 12 module-level constants to `makeLazyBinResolver` (10 files), and updated the 17 test
mocks that stub `../platform.js`. `makeLazyBinResolver` must be mocked explicitly rather than taken from
`importOriginal` — the real one closes over the real `resolveFromPath`, so a `resolveFromPath`-only mock does
not apply through it.

**Pinned by:** `src/__tests__/platform-no-import-time-bin-resolve.test.ts` — a structural scan that fails if any
`src/**` module reintroduces a module-scope `resolveFromPath` call. Structural rather than behavioural on
purpose: a behavioural test would need a machine without the binaries, which is precisely the machine we do not
have locally.

### 2. Sandbox under `/tmp` (30 tests)

`isUnsafeHookCommand` (`src/web/agent-scaffold.ts:129`) rejects any hook command referencing `/tmp/`,
`/var/tmp/`, `/private/tmp/` or `/dev/shm/`. That guard is deliberate production behaviour from the 2026-07-14
silent fleet-freeze, where a rebooted host lost the `/tmp` script a shared hook pointed at and Claude Code then
blocked every prompt.

`os.tmpdir()` is `/var/folders/…` on macOS but `/tmp` on Linux. The agent-scaffold suites allocated their
sandbox there, so on Linux every synthetic hook script they planted was rejected, every gate injector silently
no-opped, and 30 assertions failed with no visible connection to the cause.

**Fix:** `mkNonVolatileDir` in `src/__tests__/setup/temp-sandbox.ts` — allocates under `$HOME/.cache`, and
throws loudly if that base is itself volatile. The production guard is untouched.

**Repro before the fix:** `TMPDIR=/tmp bun --bun vitest run src/__tests__/agent-scaffold-full.test.ts` →
exactly the 20 CI failures.

### 3. `XDG_RUNTIME_DIR` (2 tests)

`controlDir()` (`src/web/ssh-tmux.ts:32`) prefers `XDG_RUNTIME_DIR`, falling back to `/tmp/marveen-ssh-<uid>`.
`CONTROL_PATH` is a module-level const computed from it at import. The suite's `beforeEach` deletes
`XDG_RUNTIME_DIR`, so every later `controlDir()` call took the fallback branch while the const had been frozen
with the XDG branch — a contradiction that only exists on a host that sets the variable. macOS never does; the
runner sets `/run/user/1001`.

**Fix:** `vi.hoisted(() => { delete process.env.XDG_RUNTIME_DIR })`, which runs before the static imports, so
module-load time and every later call agree on one branch everywhere.

**Repro before the fix:** `XDG_RUNTIME_DIR=/run/user/1001 bun --bun vitest run src/__tests__/ssh-tmux.test.ts`

### 4. `utimesSync` does not move birthtime on ext4 (2 tests)

`docs.ts:53` sorts by `birthtimeMs`, falling back to `mtimeMs` only when the filesystem reports 0. The tests set
times with `utimesSync`, which only writes atime/mtime. On macOS/APFS the kernel additionally drags birthtime
backwards to keep it `<= mtime`, so setting mtime happened to set birthtime too. ext4 does no such thing:
birthtime stayed at "now" for all three files, the sort fell through to the name tie-break, and both ordering
assertions inverted.

**Fix:** the tests now stub `birthtimeMs` through the suite's existing `statSyncOverride` hook instead of
relying on a filesystem side effect.

### 5. Headless host disables the interactive-login branch (6 tests)

`hostCanInteractiveLogin()` (`src/web/reauth-healer.ts:142`) is
`process.platform === 'darwin' || DISPLAY || WAYLAND_DISPLAY`. Tests asserting that the best-effort `/login`
send-keys fired inherited the host's answer: true on a Mac, false on a headless runner, where the gate skipped
the sequence and the assertions saw zero tmux calls.

**Fix:** a `pinInteractive()` helper (the mirror of the existing `pinHeadless()`) pins linux+DISPLAY for those
tests, deliberately choosing linux over darwin so the non-darwin half of the gate is the one exercised.
`routes-reauth-healer.test.ts` pins it for the whole file — every send-keys test there needs it.

### 6. Unsorted `readdirSync` (1 test, and a real cost in production)

`listAgentLocalSkills` (`src/web/federation/local-catalog.ts:47`) returned raw `readdirSync` order. macOS/APFS
returns it sorted; ext4 returns hash order.

This is not only a test problem. The list is hashed by `summarySourceHash` to decide whether an agent's
LLM-generated capability summary is stale, so an unsorted list makes the hash depend on the host rather than the
content — a restore or a filesystem migration would silently invalidate every cached summary and pay to
regenerate them.

**Fix:** `.sort()` in the source. **Pinned by:** a new test in `federation-local-catalog.test.ts` that creates
skills in reverse-alphabetical order and asserts sorted output, with no defensive `.sort()` on the result.

### 7. bash 3.2 vs bash 5.x `$LINENO` in an ERR trap (1 test)

For an assignment whose command substitution fails inside an `if` block, the ERR trap's `$LINENO` differs by
bash version: 3.2 (still `/bin/bash` on macOS) blames the enclosing `fi`, 5.x blames the assignment. The test
asserted the 3.2 number.

**Fix:** the invariant pinned is the abort itself — trap fires, exit 9, the next statement is never reached —
with the line number accepted as either of the statement's two lines and the version difference documented.

**Verified both ways:** default `/bin/bash` (3.2) and `/opt/homebrew/bin/bash` (5.3) first on PATH.

### 8. Hardcoded timezone vs `APP_TZ` (1 test, latent flake)

`appendDailyLog` (`src/db.ts:1390`) stamps the calendar day with `timeZone: APP_TZ`. The test asked for the day
in a hardcoded `'Europe/Budapest'`.

`APP_TZ` falls back to the **system** timezone when `SCHEDULER_TZ` is unset, so the two only agreed on a
Budapest dev box. On a UTC runner they name different calendar days between 22:00 and 24:00 UTC, the query
matches nothing, and the assertion sees 0 rows instead of 2. The CI run that caught it started at 23:15 UTC —
this would have passed on the same commit at almost any other hour, which makes it a latent flake rather than a
deterministic failure.

**Fix:** the test reads `APP_TZ`, the same source of truth the source writes with. Verified across `TZ=UTC`,
`TZ=Pacific/Kiritimati` (UTC+14) and `TZ=Pacific/Midway` (UTC-11).

## Verification

Full suite, twice, both green:

```
# simulated Linux CI conditions
TMPDIR=/tmp XDG_RUNTIME_DIR=/run/user/1001 PATH=/opt/homebrew/bin:$PATH bun --bun vitest run
  -> 382 files, 11092 tests passed

# native macOS conditions
bun --bun vitest run
  -> 382 files, 11092 tests passed
```

`bun run typecheck` stays at its pre-existing 1703 errors — no new ones introduced. Per-file coverage percentages
on the 11 changed source files are unchanged.

## Follow-up worth doing

The four environment knobs that reproduce the Linux behaviour on macOS — `TMPDIR=/tmp`,
`XDG_RUNTIME_DIR=/run/user/1001`, `TZ=UTC`, and a bash-5 PATH — are the cheapest available guard against this
class of regression returning. Consider a second CI job (or a documented local command) that runs the suite under them,
so a macOS-only assumption is caught before it reaches a Linux runner.

## Observed flake (not a platform issue, not fixed here)

`schedule-runner-full.test.ts > returns missing when session does not exist and startAgentProcess fails for
non-already-running` timed out once at the default 5000ms during a full-suite run, with a stack pointing into a
*different* test in the same file. It did not reproduce: 3/3 green in isolation and green on a full-suite
re-run under identical env. Reads as contention against the 5s default timeout under parallel load rather than
a defect. Recorded so the next sighting is a second data point instead of a first one — do not inflate the
timeout without evidence, that would hide a genuine hang.

## Also worth knowing

`heartbeat-oauth-token.test.ts:96` carries a deliberate `it.skipIf(process.platform !== 'darwin')`. It is not a
defect — the behaviour under test is macOS keychain specific — but it does mean that one path is exercised on a
dev box and never on CI, and the CI summary reports it as "1 skipped".

## Unrelated observation

`src/web/federation/capabilities.ts` contains 5 raw NUL bytes on lines 140-141, used intentionally as hash field
separators but written as literal `\x00` characters rather than the `\0` escape. The file is consequently
classified as binary by `grep`, which silently skips it in every plain `grep -r` over the repo. Not fixed here;
it is unrelated to the CI work.
