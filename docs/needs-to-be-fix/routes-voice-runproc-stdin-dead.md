# src/web/routes/voice.ts: runProc has two unreachable defensive branches

## Location

`src/web/routes/voice.ts:79` and `src/web/routes/voice.ts:81` — inside the
private `runProc` helper used by every route that needs to shell out.

## Excerpt

```ts
65: function runProc(
66:   cmd: string,
67:   args: string[],
68:   opts: { stdinData?: string; timeoutMs?: number } = {},
69: ): Promise<{ stdout: string; stderr: string; code: number }> {
70:   return new Promise((resolve) => {
71:     const proc = spawn(cmd, args, { shell: false })
72:     let stdout = ''
73:     let stderr = ''
74:     const timer = opts.timeoutMs
75:       ? setTimeout(() => { proc.kill('SIGKILL') }, opts.timeoutMs)
76:       : null
77:     proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
78:     proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
79:     if (opts.stdinData != null) { proc.stdin.write(opts.stdinData, 'utf-8'); proc.stdin.end() }
80:     proc.on('close', (code) => {
81:       if (timer) clearTimeout(timer)
```

## Problem

Two branches in this function are unreachable from the SUT's own call sites:

1. **`opts.stdinData != null` truthy branch (line 79)** — every caller
   invokes `runProc(cmd, args, { timeoutMs })` and drops the `stdinData`
   slot. `_vtools.py` reads its arguments from `argv`, never from stdin.
   The hit branch is dead.

   - `transcribeVoiceFile` line 103
   - `tryHandleVoice` `/api/voice/directive` line 146
   - `tryHandleVoice` `/api/voice/tts` lines 244-248
   - `tryHandleVoice` `/api/voice/install` depCheck lines 276-281

2. **`timer` falsy branch (line 81 else)** — same four call sites all pass
   `{ timeoutMs: <positive ms> }`, so `timer` is always a `Timeout` handle
   when `proc.on('close')` fires. The else branch (skipping `clearTimeout`)
   is dead.

The fire-and-forget install script at `tryHandleVoice` `/api/voice/install`
spawns `install-voice.sh` DIRECTLY with `spawn(...)`, NOT through `runProc`,
so neither branch is reachable from there either.

## Failure scenario

The voice-routes test suite cannot hit 100% statement coverage because v8
flags lines 79 and the else-arm of line 81 as uncovered:

```
File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
voice.ts  |  98.98  |   98.2   |   100   |   100   | 74-81
```

Both highlighted spots land on the two unreachable branches above.

## Suggested fix

Pick one of:

1. **Drop the dead code.** Remove `opts.stdinData` entirely; remove the
   `null` arm of the timer assignment and the `if (timer)` guard around
   `clearTimeout` (it can become a plain `clearTimeout(timer)` since it
   is always set).
2. **Make the branches live.** Wire stdin to one of the call sites (e.g.
   pipe a Future-message into `_vtools.py speak`); and let at least one
   call site omit `timeoutMs` (the install script, for example, has its
   own 90-minute watchdog in `_vtools.py`).

Until then, both branches are reported as coverage gaps and the global
100% threshold fails.

## Resolution

MD retired; the source code was already simplified in an earlier
commit. `src/web/routes/voice.ts:65-83` now declares
`opts: { stdinData: string; timeoutMs: number }` (both fields
required) and unconditionally writes stdin, sets the SIGKILL timer,
and clears it on close. The defensive `if (opts.stdinData != null)`
branch and the falsy-`timer` arm flagged by this MD no longer exist.
A complementary fix in `src/__tests__/voice-routes.test.ts:492-496`
removes the now-stale "no stdinData" comment that pointed at the
deleted defensive guard.
