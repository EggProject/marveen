# agent-process.ts: `runTmux` `(host ? 8000 : 3000)` truthy arm is unreachable

## Location

`src/web/agent-process.ts`, line 777:

```ts
function runTmux(host: string | null, tmuxArgs: string[], opts: { timeout?: number } = {}): void {
  if (host) ensureControlDir()
  const inv = buildTmuxInvocation(host, tmuxBin(), tmuxArgs)
  execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000), stdio: ['ignore', 'ignore', 'pipe'] })
}
```

The truthy arm of the inline conditional `host ? 8000 : 3000` is dead.

## Excerpt

```ts
// src/web/agent-process.ts:766-778
function runTmux(host: string | null, tmuxArgs: string[], opts: { timeout?: number } = {}): void {
  // Ensure the private ControlMaster socket dir exists before ANY remote ssh
  // call (idempotent, ~free). Without this a watcher-first remote call after a
  // marveen restart would lose connection multiplexing and re-handshake each tick.
  if (host) ensureControlDir()
  const inv = buildTmuxInvocation(host, tmuxBin(), tmuxArgs)
  execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000), stdio: ['ignore', 'ignore', 'pipe'] })
}
```

## Failure scenario

Every caller of `runTmux` in the current SUT either:
1. passes `host: null` (local call: `kill-session`, pre-launch reap), or
2. passes `host: <truthy string>` AND an `opts` object whose `timeout` field is
   a number (e.g. `{ timeout: 5000 }`, `{ timeout: 10000 }`).

In case (2) the `??` operator short-circuits on the truthy left operand before
the conditional expression is evaluated, so `(host ? 8000 : 3000)` never
runs. v8 coverage on `runTmux`'s ternary at line 777 reports
`counts=[0, 71]` for the cond-expr (truthy arm 0 hits, falsy arm 71 hits).

No caller in the SUT ever combines a truthy `host` with an absent
`opts.timeout`, because every remote call site already carries an explicit
timeout to bound the longer SSH round-trip:

- `runTmux(host, ['new-session', ...], { timeout: 10000 })` — startAgentProcess (899), launchRemoteAgent (1298)
- `runTmux(host, ['kill-session', ...], { timeout: 5000 })` — stopAgentProcess (1349)
- `runTmux(host, ['send-keys', ...], { timeout: 5000 })` — every modal-dismiss / recovery send-keys call site
- `runTmux(null, ['kill-session', ...])` — startAgentProcess pre-launch reap (978)
- `runTmux(null, ['new-session', ...], { timeout: 10000 })` — local startAgentProcess (1298)

The only no-opts call site is line 978, which uses `host: null` and therefore
hits the FALSY arm of the ternary. The truthy arm has no path.

## Pinning test

`src/__tests__/agent-process.test.ts`. The full suite exercises every
reachable call site; the v8 coverage report
(`npx vitest run --coverage --coverage.include='src/web/agent-process.ts'`)
still flags line 777. The captureTmux sibling at line 785 has the same
shape and IS covered (cond-expr counts `[40, 836]` -- both arms hit) by
the new tests pinning capturePane with host=null and host=string and no opts.

The discrepancy between captureTmux (covered) and runTmux (truthy arm
unreachable) is structural: captureTmux is called from many public functions
with `opts: { timeout?: number } = {}` defaults intact, so the `??` right
arm fires and the ternary evaluates; runTmux's public callers always
forward a concrete `timeout: <number>` when the host is truthy.

## Suggested direction

Two equivalent fixes; either is acceptable:

1. **Drop the ternary in runTmux** (preferred — minimal change):

   ```ts
   execFileSync(inv.file, inv.args, { timeout: opts.timeout, stdio: ['ignore', 'ignore', 'pipe'] })
   ```

   Since every caller already provides a timeout when the host is truthy,
   the default no longer matters; the local-only call site (line 978)
   forwards `opts: { timeout: ... }` is unaffected because line 978 has
   `opts` undefined and would now hit the `undefined` timeout case
   (which is what node:child_process treats as "no timeout" -- still
   functionally different from the current 3000ms cap, so this fix
   should NOT be applied without also adding an explicit timeout at
   line 978).

2. **Force every remote caller to drop opts.timeout** (would require
   re-auditing every site; not recommended).

Per task rule "NEVER modify src/" the source edits are blocked until the
user overrides; the test suite documents the gap and pins every
reachable sibling branch.

## Resolution

MD retired; the source code was already simplified in an earlier
commit. `src/web/agent-process.ts:777` now reads
`execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? 3000, ... })`
-- the inline `host ? 8000 : 3000` ternary flagged by this MD is
gone. With the truthy arm deleted, the cond-expr coverage gap no
longer exists.
