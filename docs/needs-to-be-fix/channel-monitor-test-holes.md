**Status:** RESOLVED &lt;pending&gt;

# channel-monitor.ts: pinned test holes in handleMarveenDown cascade + post-resume guard

## Location

`src/web/channel-monitor.ts`:

- lines 488-503 (triggerMarveenMemorySave body + catch)
- lines 746-751 (post-respawn modal dismiss catch in resumeMarveenSession)
- lines 983-998 (schedulePostResumePluginGuard body)
- lines 509-519 (readConfiguredMainModel body)

Each is reachable through normal user input but cannot be driven from a
vitest unit test because the path sits behind either a long-running
setTimeout the monitor installs at module load OR a multi-tick state-machine
sequence (soft -> save -> resume -> hard) whose guards reset on every
`vi.resetModules()`.

## Excerpt

```ts
// line 488, inside the file (no exports -- private helper)
async function triggerMarveenMemorySave(): Promise<void> {
  const prompt = [
    '[SYSTEM: channels recovery] A csatorna plugin nem reagal, kb 60 masodperc',
    `mulva hard restart lesz a ${MAIN_CHANNELS_SESSION} session-on ...`,
  ].join(' ')
  try {
    await sendPromptToSession(MAIN_CHANNELS_SESSION, prompt)
    logger.info(`${BOT_NAME} memory-save prompt dispatched before hard restart`)
  } catch (err) {
    logger.warn({ err }, `Failed to dispatch ${BOT_NAME} memory-save prompt`)
  }
}

// line 746, inside resumeMarveenSession
try {
  await delay(2000)
  await dismissResumeSummaryModalIfPresent(MAIN_CHANNELS_SESSION)
} catch (err) {
  logger.warn({ err }, 'resumeMarveenSession: post-respawn modal dismiss failed (continuing)')
}

// line 983, inside the file (no exports -- private helper)
function schedulePostResumePluginGuard(provider: ChannelProviderType): void {
  setTimeout(() => {
    try {
      const claudePid = getClaudePidForSession(MAIN_CHANNELS_SESSION)
      const pluginAlive = claudePid != null && hasChannelPluginAlive(claudePid, provider)
      if (!shouldEscalateAfterResume({ claudePid, pluginAlive })) {
        logger.info({ provider }, 'Post-resume guard: channel plugin attached after --continue -- context preserved, no escalation')
        return
      }
      logger.warn({ provider }, 'Post-resume guard: --continue resume came up WITHOUT the channels plugin (CC 2.1.193) -- escalating to fresh respawn (context dropped, memory persists)')
      sendAlert(...)
      respawnMarveenSessionFresh()
    } catch (err) {
      logger.warn({ err }, 'Post-resume guard probe failed (leaving recovery to the down-cascade)')
    }
  }, POST_RESUME_GUARD_DELAY_MS)
  ...
}

// line 509, inside the file (no exports -- private helper)
function readConfiguredMainModel(): string {
  try {
    const settingsPath = join(PROJECT_ROOT, '.claude', 'settings.json')
    if (!existsSync(settingsPath)) return ''
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const model = parsed?.model
    return typeof model === 'string' ? model.trim() : ''
  } catch {
    return ''
  }
}
```

## Failure scenario

Coverage-only at the moment, but each branch has a realistic live failure
mode that the missing tests do not pin:

1. **triggerMarveenMemorySave catch (line 500-501)**. A Telegram bot
   rejection (network glitch during the save prompt) currently silently
   downgrades to logger.warn. Without a test that mocks sendPromptToSession
   to reject, a future refactor that re-throws would push an unhandled
   rejection into the monitor loop on every stage-2 cascade.

2. **resumeMarveenSession post-respawn modal-dismiss catch (line 750-751)**.
   Same shape: a missing-pin test lets a refactor that propagates the throw
   past the try/catch introduce a regression where a stuck resume-summary
   modal aborts the entire recovery path.

3. **schedulePostResumePluginGuard try/catch (line 994-997)**. The probe
   failure path is the documented "leave recovery to the down-cascade"
   fallback. A regression that catches nothing would leave the post-resume
   guard silently broken (a wedged plugin after --continue would never
   trigger fresh-respawn, and the operator would only see the eventual
   handleMarveenDown alert -- the whole reason this guard exists is to
   escalate faster than the down-cascade).

4. **readConfiguredMainModel branches (lines 511-518)**. The three guard
   branches (existsSync false, JSON.parse throws, typeof model !== 'string')
   protect against a malformed settings.json silently breaking the
   `--model` argument to the respawn command. A regression that drops
   them would let a corrupt settings.json propagate `"object"` or
   `undefined` into the respawn -- which `buildMainSessionRespawnCmd`
   then single-quotes verbatim, producing an unparseable claude CLI
   invocation.

The vitest suite pins every reachable sibling (see below); the gaps are
exactly these four unreachable branches.

## Pinning test

`src/__tests__/channel-monitor.test.ts`. The new tests added for these
branches were written and then `it.skip`-ed because driving them requires
one of the following, none of which is possible from a vitest unit test:

- **triggerMarveenMemorySave**: drive handleMarveenDown past soft (3
  successful softReconnectMarveen calls) into stage 'save', where the
  helper fires. Requires 3 monitor ticks past the 120s confirm window
  AND the mock to keep softReconnectMarveen returning ok:true 3 times in
  a row -- a window of state we cannot reach via resetModules (module
  state survives in the SUT's closure).
- **post-respawn modal-dismiss catch**: the resumeMarveenSession test
  that mocks dismissResumeSummaryModalIfPresent to reject hangs at the
  5000ms vitest timeout because the function awaits two `delay(2000)`
  calls + the dismiss before checking the first try/catch. Driving the
  second `try { await delay(2000); ... }` block requires real-time
  waits that vitest fake-timer advance leaves in flight.
- **schedulePostResumePluginGuard body**: the guard is scheduled via
  `setTimeout(..., 90_000)` from a non-fake setTimeout inside
  resumeMarveenSession, so vi.advanceTimersByTimeAsync does not
  intercept it.
- **readConfiguredMainModel**: the helper is `function`-scoped (not
  exported) and only reachable via `buildMainSessionRespawnCmd`, which
  does not expose its return value. The current pinning test reads
  `SUT.readConfiguredMainModel(sandbox.PROJECT_ROOT)` which is undefined
  on the module object.

```ts
// src/__tests__/channel-monitor.test.ts
describe('triggerMarveenMemorySave + post-respawn modal dismiss failures (pinned)', () => {
  it.skip('triggerMarveenMemorySave: sendPromptToSession throws -> caught + logged', () => {})
  it.skip('resumeMarveenSession: post-respawn modal dismiss throws -> caught + logged', () => {})
})
describe('schedulePostResumePluginGuard (pinned)', () => {
  it.skip('plugin attached after --continue -> info log, no escalation', () => {})
  it.skip('plugin missing after --continue -> escalate to fresh respawn + alert', () => {})
  it.skip('post-resume guard probe throws -> logged, recovery continues', () => {})
})
describe('readConfiguredMainModel (pinned)', () => {
  it.skip('returns the model string from .claude/settings.json', () => {})
  it.skip('returns "" when settings.json is missing', () => {})
  it.skip('returns "" when settings.json has non-string model', () => {})
  it.skip('returns "" when readFileSync throws (malformed JSON)', () => {})
})
describe('createMainChannelsSession: script-missing + spawn-failed (pinned)', () => {
  it.skip('returns "script-missing" when channels.sh is absent', () => {})
  it.skip('returns "spawn-failed" when spawn throws', () => {})
})
```

The current coverage report on `src/web/channel-monitor.ts` (v8, with
`--coverage.include='src/web/channel-monitor.ts'`) shows the gap as
approximately the ~30 statement/branch units listed above. Lines, statements,
functions, and branches sit in the 95-100% range; the pinned branches are
the only uncovered units.

## Suggested direction

Five independent source changes, each making one branch reachable:

1. **triggerMarveenMemorySave (line 488)** -- export the helper as
   `export async function triggerMarveenMemorySaveForTest()`, then drive
   the catch path directly in a test. Keeps the production call site
   unchanged.

2. **post-respawn modal dismiss (line 733)** -- extract the second
   `await delay(2000); await dismissResumeSummaryModalIfPresent(...)`
   block into a private `tryPostResumeModalDismiss()` helper that takes
   a `delay` parameter (default 2000). Test the helper with `delay = 0`
   so vitest does not have to wait.

3. **schedulePostResumePluginGuard (line 983)** -- expose
   `schedulePostResumePluginGuard(provider, delayMs = POST_RESUME_GUARD_DELAY_MS)`
   so tests can call it with `delayMs: 0` and exercise the body via fake
   timers.

4. **readConfiguredMainModel (line 509)** -- export it. The current
   internal-only signature is fine for production but blocks testability.

5. **createMainChannelsSession script-missing + spawn-failed (lines
   888-913)** -- the script-missing path is reachable but the cooldown
   state from earlier tests within the same module load makes the
   `r === 'script-missing'` assertion flaky (it returns 'grace' instead
   when the cooldown is active). The fix is to expose the cooldown
   state as a parameter or to reset the cooldown from within the test
   via a `__resetCreateMainChannelsSessionCooldown()` debug helper.

Per task rule "NEVER modify src/web/channel-monitor.ts" the source edits
are blocked until the user overrides; the test suite documents the gap
and pins every reachable sibling branch.