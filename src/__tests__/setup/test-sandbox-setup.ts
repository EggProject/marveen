// setupFiles entry: register a vi.mock('../config.js', ...) at hoisted time
// so EVERY test file in the worker gets a per-file tmpdir PROJECT_ROOT and
// STORE_DIR before any module in src/ resolves those paths.
//
// Why this matters: src/web/channel-monitor.ts:828 and
// src/channel-coordinator/liveness.ts:30 both freeze
// `RESPAWN_STAMP_FILE = join(PROJECT_ROOT, 'store', '.channel-last-respawn')`
// at module load. Without the redirect, those modules compute the LIVE
// `./store/.channel-last-respawn` path. The first test in a worker that
// triggers `writeRespawnStamp()` then writes into the live checkout --
// tripping the assert-not-live-install guard on the next suite run.
//
// setupFiles vi.mock: verified to apply to test file imports (vitest 4.x).
// The factory is hoisted at top of this file and registered before any
// `import` statement in any subsequent test file. Tests that ALSO mock
// `../config.js` with their own vi.mock win because their hoisted factory
// is registered after this one (and the test file is loaded after
// setupFiles).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'vitest-sandbox-'))
const SANDBOX_STORE = join(SANDBOX, 'store')

vi.mock('../config.js', () => ({
  PROJECT_ROOT: SANDBOX,
  STORE_DIR: SANDBOX_STORE,
}))
