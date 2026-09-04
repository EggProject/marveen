# Implementation Plan — test/baseline Tight Cycle

**Cycle scope:** bug fixes (A1, A2), defensive-branch removals (B1, B2), MD cleanup (C1-C6).
**User overrides granted for this cycle:** `src/web.ts` (A1), `src/web/agent-worker.ts` (A2).

---

## A1. `web-port-reclaim-failure-leaves-unbound`

**MD:** `docs/needs-to-be-fix/web-port-reclaim-failure-leaves-unbound.md`
**File:** `src/web.ts`

### Bug analysis (verified at HEAD)

`src/web.ts:274-276` currently is:

```ts
} catch (e) {
  logger.error({ err: e }, 'Port-reclaim failed')
}
```

The sibling terminal branch at `src/web.ts:270-272` already calls `process.exit(1)` when no reclaimable node process is found:

```ts
} else {
  logger.error({ port }, 'Port foglalt de nem talaltunk felszabadithato node processt -- kilepes')
  process.exit(1)
}
```

When the `execSync`/`execFileSync` calls throw (lsof timeout, shell spawn EAGAIN, ENOMEM, etc.), the catch logs and returns. The process stays alive with no listener and no exit — the dashboard is deaf and the supervisor sees a healthy process. The 7-min self-heal watchdog at `src/web.ts:310-323` eventually rescues this, but the known-dead case waits the full grace instead of exiting immediately like its sibling `victims.length === 0` path does.

### Exact source diff (`src/web.ts:274-276`)

Replace:

```ts
      } catch (e) {
        logger.error({ err: e }, 'Port-reclaim failed')
      }
```

With:

```ts
      } catch (e) {
        logger.error({ err: e }, 'Port-reclaim failed -- kilepes')
        process.exit(1)
      }
```

### Exact test diff (`src/__tests__/web-server.test.ts:921-931`)

Current test:

```ts
  it('logs when the reclaim itself throws', async () => {
    const srv = await boot()
    H.execSync.mockImplementation(() => { throw new Error('lsof boom') })

    emitInUse(srv)

    expect(H.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Port-reclaim failed',
    )
  })
```

After the fix, the assertion must additionally check `process.exit(1)` was called. The harness already tracks `exitCalls` (`web-server.test.ts:286, 401`):

```ts
  it('logs when the reclaim itself throws and exits(1)', async () => {
    const srv = await boot()
    H.execSync.mockImplementation(() => { throw new Error('lsof boom') })

    emitInUse(srv)

    expect(H.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Port-reclaim failed -- kilepes',
    )
    expect(exitCalls).toEqual([1])
  })
```

The test description change ("...and exits(1)") is optional but helps documentation. Both the log message text and the exit-call assertion are required for the fix to be observable.

---

## A2. `agent-worker-settings-symlink-preserve`

**MD:** `docs/needs-to-be-fix/agent-worker-settings-symlink-preserve.md`
**File:** `src/web/agent-worker.ts`

### Bug analysis (verified at HEAD)

`src/web/agent-worker.ts:378-392`:

```ts
const settingsPath = join(ctx.configDir, 'settings.json')
let current: WorkerSettings = {}
const sst = lstatSyncSafe(settingsPath)
if (sst?.isSymbolicLink()) {
  rmSync(settingsPath, { force: true })              // <-- line 380: drops target content
} else if (existsSync(settingsPath)) {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as WorkerSettings
  } catch { /* rewrite */ }
}
const enabledPlugins: Record<string, boolean> = { ...(current.enabledPlugins ?? {}) }
for (const p of WORKER_DISABLED_PLUGINS) enabledPlugins[p] = false
writeFileSync(settingsPath, JSON.stringify({ ...current, enabledPlugins, skipDangerousModePermissionPrompt: true }, null, 2) + '\n')
```

When `settings.json` is a symlink to the shared `~/.claude/settings.json`, the symlink branch `rmSync`s the symlink without reading the target's content. The `else if (existsSync(...))` branch is skipped because the file no longer exists. `current` stays as `{}`. The final `writeFileSync` writes an empty `current` spread, losing every hook/permission/model field the shared `settings.json` carried.

### Exact source diff (`src/web/agent-worker.ts:378-380`)

Replace:

```ts
const sst = lstatSyncSafe(settingsPath)
if (sst?.isSymbolicLink()) {
  rmSync(settingsPath, { force: true })
} else if (existsSync(settingsPath)) {
```

With (option (a) from the MD, surgical change matching the existing pattern in the symlink loop above):

```ts
const sst = lstatSyncSafe(settingsPath)
if (sst?.isSymbolicLink()) {
  try {
    const target = readlinkSync(settingsPath)
    const parsed = JSON.parse(readFileSync(target, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as WorkerSettings
  } catch { /* rewrite */ }
  rmSync(settingsPath, { force: true })
} else if (existsSync(settingsPath)) {
```

This reads the linked target's content BEFORE deleting it, populates `current` with the shared settings (hooks, permissions, model), then removes the symlink. The downstream `writeFileSync` at line 392 spreads `current` so the hooks are preserved.

NOTE: `readlinkSync` is already imported (verified at `src/__tests__/agent-worker-full.test.ts:16`, which destructures imports for testing — but the production `src/web/agent-worker.ts` import block must be checked. If `readlinkSync` is not currently imported in `agent-worker.ts`, add it to the import list alongside `lstatSync`, `rmSync`, etc. Verify before applying.

### Exact test diff (`src/__tests__/agent-worker-full.test.ts:520-532`)

Current test (which currently pins the BUGGY behavior):

```ts
it('replaces a symlinked settings.json (the shared copy) with an owned file', () => {
  seedSharedClaude({ settings: { hooks: { Stop: [] } } })
  AW.ensureWorkerCwd()
  const cfg = join(H.home, '.marveen-worker', '.claude-config')
  expect(lstatSync(join(cfg, 'settings.json')).isSymbolicLink()).toBe(false)
  const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
  // Pinning the CURRENT (buggy) behaviour: when the linked settings.json
  // is a symlink, the rmSync branch deletes it without reading its
  // content first, so the hooks key is lost. See bug MD for direction.
  expect(s.enabledPlugins.telegram).toBe(false)
  expect(s.enabledPlugins['slack-channel']).toBe(false)
  expect(s.skipDangerousModePermissionPrompt).toBe(true)
})
```

After the fix, change the test to assert the CORRECT behavior (hooks preserved):

```ts
it('replaces a symlinked settings.json (the shared copy) with an owned file, preserving shared hooks', () => {
  seedSharedClaude({ settings: { hooks: { Stop: [] } } })
  AW.ensureWorkerCwd()
  const cfg = join(H.home, '.marveen-worker', '.claude-config')
  expect(lstatSync(join(cfg, 'settings.json')).isSymbolicLink()).toBe(false)
  const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
  // After the fix: the symlinked target's content is read BEFORE rmSync, so
  // the hooks key (and any other shared settings) survives into the owned file.
  expect(s.hooks).toEqual({ Stop: [] })
  expect(s.enabledPlugins.telegram).toBe(false)
  expect(s.enabledPlugins['slack-channel']).toBe(false)
  expect(s.skipDangerousModePermissionPrompt).toBe(true)
})
```

---

## B1. `channel-monitor-unreachable-defensive-branches`

**MD:** `docs/needs-to-be-fix/channel-monitor-unreachable-defensive-branches.md`
**File:** `src/web/channel-monitor.ts`

### B1 verification of each cited line

| Line | Code | Reachable? | Fix |
|------|------|------------|-----|
| 405 | `const landed = prevSig != null ? submitLanded(prevSig, captureParkedInputView(session)) : false` | `: false` arm UNREACHABLE — `performStuckInputAction` only called from `recoverStuckInputForSession:332`, which passes `sig` (always non-null because line 311 sets it from `pane != null` and the line 313 guard requires `pane != null`) | Drop ternary, tighten signature |
| 1060 | `const paneState = paneContent != null ? detectPaneState(paneContent) : null` | `: null` arm reachable only via a custom mock sequence where `capturePane` returns null on this call. Existing test `channel-monitor-baseline.test.ts:652-682` already drives it (mock `capturePane.mockReturnValue(null)`) — the test comment says "the rest of the function falls through with no stuck-input log fired". So this IS REACHABLE in the suite. | Drop the fix per MD, OR keep as belt-and-braces |
| 1248 | `const ageMin = Math.round((ageMs ?? 0) / 60000)` | `?? 0` UNREACHABLE — `shouldRespawnForStaleKeepalive` returns false when `keepaliveAgeMs == null` (line 1142 area), so `ageMs` is provably non-null when line 1248 runs | Drop `?? 0`, tighten type |
| 1285 | `if (providerLabel === 'telegram' && !marveenDownState.conflictProbed) {` | **Verified analysis below** — the else arm IS UNREACHABLE | Drop `&& !marveenDownState.conflictProbed` and the trailing `marveenDownState.conflictProbed = true` |
| 1326 | `const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince` | `?? downSince` UNREACHABLE — `stageStartedAt = now` is set on the line 1318-1319 transition to 'save', unconditionally, before line 1325 is reached | Use `!` non-null assertion |
| 1327 | `if (now - saveStartedAt < SAVE_WINDOW_MS) return` | IF arm UNREACHABLE — `SAVE_WINDOW_MS = 60_000` (line 475) and `stageStartedAt` was set on the tick that transitioned INTO 'save'; the next cascade tick is `setInterval(60_000)` later (line 1785), so `now - saveStartedAt` is exactly `60_000`, never strictly less. The `<` comparison means the fall-through branch always fires. | Drop the comparison or widen to `<=`. Per MD option: drop |
| 1336 | `const resumeStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince` | Same structural reason as 1326 — `stageStartedAt = now` is set at line 1329 unconditionally before line 1335 is reached | Use `!` non-null assertion |

### B1.5: Line 1285 verification (per task requirement to verify the else arm)

Looking at the surrounding code (`src/web/channel-monitor.ts:1277-1310`):

```ts
if (!marveenDownState) {                                  // 1277
  marveenDownState = { downSince, stage, lastAlertAt, softAttempts }  // 1278 -- fresh state, conflictProbed=undefined
  ...
  if (providerLabel === 'telegram' && !marveenDownState.conflictProbed) {  // 1285
    marveenDownState.conflictProbed = true                // 1286
    ...
  }
  if (softReconnectMarveen()) marveenDownState.softAttempts += 1  // 1309
  return                                                  // 1310
}
```

**Line 1285 is INSIDE the `if (!marveenDownState)` block.** This means line 1285 only runs when `marveenDownState` was just nulled and a fresh object was created at line 1278 — a fresh object has `conflictProbed = undefined`.

- `!marveenDownState.conflictProbed` = `!undefined` = `true` — always, when this line runs.
- The IF condition's second operand is therefore always true. The else arm (implicit fall-through, since there's no explicit `else`) is unreachable.
- After the fresh-cascade entry, subsequent ticks within the same cascade SKIP the entire `if (!marveenDownState)` block (because `marveenDownState` is now non-null), so line 1285 doesn't even run on those ticks.

**Conclusion: line 1285's else arm IS dead.** The MD's analysis is correct. The task's CAUTION note applies — keep the body of the real telegram probe, drop the `!marveenDownState.conflictProbed` redundant check (since it's always true when reached).

The existing test at `channel-monitor-baseline.test.ts:561-594` ("skips the conflict probe on the second down-spell") is misnamed/misleading — it does NOT actually exercise the else arm of line 1285. The test passes because `shouldEscalateMarveenDown` (gated by `MARVEEN_DOWN_CONFIRM_MS = 120_000`) hasn't elapsed on the re-down cascade, so `handleMarveenDown` isn't even called. The test still passes after the fix (because the fix doesn't change runtime behavior — the probe only fires when `handleMarveenDown` runs, which is gated).

### Exact source diffs

**Line 405 (`src/web/channel-monitor.ts:405`):**

Current:

```ts
    const landed = prevSig != null ? submitLanded(prevSig, captureParkedInputView(session)) : false
```

Replace with:

```ts
    const landed = submitLanded(prevSig, captureParkedInputView(session))
```

Then tighten the function signature at line 343 (`performStuckInputAction`) — change `prevSig: string | null` to `prevSig: string`. Also update the JSDoc / comments if any. The only caller at line 332 passes `sig`, which is `string | null` from line 311 — TypeScript will flag the `null` case unless we tighten `sig` at the call site. At line 311: `const sig = pane != null ? stuckInputSignature(pane) : null` — but the caller's `if (decision.recover && pane != null)` guard at line 313 guarantees `pane != null`, so `sig` is always non-null at line 332. The TypeScript inference here may need an explicit `as string` or a non-null assertion to satisfy strict mode, OR we can rewrite line 311 to drop the `: null` arm (which would tighten the type):

```ts
// Line 311 -- current:
const sig = pane != null ? stuckInputSignature(pane) : null
// After: only meaningful when pane != null; drop the : null arm:
const sig = stuckInputSignature(pane)
```

But `stuckInputSignature` may accept `string | null`. Verify the function signature before deciding.

**Safer option:** Just drop the `: false` ternary and add `as string` (or `!`) on the `prevSig` use:

```ts
    const landed = submitLanded(prevSig!, captureParkedInputView(session))
```

This keeps the type signature unchanged (no ripple through the file) and documents the invariant. The non-null assertion is honest: `prevSig` is provably non-null at this point.

**Line 1060 (`src/web/channel-monitor.ts:1060`):**

Per the MD's caveat ("Marked as structurally dead only after a focused review: the branch IS reachable with a precisely-sequenced mock"), and the existing test at `channel-monitor-baseline.test.ts:652-682` that already drives the `: null` arm — **leave line 1060 unchanged**. Removing it would require dropping the existing test or refactoring `capturePane` to be guarded upstream, both of which are out of scope for this cycle. The MD itself flags this as debatable.

If we DO want to remove the defensive branch, the surgical fix is:

```ts
// Current:
const paneContent = capturePane(MAIN_CHANNELS_SESSION)
const paneState = paneContent != null ? detectPaneState(paneContent) : null

// After:
const paneContent = capturePane(MAIN_CHANNELS_SESSION)
const paneState = detectPaneState(paneContent ?? '')
```

But this would require updating `detectPaneState`'s signature or providing a sensible "" default. The existing test would also need updating.

**Decision for B1 line 1060: SKIP** — the `: null` arm is reachable via the existing test, so the MD's claim of "dead" is incorrect in the suite's context. Skip the fix for line 1060.

**Line 1248 (`src/web/channel-monitor.ts:1248`):**

Current:

```ts
  const ageMin = Math.round((ageMs ?? 0) / 60000)
```

Replace with:

```ts
  const ageMin = Math.round(ageMs / 60000)
```

Then tighten the variable type. Locate where `ageMs` is declared (likely above `Math.round`) and change from `number | null` to `number`. The `shouldRespawnForStaleKeepalive` function returns `number | null` — TypeScript inference will need updating if the caller also gets `ageMs`.

Verify the type narrowing is consistent. If `ageMs` is declared `let ageMs: number | null = null` before the call to `shouldRespawnForStaleKeepalive`, then there's no upstream guard that narrows it to `number` when the if-branch fires. The MD's claim is that `shouldRespawnForStaleKeepalive` returns `false` (not `null`) when `keepaliveAgeMs == null` — but if it returns `number | null | false`, the narrowing needs care.

**Safe option:** Use `as number` or `!` on the read:

```ts
  const ageMin = Math.round((ageMs ?? 0) / 60000)
  // unchanged, but mark the dead arm with a comment:
// (ageMs ?? 0) — `ageMs` is provably non-null here because
// shouldRespawnForStaleKeepalive() returns false (not null) when
// keepaliveAgeMs == null. The `?? 0` is structurally unreachable.
```

This is NOT a removal of dead code; it's a documentation pass. For this cycle, prefer the **removal** option per the cycle scope ("defensive-branch removals"):

```ts
  const ageMin = Math.round(ageMs / 60000)
```

If TypeScript flags `ageMs: number | null`, add `!`:

```ts
  const ageMin = Math.round(ageMs! / 60000)
```

Verify the surrounding context for `ageMs` declaration before finalizing the diff.

**Line 1285 (`src/web/channel-monitor.ts:1285-1286`):**

Current:

```ts
    if (providerLabel === 'telegram' && !marveenDownState.conflictProbed) {
      marveenDownState.conflictProbed = true
      const tokenPath = join(channelStateDir(providerLabel, PROJECT_ROOT), '.env')
```

Replace with:

```ts
    if (providerLabel === 'telegram') {
      const tokenPath = join(channelStateDir(providerLabel, PROJECT_ROOT), '.env')
```

Then also drop the `conflictProbed?: boolean` field from the `MarveenDownState` type definition at `src/web/channel-monitor.ts:472`:

```ts
type MarveenDownState = {
  downSince: number
  stage: MarveenRecoveryStage
  lastAlertAt: number
  softAttempts: number
  stageStartedAt?: number
  // conflictProbed?: boolean  -- DELETED: structurally unreachable; the entire
  // if-block only runs on a fresh marveenDownState where this would always be
  // undefined. See docs/needs-to-be-fix/channel-monitor-unreachable-defensive-branches.md.
}
```

Note: also delete `marveenDownState.conflictProbed = true` at line 1286 (now removed via the diff above). The existing test at `channel-monitor-baseline.test.ts:548` (`expect(m.probeTelegramConflict).toHaveBeenCalledTimes(1)`) continues to pass.

**Lines 1326 and 1336 (`src/web/channel-monitor.ts:1326, 1336`):**

Current (1326):

```ts
    const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
```

Replace with:

```ts
    const saveStartedAt = marveenDownState.stageStartedAt!
```

Current (1336):

```ts
    const resumeStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince
```

Replace with:

```ts
    const resumeStartedAt = marveenDownState.stageStartedAt!
```

Then optionally tighten the type definition: change `stageStartedAt?: number` to `stageStartedAt: number` (line 469). But this requires updating the type's construction site at line 1278 to initialize `stageStartedAt`. Verify the construction site before finalizing.

If we want to keep the type definition permissive (in case `stageStartedAt` is added in other contexts), keep the `?` and just use `!` at the reads. The non-null assertion documents the invariant at the use site.

**Line 1327 (`src/web/channel-monitor.ts:1327`):**

The MD's claim: `SAVE_WINDOW_MS = 60_000`, the next cascade tick is exactly `setInterval(60_000)` later (line 1785), so `now - saveStartedAt` is exactly `60_000`, never strictly less. The `<` comparison means the fall-through branch fires.

Current:

```ts
    if (now - saveStartedAt < SAVE_WINDOW_MS) return
```

Two options from the MD:

Option 1: drop the comparison (IF arm is dead)
```ts
    // (no-op: now - saveStartedAt is exactly SAVE_WINDOW_MS by construction,
    // because the next cascade tick is setInterval(60_000) and stageStartedAt
    // was set on the previous tick's transition into 'save'. The fall-through
    // always fires.)
```

Option 2: widen to `<=`
```ts
    if (now - saveStartedAt <= SAVE_WINDOW_MS) return
```

**Recommendation: Option 1 (drop the comparison entirely).** The IF is provably dead and the comment documents why. Removing it cleanly eliminates the dead arm without changing semantics.

---

## B2. `message-router-dead-defensive-branches` line 180

**MD:** `docs/needs-to-be-fix/message-router-dead-defensive-branches.md`
**File:** `src/web/message-router.ts`

### B2 verification (mechanical inversion)

`src/web/message-router.ts:174-185` (current state at HEAD):

```ts
function stampTraceOnMessage(msg: AgentMessage, nowMs: number): { trace_id: string; span_id: string; parent_span_id: string | null } {
  const inherited = deliveredTraceCtx.get(msg.from_agent)
  const trace_id = inherited?.trace_id ?? generateTraceId()
  const span_id  = generateSpanId()
  const parent_span_id = inherited?.span_id ?? null
  const stamped = stampMessageTrace(msg.id, trace_id, span_id, parent_span_id)
  if (stamped) {
    const operation = `${msg.from_agent}->${msg.to_agent}`
    upsertOtelSpan({ trace_id, span_id, parent_span_id, agent_id: msg.from_agent, operation, start_ms: nowMs, attributes: null })
  }
  return { trace_id, span_id, parent_span_id }
}
```

The inversion is mechanical — flip `if (stamped)` to `if (!stamped) return; ...`. The MD confirms this is a stylistic inversion, not dead-code removal, and per the partial-resolution in commit `ba6faf8` (2026-08-19), the happy-path test at `message-router-full.test.ts:848` passes either way.

### Exact source diff (`src/web/message-router.ts:179-184`)

Current:

```ts
  const stamped = stampMessageTrace(msg.id, trace_id, span_id, parent_span_id)
  if (stamped) {
    const operation = `${msg.from_agent}->${msg.to_agent}`
    upsertOtelSpan({ trace_id, span_id, parent_span_id, agent_id: msg.from_agent, operation, start_ms: nowMs, attributes: null })
  }
  return { trace_id, span_id, parent_span_id }
```

Replace with:

```ts
  const stamped = stampMessageTrace(msg.id, trace_id, span_id, parent_span_id)
  if (!stamped) return { trace_id, span_id, parent_span_id }
  const operation = `${msg.from_agent}->${msg.to_agent}`
  upsertOtelSpan({ trace_id, span_id, parent_span_id, agent_id: msg.from_agent, operation, start_ms: nowMs, attributes: null })
  return { trace_id, span_id, parent_span_id }
```

This makes the rare race path explicit (early-return on DB-write failure) and gives the if-body the same structural-coverage treatment as the happy path.

---

## C1-C6. MD cleanup (mark already-resolved as Resolved)

**Resolution commits identified via git log:**

| MD | File:Line | Resolved by |
|----|-----------|-------------|
| `channel-monitor-agentDownSince-fallback` | `src/web/channel-monitor.ts:1647` | **2026-08-14 `c2b4ea2`** — `refactor: drop 21 unreachable defensive branches and 6 synthetic tests` |
| `channel-monitor-agentName-fallbacks` | `src/web/channel-monitor.ts:1455,1494` | **2026-08-14 `08d7508`** — `refactor: delete dead helpers and tighten Target.agentName type` |
| `channel-monitor-test-holes` | `src/__tests__/channel-monitor.test.ts` (it.skip removal) | **2026-08-08 `1522111`** — `test: stabilize 12 it.skip regression tests in channel-monitor suites` |
| `test-suite-guard-marker-only-blind` | `src/__tests__/setup/assert-not-live-install.ts:26-30` | **2026-08-06 `393b3b6`** — `fix(test): tighten live-install guard to whole-store detection; file STORE_DIR pollution + LLM audit` |
| `test-suite-macos-only-portability` | 7 root causes across `src/web/agent-scaffold.ts`, `src/web/ssh-tmux.ts`, `src/web/routes/docs.ts`, `src/web/reauth-healer.ts`, `src/web/federation/local-catalog.ts`, 10 module-level `resolveFromPath` call sites | **2026-08-14 `69244f0`** — `fix(test): make the baseline suite pass on Linux, not just macOS` |
| `federation-routes-fedpeer-required-type-narrow-deferred` | `src/web/routes/federation.ts:298,329` (deferred, no code change) | **N/A — doc-only deferral, no commit needed** |

### Exact MD edits (one per file)

For each MD, add a status banner at the top:

```markdown
**Status:** RESOLVED

**Resolved by:** <date> <sha> — <commit subject>
```

Or per the MD's existing style (e.g., `message-router-dead-defensive-branches.md:185` uses `Partially resolved: <date> <sha>`):

```markdown
**Status:** RESOLVED — 2026-08-14 c2b4ea2
```

The user has indicated preference for `Resolved: <pending>` in INDEX.md (per CLAUDE.md convention: no SHA in docs commit, follow-up commit ref). The MD itself can carry the SHA; INDEX.md rows use `<pending>` until a follow-up commit pins it.

### INDEX.md updates (`docs/needs-to-be-fix/INDEX.md`)

Five rows need updates (the sixth, `test-suite-guard-marker-only-blind`, gets an actual SHA — 2026-08-06 — since it's already known):

**Row 31 (High): `test-suite-guard-marker-only-blind`**

Current:
```
| `test-suite-guard-marker-only-blind` | `src/__tests__/setup/assert-not-live-install.ts:26-30` (pre-2026-08-06) | ... | — |
```

Replace last column with: `Resolved: 2026-08-06 393b3b6`

**Row 38 (Medium): `web-port-reclaim-failure-leaves-unbound`**

This MD is the SUBJECT of A1's fix. After A1 lands, this row becomes Resolved. For this cycle's INDEX.md update (assuming A1 lands in the same cycle), replace `—` with `Resolved: <pending>` (per CLAUDE.md convention).

**Row 54 (Medium): `test-suite-macos-only-portability`**

Current:
```
| `test-suite-macos-only-portability` | 7 causes across ... | ... | — |
```

Replace last column with: `Resolved: 2026-08-14 69244f0`

**Row 117 (Baseline addenda): `channel-monitor-test-holes`**

Current:
```
| `channel-monitor-test-holes` | channel-monitor.ts: pinned test holes in handleMarveenDown cascade + post-resume guard | — |
```

Replace last column with: `Resolved: 2026-08-08 1522111`

**Row 117 (Baseline addenda): `channel-monitor-unreachable-defensive-branches`**

Current:
```
| `channel-monitor-unreachable-defensive-branches` | channel-monitor.ts: seven unreachable defensive branches block 100% branch coverage | — |
```

This MD is the SUBJECT of B1's fix. After B1 lands (or partially — only some of the 7 lines), this row gets `Resolved: <pending>` for the partial-resolution case.

**Row 131 (Baseline addenda): `message-router-dead-defensive-branches`**

Current:
```
| `message-router-dead-defensive-branches` | message-router.ts: three dead defensive branches block 100% branch coverage | Partially resolved: 2026-08-19 ba6faf8 |
```

After B2 lands (line 180 inverted), this becomes fully resolved. Replace with: `Resolved: 2026-08-21 <sha>` (where <sha> is this cycle's commit).

**Row 218 (Orphan addenda): `federation-routes-fedpeer-required-type-narrow-deferred`**

Current:
```
| `federation-routes-fedpeer-required-type-narrow-deferred` | `src/web/routes/federation.ts:298,329` | fedPeer type-narrow deferred | - | - |
```

This is doc-only deferral. Add to the MD's status banner (no code change): `**Status:** DEFERRED` — the MD itself documents the deferral. INDEX.md row stays as-is with `-` (already correct).

**Row 214 (Orphan addenda): `channel-monitor-agentDownSince-fallback`**

Current:
```
| `channel-monitor-agentDownSince-fallback` | `src/web/channel-monitor.ts:1647` | agentDownSince.get() ?? Date.now() fallback is unreachable | - | 2026-08-14 c2b4ea2 |
```

Already has the SHA. Verify the INDEX entry matches.

**Row 215 (Orphan addenda): `channel-monitor-agentName-fallbacks`**

Current:
```
| `channel-monitor-agentName-fallbacks` | `src/web/channel-monitor.ts:1455,1494` | t.agentName ?? t.session fallback is unreachable | - | 2026-08-14 08d7508 |
```

Already has the SHA. Verify the INDEX entry matches.

The C1-C6 cleanup doesn't require source-code edits — it's documentation-only. The "Status: RESOLVED" banner is added to each MD file, and the INDEX.md table rows get the resolved-date / SHA in the last column.

---

## Risks and concerns

1. **A1 (web.ts port-reclaim):** the existing test at `web-server.test.ts:921-931` ONLY asserts the log call. After the fix, the test must additionally assert `process.exit(1)`. Both the log message string change and the exit assertion are required. If only one is changed, the test will fail.

2. **A2 (agent-worker.ts symlink preserve):** the existing test at `agent-worker-full.test.ts:520-532` pins the BUGGY behavior with an explicit comment ("Pinning the CURRENT (buggy) behaviour..."). The test MUST be updated to assert the correct behavior (hooks preserved). If the test isn't updated, it will fail after the fix.

3. **B1 line 405:** if the `prevSig` parameter type is tightened from `string | null` to `string`, TypeScript may flag other call sites. Safer option: keep the signature and use `!` non-null assertion at the use site. Verify before applying.

4. **B1 line 1248:** the `ageMs` variable type and the `shouldRespawnForStaleKeepalive` return type need careful analysis. If the function signature returns `number | null | false`, the `?? 0` may actually be reachable in some edge case. Verify before applying.

5. **B1 line 1060:** the `: null` arm IS reachable via the existing test mock sequence (`channel-monitor-baseline.test.ts:652-682`). SKIP this fix — the MD's claim of "dead" is incorrect in the test suite's context.

6. **B1 line 1285:** verification confirms the MD's analysis. The fix is safe. The existing test at `channel-monitor-baseline.test.ts:561-594` is misnamed but doesn't break.

7. **B1 lines 1326, 1336:** the `stageStartedAt?: number` type can stay optional (since the construction site at line 1278 doesn't initialize it), and the `!` non-null assertion is honest. Verify the construction site before tightening the type.

8. **B1 line 1327:** dropping the comparison is a semantic change in spirit (the comparison becomes a no-op), but the IF arm is provably dead, so removing it doesn't change behavior. Verify with the existing test at `channel-monitor-baseline.test.ts:491-515` (which asserts the resume stage early-return — different code path).

9. **B2 (message-router.ts line 180):** purely mechanical inversion. The existing test at `message-router-full.test.ts:848` continues to pass.

10. **TypeScript tolerance:** the cycle-wide budget is +5 typecheck errors (per the federation MD's note). Each removal that tightens types may push the count. If the budget is exceeded, revert to the `!` non-null assertion approach (less invasive) or to a documentation-comment-only approach.

11. **CLAUDE.md convention:** per the user's note, INDEX.md rows should use `Resolved: <pending>` (no SHA in the docs commit), with the SHA filled in a follow-up commit. The MD files themselves can carry the SHA directly.

---

## Commit sequence

Per task rule "one fix per commit, final docs commit":

1. **Commit 1 (A1):** `fix(web): make port-reclaim failure terminal with process.exit(1)` — src/web.ts:274-276
2. **Commit 2 (A1 test):** `test(web-server): assert process.exit(1) when port-reclaim throws` — src/__tests__/web-server.test.ts:921-931
3. **Commit 3 (A2):** `fix(agent-worker): preserve shared settings.json hooks when symlink is replaced` — src/web/agent-worker.ts:378-380
4. **Commit 4 (A2 test):** `test(agent-worker): assert hooks preserved when symlinked settings.json is replaced` — src/__tests__/agent-worker-full.test.ts:520-532
5. **Commit 5 (B1a):** `refactor(channel-monitor): drop 5 unreachable defensive branches (lines 405, 1248, 1285, 1326, 1336)` — src/web/channel-monitor.ts (skip 1060, 1327 for separate commits if needed)
6. **Commit 6 (B1b):** `refactor(channel-monitor): drop unreachable IF at line 1327 (now - saveStartedAt is exactly SAVE_WINDOW_MS)` — src/web/channel-monitor.ts:1327
7. **Commit 7 (B2):** `refactor(message-router): invert if(stamped) at line 180 for structural-coverage parity` — src/web/message-router.ts:179-184
8. **Commit 8 (docs):** `docs: mark 6 already-resolved MDs as RESOLVED + update INDEX.md` — 6 MD files + docs/needs-to-be-fix/INDEX.md

Alternative: combine B1a and B1b into one commit (5+1 = 6 branches removed). The user's preference is "one fix per commit" but the B1 items are tightly related (all in the same file, all defensive-branch removals). Decide during implementation.

For each commit, after applying:
- Run the targeted test file (`bun --bun vitest run src/__tests__/<file>`)
- Run the full suite (`bun --bun vitest run`) to confirm no regression
- Run typecheck (`bun run typecheck`) to confirm no new TS errors

---

## Critical Files for Implementation

- /Users/eggp/marveen-develop/test-baseline/src/web.ts
- /Users/eggp/marveen-develop/test-baseline/src/web/agent-worker.ts
- /Users/eggp/marveen-develop/test-baseline/src/web/channel-monitor.ts
- /Users/eggp/marveen-develop/test-baseline/src/web/message-router.ts
- /Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md
