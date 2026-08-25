# voice.ts:74,79 -- runProc timer and stdinData fallbacks are unreachable

## Location

`src/web/routes/voice.ts`, lines 65-82 (`runProc`):

```ts
function runProc(
  cmd: string,
  args: string[],
  opts: { stdinData?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false })
    let stdout = ''
    let stderr = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => { proc.kill('SIGKILL') }, opts.timeoutMs)
      : null
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    if (opts.stdinData != null) { proc.stdin.write(opts.stdinData, 'utf-8'); proc.stdin.end() }
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}
```

## Excerpt

Three branches at lines 74, 79, and 81 have unreachable arms:

1. **Line 74** `opts.timeoutMs ? setTimeout(...) : null`:
   - `null` arm unreachable: every call site of `runProc` in voice.ts
     passes a `timeoutMs` (60_000 for transcription, 90_000 for TTS,
     etc.). The four callers at lines 103, 146, 244, 276 all set a
     timeout.

2. **Line 79** `if (opts.stdinData != null) { ... }`:
   - truthy arm unreachable: the only call site that passes
     `stdinData` is around line 244 (and that's one specific handler).
     Most callers pass no `stdinData`, so `opts.stdinData` is
     `undefined` (the field is optional, no default).

3. **Line 81** `if (timer) clearTimeout(timer)`:
   - false arm unreachable: since `timer` is only ever `null` when
     `opts.timeoutMs` is falsy (unreachable per (1)), `timer` is
     always truthy. The `if (timer)` always fires.

The `code ?? 1` at line 82 IS reachable (the test "kills the proc when
timeoutMs is exceeded" exercises it through the kill mock's `closeCb(null)`
call), and v8 does not report it as uncovered.

## Failure scenario

v8 reports:

- branch 9 line=74 type=cond-expr counts=[30, 0]: timeoutMs truthy hit
  30 times across the existing voice-routes tests, `null` arm never.
- branch 10 line=79 type=if counts=[0, 30]: stdinData truthy never hit,
  falsy (null/undefined) hit 30 times.
- branch 11 line=81 type=if counts=[30, 0]: timer truthy hit 30 times
  (because timer is always set per (1)), false arm never.

The 100% branch coverage gate fails on this file because of these
dead branches.

Options:

1. Drop the `: null` fallback at line 74 and make `timeoutMs` required
   in the `opts` type.
2. Drop the `if (timer)` guard at line 81 (the fallback is unreachable
   per (1)).
3. Drop the `if (opts.stdinData != null)` guard at line 79 if the
   `stdinData` parameter becomes mandatory for all callers, OR drop
   the parameter entirely.

A combined source change would simplify `runProc`:

```ts
function runProc(
  cmd: string,
  args: string[],
  opts: { stdinData?: string; timeoutMs: number },  // timeoutMs now required
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { proc.kill('SIGKILL') }, opts.timeoutMs)
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    if (opts.stdinData != null) { proc.stdin.write(opts.stdinData, 'utf-8'); proc.stdin.end() }
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}
```

Option (1) plus the inline `setTimeout` is the cleanest fix.

## Pinning test

None. The unreachable arms cannot be reached without source
modifications (the call sites hardcode `timeoutMs`, and `stdinData` is
never passed by the existing tests). The `code ?? 1` IS reached and
asserted via the timeout-kill test.

The existing `voice-routes.test.ts` "kills the proc when timeoutMs is
exceeded" test exercises the setTimeout/kill/clearTimeout path and the
`code ?? 1` fallback (kill sets code=null).

## Suggested direction

Per the combined snippet above. Three guards removed, all unreachable.

Per task rule "NEVER modify src/web/routes/voice.ts" this requires
an explicit override from the user.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
