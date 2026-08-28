// TEMP (system temporary directory) sandbox helpers for the test suite.
//
// "TEMP" here is just `os.tmpdir()` -- the system temp dir the OS hands us
// per-user. NOT a custom abstraction: every helper in this file uses
// `mkdtempSync(join(tmpdir(), ...))` and nothing fancier.
//
// Every test that needs filesystem state must run inside an `os.tmpdir()`
// scratch dir. This module centralizes the boilerplate that used to be
// repeated in every suite (env.test.ts being the prior pattern):
//
//   const SANDBOX = mkdtempSync(join(tmpdir(), 'suite-'))
//   beforeAll(() => { process.env.CLAUDECLAW_ENV_DIR = SANDBOX })
//   afterAll(() => { delete process.env.CLAUDECLAW_ENV_DIR; rmSync(SANDBOX, ...) })
//
// The helpers here are deliberately additive: they do not change how
// `assert-not-live-install.ts` works (that's still the outermost gate) and
// they do not assume any particular test layout. Tests opt in per file.
//
// Two redirect mechanisms are bundled:
//
//   1. `withTempSandbox` / `mkTempStore` / `mkTempEnv` -- redirect the
//      `STORE_DIR` / `.env` chain via the existing `CLAUDECLAW_ENV_DIR`
//      hook (`src/env.ts:11`). Set this BEFORE any `import('../config.js')`
//      resolves -- vitest isolates module registries per test file so the
//      hook cannot leak across suites.
//
//   2. `redirectHomeDirTo` -- wraps `os.homedir()` so the modules that hard-
//      code `join(homedir(), '.claude', ...)` at function call time resolve
//      inside the sandbox. Pair with `restoreHomeDir` in afterAll.

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Create a fresh tmpdir-scoped subdirectory. Returned path is guaranteed
 *  to be empty and to live under `os.tmpdir()` so the live-install guard
 *  never sees it. The caller is responsible for `rmSync`-ing the dir. */
export function mkTempDir(prefix = 'marveen-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Returns a `store/` subdir under a fresh temp parent. Used by suites
 *  that exercise the `STORE_DIR` chain (`src/config.ts:13`). */
export function mkTempStore(prefix = 'marveen-store-'): string {
  const dir = mkTempDir(prefix)
  const store = join(dir, 'store')
  mkdirSync(store, { recursive: true })
  return store
}

/** Returns a `.env`-bearing subdir. `src/env.ts` resolves `.env` relative
 *  to this dir when `CLAUDECLAW_ENV_DIR` is set. */
export function mkTempEnv(prefix = 'marveen-env-'): string {
  const dir = mkTempDir(prefix)
  // Pre-create an empty .env so the first read returns {} rather than
  // hitting readFileSync and returning ENOENT on every call.
  return dir
}

/** Run `body` with `CLAUDECLAW_ENV_DIR` pointed at a fresh tmpdir. The env
 *  var is restored on exit (success or throw). Returns whatever `body`
 *  returns. Use this for tests that import `src/env.ts` or `src/config.ts`
 *  via dynamic import AFTER setting the hook (see env.test.ts for the
 *  canonical pattern). */
export async function withTempEnv<T>(
  body: (envDir: string) => Promise<T> | T,
): Promise<T> {
  const envDir = mkTempEnv()
  const previous = process.env.CLAUDECLAW_ENV_DIR
  process.env.CLAUDECLAW_ENV_DIR = envDir
  try {
    return await body(envDir)
  } finally {
    if (previous === undefined) delete process.env.CLAUDECLAW_ENV_DIR
    else process.env.CLAUDECLAW_ENV_DIR = previous
    rmSync(envDir, { recursive: true, force: true })
  }
}

/** Synchronous variant of `withTempEnv`. Use only when `body` cannot await
 *  (e.g. inside a beforeAll that must remain sync). */
export function withTempEnvSync<T>(
  body: (envDir: string) => T,
): T {
  const envDir = mkTempEnv()
  const previous = process.env.CLAUDECLAW_ENV_DIR
  process.env.CLAUDECLAW_ENV_DIR = envDir
  try {
    return body(envDir)
  } finally {
    if (previous === undefined) delete process.env.CLAUDECLAW_ENV_DIR
    else process.env.CLAUDECLAW_ENV_DIR = previous
    rmSync(envDir, { recursive: true, force: true })
  }
}

/** Snapshot of process.env captured at call time, plus a `restore()` method
 *  that puts every mutated key back to its original value (or deletes it
 *  if it didn't exist). Use this when a test mutates multiple env vars
 *  and you want a single teardown call. */
export function snapshotEnv(): { restore: () => void } {
  const snapshot = { ...process.env }
  return {
    restore(): void {
      for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) delete process.env[key]
      }
      for (const [key, value] of Object.entries(snapshot)) {
        process.env[key] = value
      }
    },
  }
}

/** Recursive rmSync of a tmpdir dir, swallowing ENOENT. Safe to call from
 *  afterEach/afterAll even when the dir was already cleaned up by the
 *  suite. */
export function rmTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Non-volatile sandbox
// ---------------------------------------------------------------------------
//
// `os.tmpdir()` is `/tmp` on Linux and `/var/folders/.../T/...` on macOS. That
// difference is invisible until a suite feeds its sandbox paths into
// `isUnsafeHookCommand` (src/web/agent-scaffold.ts), which REJECTS any hook
// command referencing a volatile tmpfs prefix -- a deliberate production guard
// from the 2026-07-14 silent fleet-freeze incident, where a rebooted host lost
// the /tmp script a shared hook pointed at and Claude Code then blocked every
// prompt.
//
// On macOS the guard never fires for a tmpdir sandbox, so the agent-scaffold
// suites passed locally for months. On the first Linux CI run they produced 30
// failures with no obvious connection to the cause. Suites whose paths end up
// inside hook commands must therefore allocate outside those prefixes.

/** Kept in sync with `_TMP_PREFIXES` in src/web/agent-scaffold.ts. */
const VOLATILE_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']

/** True when `path` sits under a prefix `isUnsafeHookCommand` rejects. */
export function isVolatilePath(path: string): boolean {
  return VOLATILE_PREFIXES.some((p) => path.startsWith(p))
}

/**
 * Create a fresh scratch dir that is guaranteed NOT to live under a volatile
 * tmpfs prefix, so paths inside it survive `isUnsafeHookCommand`.
 *
 * Rooted at `$HOME` rather than `os.tmpdir()` because on Linux the latter IS
 * `/tmp`. `$HOME` is read from the environment, not `os.homedir()`, because the
 * suites that need this helper mock `node:os` to point `homedir()` back into
 * their own sandbox.
 *
 * Throws rather than degrading if the resulting base is itself volatile: a loud
 * failure here is worth far more than the 30 unexplained assertion failures
 * this function exists to prevent.
 */
export function mkNonVolatileDir(prefix = 'marveen-test-'): string {
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home) throw new Error('mkNonVolatileDir: neither HOME nor USERPROFILE is set')
  const base = join(home, '.cache', 'marveen-test-sandboxes')
  if (isVolatilePath(base)) {
    throw new Error(
      `mkNonVolatileDir: base ${base} is under a volatile prefix; hook-command tests would silently fail`,
    )
  }
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, prefix))
}
