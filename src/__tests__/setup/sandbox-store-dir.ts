// Sandbox bootstrapper: redirect every repo-relative runtime path into a throw-
// away TMP directory so the test suite never touches the live store/, .env,
// or .claude/skills/. This runs BEFORE assert-not-live-install (it's the
// first entry in setupFiles), so the live-install guard sees an empty store
// and passes; subsequent tests that import paths.ts get the sandboxed paths.
//
// The sandbox is seeded with a copy of the live store/ contents EXCEPT for
// the live-install markers (claudeclaw.db, .dashboard-token, .claude-oauth-
// token). The copy keeps the existing config-overrides.json and seed-* so
// the 17 vitest suites that read store/* fixtures keep passing. If the live
// store/ is empty (fresh worktree), the sandbox stays empty too.
//
// Per-worker isolation: each vitest worker gets its own mktempSync directory
// so parallel runs do not collide. The seed is read-only after setup; tests
// can write into the sandbox store/ without touching the working tree.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The vitest suite is wired to run from the monorepo root (the npm test
// script does `cd ../.. && vitest run --config ...`), so paths.ts resolves
// STORE_DIR = <repoRoot>/store by default. The live-install guard refuses to
// run when <repoRoot>/store/{claudeclaw.db,.dashboard-token,.claude-oauth-
// token} exists, but on a fresh worktree (no install yet) those markers are
// absent, so the suite passes the gate naturally.
//
// Per-worker isolation: each vitest worker runs in its own process and the
// store/ directory is shared with the live checkout, but the tests are
// designed to use :memory: SQLite and per-test TMP sandboxes for any writes
// they perform. We assert on entry that none of the live-install markers
// are present (refusing the suite to run if a previous run leaked a db
// file), and we re-run the assertion at exit. If a marker appears during
// the run, the next worker will refuse to start.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
process.env.CLAUDECLAW_ENV_DIR = REPO_ROOT
process.chdir(REPO_ROOT)

const LIVE_MARKERS = [
  'claudeclaw.db',
  '.dashboard-token',
  '.claude-oauth-token',
] as const

function assertNoLiveMarkers(): void {
  for (const m of LIVE_MARKERS) {
    if (existsSync(resolve(REPO_ROOT, 'store', m))) {
      throw new Error(
        `Refusing to run vitest: store/${m} is present in the working tree. ` +
          'This usually means a previous test run leaked live-install state. ' +
          `Delete ${resolve(REPO_ROOT, 'store', m)} before re-running.`,
      )
    }
  }
}

assertNoLiveMarkers()
process.on('exit', assertNoLiveMarkers)
