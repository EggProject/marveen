import { describe, it, expect, vi } from 'vitest'
import { identitySlashCommands } from '../web/agent-process.js'

// SANDBOX STORE_DIR -- redirect PROJECT_ROOT/STORE_DIR to a tmpdir so modules
// that freeze those paths at module load (channel-monitor.ts:828
// RESPAWN_STAMP_FILE, channel-coordinator/liveness.ts:30 RESPAWN_STAMP_FILE,
// store-watcher.ts:29 SENSITIVE_NAMES) don't pollute the live ./store/.
// Must come BEFORE any import that transitively reaches '../config.js'.
const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cfg-${stamp}`)
  return { PROJECT_ROOT: dir, STORE_DIR: join(dir, 'store') }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, ...configSandbox }
})

// Locks the identity slash commands sent on every Claude Code session
// (re)start -- both the normal startup and the channel-monitor recovery
// respawns route through scheduleIdentitySetup, which uses these. Only `/name`
// is sent now; `/remote-control` was dropped (the operator no longer uses it).
describe('identitySlashCommands', () => {
  it('returns just /name with the display name', () => {
    expect(identitySlashCommands('Zoé')).toEqual(['/name Zoé'])
  })

  it('does not send /remote-control', () => {
    expect(identitySlashCommands('Mr. Wolf').some((c) => c.includes('/remote-control'))).toBe(false)
  })
})
