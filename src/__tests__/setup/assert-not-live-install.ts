// GLOBAL SUITE GATE: refuse to run the test suite inside a LIVE install.
//
// 2026-07-27, one full-suite run in the production checkout: settings-store.test.ts
// rmSync'd the live store/config-overrides.json (dropping MAIN_AGENT_ISOLATED_CONFIG
// and ultimately 401-ing the main agent that evening), env.test.ts unlink+rewrote the
// live .env (mode 600 -> 644), and the auth suites pushed real break-glass Telegram
// alerts to the owner. Tests must only ever run from a worktree/CI checkout whose
// store/ carries no runtime state.
//
// 2026-08-06 follow-up: marker-only detection was insufficient. After several
// hours of test runs, the live checkout accumulated `store/task-run-history.json.migrated`,
// `store/agent-taskstate/` and other files that no marker filter catches. Tightened:
// refuse to run if `store/` itself exists (as a directory) OR if any file lives
// under it. A fresh clone or worktree has no `store/` directory at all, so CI and
// PR-verify flows are unaffected. This is a HARD failure on purpose -- a silent
// skip would hide that someone is one `npm test` away from mutating production
// state (loaded via vitest `setupFiles`, so it gates every worker; per-file
// guards cannot be forgotten this way).
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// 1. Strict marker detection -- the canonical, runtime-only fingerprints.
const LIVE_MARKERS = [
  join('store', '.dashboard-token'),
  join('store', 'claudeclaw.db'),
  join('store', '.claude-oauth-token'),
]

// 2. Whole-store detection -- catches every file under store/, including
//    `task-run-history.json.migrated`, `agent-taskstate/`, `costops-config.json.example`,
//    etc. that test runs accidentally produced on a live checkout.
const storeDir = join(repoRoot, 'store')
const foundMarkers = LIVE_MARKERS.filter((m) => existsSync(join(repoRoot, m)))
let foundStoreContents: string[] = []
if (existsSync(storeDir)) {
  try {
    const st = statSync(storeDir)
    if (st.isDirectory()) {
      try {
        // Only FILES under store/ count as a pollution signal. A leftover
        // empty directory (e.g. a test's `mkdirSync(STORE_DIR, { recursive:
        // true })` ran but every file it wrote was cleaned up by afterAll) is
        // harmless -- the next suite's first test would just see an empty
        // dir and skip the migration. Previously an empty store/ would
        // still trip the guard, blocking parallel workers that happened to
        // spawn right after the dir-creating test.
        foundStoreContents = readdirSync(storeDir).filter((name) => {
          try {
            return statSync(join(storeDir, name)).isFile()
          } catch {
            return false
          }
        })
      } catch {
        // unreadable; treat as empty for the purposes of the error message
      }
    }
  } catch {
    // stat threw; ignore
  }
}

if (foundMarkers.length > 0 || foundStoreContents.length > 0) {
  const reasons: string[] = []
  if (foundMarkers.length > 0) reasons.push(`markers=${foundMarkers.join(', ')}`)
  if (foundStoreContents.length > 0)
    reasons.push(`store/${foundStoreContents.slice(0, 10).join(', ')}`)
  throw new Error(
    `REFUSING TO RUN TESTS: ${repoRoot} looks like a LIVE install (found: ${reasons.join('; ')}). ` +
      'The suite mutates files under the checkout it runs in (store/, .env, .claude/skills/). ' +
      'Run it from a git worktree or CI checkout instead, e.g. `git worktree add /tmp/claw-test && cd /tmp/claw-test && npm test`.',
  )
}

// Post-suite cleanup of empty root-level store/ and agents/ directories
// moved to src/__tests__/setup/clean-empty-store.ts, which uses
// process.on('beforeExit', ...) AND a beforeAll-sweep to ensure the cleanup
// runs reliably even in vitest workers (process.on('exit', ...) does NOT
// fire reliably there).
