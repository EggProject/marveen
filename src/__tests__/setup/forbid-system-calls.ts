// Global default-on deny-list for system-touching APIs. Registered in
// vitest.config.ts between assert-not-live-install.ts and
// test-sandbox-setup.ts so the live-install refusal stays first (the
// store/ guard must win) and the per-worker tmpdir redirect is the LAST
// mock registered (later per-test-file vi.mock overrides win).
//
// Pattern lifted from src/__tests__/model-fallback-runner.test.ts:89-103
// (the "Rule 5 guard"). That pattern was opt-in per file; this setupFile
// blanket-applies it across the suite so a new test file that forgets
// to mock node:child_process cannot accidentally hit the host keychain,
// tmux, or send a real Telegram alert.
//
// Why this matters: the 2026-07-27 live-install incident
// (see assert-not-live-install.ts header for context) was the trigger.
// Even after the store/ marker guard landed, the auth suites had
// pushed real break-glass Telegram alerts to the owner from a test run.
// The worktree isolates the project checkout but NOT system resources
// (keychain, tmux, network). This layer closes that gap.
//
// Per-feature opt-outs (env vars read at module-load time):
//   MARVEEN_TEST_ALLOW_CHILD_PROCESS=1    (un-mock node:child_process)
//   MARVEEN_TEST_ALLOW_FETCH=1            (un-mock globalThis.fetch)
//   MARVEEN_TEST_ALLOW_PROCESS_KILL=1     (un-mock process.kill)
//
// Script wiring (see package.json):
//   bun run test                          -> no opt-outs, all forbids ON
//   bun run test:integration              -> CHILD_PROCESS + PROCESS_KILL on,
//                                            FETCH still forbidden (real-bash /
//                                            real-git / real-tar / real-python3
//                                            style tests; mocked HTTP)
//   bun run test:integration:real-world   -> DISABLE_FORBID=1, every gate open.
//                                            Real node:child_process, original
//                                            globalThis.fetch, real process.kill.
//                                            NOT meant for the regular dev loop:
//                                            a real Telegram bot in .env will
//                                            send real alerts (see 2026-07-27),
//                                            a macOS keychain entry will be read,
//                                            and any fetch with a real URL hits
//                                            the live network. Use only in a
//                                            disposable worktree AND only when
//                                            you accept the cleanup burden.
//
// Per-test-file vi.mock / vi.stubGlobal still wins: a file that wants
// to test the wrapper around execFileSync (e.g. keychain.test.ts) keeps
// its own vi.mock('node:child_process', ...) which is hoisted AFTER this
// setupFile, so its mock factory overrides the thrower for that file.
//
// vi.hoisted() captures the env var values BEFORE vi.mock's factory runs,
// so the conditional (pass-through vs forbid) lives inside the factory
// without nesting the vi.mock call itself (vitest requires vi.mock at
// top level; nested calls produce a deprecation warning today and a hard
// error in a future release).
import { vi } from 'vitest'

const flags = vi.hoisted(() => ({
  DISABLE_FORBID: process.env.MARVEEN_TEST_DISABLE_FORBID === '1',
  ALLOW_CHILD_PROCESS: process.env.MARVEEN_TEST_ALLOW_CHILD_PROCESS === '1',
  ALLOW_FETCH: process.env.MARVEEN_TEST_ALLOW_FETCH === '1',
  ALLOW_PROCESS_KILL: process.env.MARVEEN_TEST_ALLOW_PROCESS_KILL === '1',
}))

vi.mock('node:child_process', async () => {
  if (flags.DISABLE_FORBID || flags.ALLOW_CHILD_PROCESS) {
    return (await vi.importActual<typeof import('node:child_process')>('node:child_process'))
  }
  const forbid = (name: string) => (): never => {
    throw new Error(
      `node:child_process.${name} forbidden in test suite ` +
        `(set MARVEEN_TEST_ALLOW_CHILD_PROCESS=1 to opt out for this suite, ` +
        `or MARVEEN_TEST_DISABLE_FORBID=1 to disable all forbids). ` +
        `If you want to test a wrapper around execFileSync (e.g. keychain, ` +
        `channel-poller-reap), per-file vi.mock('node:child_process', ...) ` +
        `still wins over this global forbid.`,
    )
  }
  return {
    execSync: forbid('execSync'),
    execFileSync: forbid('execFileSync'),
    spawnSync: forbid('spawnSync'),
    spawn: forbid('spawn'),
    exec: forbid('exec'),
    execFile: forbid('execFile'),
    fork: forbid('fork'),
  }
})

if (!flags.DISABLE_FORBID && !flags.ALLOW_FETCH) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((..._args: Parameters<typeof fetch>): Promise<Response> => {
    throw new Error(
      `globalThis.fetch forbidden in test suite ` +
        `(set MARVEEN_TEST_ALLOW_FETCH=1 to opt out, ` +
        `or MARVEEN_TEST_DISABLE_FORBID=1 to disable all forbids). ` +
        `Per-test vi.stubGlobal('fetch', mockFn) still wins over this global forbid.`,
    )
  }) as typeof fetch
  // Preserve the real fetch on globalThis.__originalFetch for the rare suite
  // that needs it under MARVEEN_TEST_ALLOW_FETCH=1 (e.g. graph-mail.test.ts
  // routing through a localhost stub server that internally re-fetches).
  ;(globalThis as { __originalFetch?: typeof fetch }).__originalFetch = originalFetch
}

if (!flags.DISABLE_FORBID && !flags.ALLOW_PROCESS_KILL) {
  process.kill = ((..._args: Parameters<typeof process.kill>): true => {
    throw new Error(
      `process.kill forbidden in test suite ` +
        `(set MARVEEN_TEST_ALLOW_PROCESS_KILL=1 to opt out, ` +
        `or MARVEEN_TEST_DISABLE_FORBID=1 to disable all forbids). ` +
        `Per-test vi.spyOn(process, 'kill') still wins over this global forbid.`,
    )
  }) as typeof process.kill
}