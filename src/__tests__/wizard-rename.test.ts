import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// WIZNAME1 (2026-07-28, bootcamp): renaming the agent in the wizard appeared
// to do nothing on installer-started (VPS) installs. Two independent causes:
//   1. the identity save only wrote BOT_NAME when the fleet was NOT running,
//      and on a VPS the installer starts the fleet before the wizard;
//   2. config.ts freezes BOT_NAME/BRAND_NAME at module load, so even the
//      written BRAND_NAME stayed invisible until a process restart.
// These tests pin the fix: the always-write + restart decision core, and the
// fresh-read helpers the display routes now use.
//
// Sandboxed canonical config store. The runtime no longer reads identity from
// `.env`; the one-time migration command owns that input.
const SANDBOX = mkdtempSync(join(tmpdir(), 'wizname-test-'))
const STORE = join(SANDBOX, 'store')
const OVERRIDES = join(STORE, 'config-overrides.json')

vi.mock('../paths.js', async (orig) => {
  const actual = await orig<typeof import('../paths.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: STORE }
})

function writeIdentity(values: Record<string, string>): void {
  writeFileSync(OVERRIDES, JSON.stringify(values))
}

beforeAll(() => {
  mkdirSync(STORE, { recursive: true })
  writeIdentity({ BOT_NAME: 'BootName' })
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('currentBotName / currentBrandName (fresh per-call reads)', () => {
  it('reflects a post-import BOT_NAME change without a restart, while the module const stays frozen', async () => {
    const cfg = await import('../config.js')
    expect(cfg.BOT_NAME).toBe('BootName')
    expect(cfg.currentBotName()).toBe('BootName')

    writeIdentity({ BOT_NAME: 'Robi' })
    expect(cfg.BOT_NAME).toBe('BootName') // module-load snapshot: unchanged
    expect(cfg.currentBotName()).toBe('Robi') // fresh read: the rename is live
  })

  it('falls brandName back to the current bot name when BRAND_NAME is unset', async () => {
    const cfg = await import('../config.js')
    writeIdentity({ BOT_NAME: 'Robi' })
    expect(cfg.currentBrandName()).toBe('Robi')
  })

  it('uses an explicit BRAND_NAME over the bot name, and ignores a blank one', async () => {
    const cfg = await import('../config.js')
    writeIdentity({ BOT_NAME: 'Robi', BRAND_NAME: 'Acme Ops' })
    expect(cfg.currentBrandName()).toBe('Acme Ops')
    writeIdentity({ BOT_NAME: 'Robi', BRAND_NAME: '' })
    expect(cfg.currentBrandName()).toBe('Robi')
  })

  it('returns the registry default when the canonical override is removed', async () => {
    const cfg = await import('../config.js')
    writeIdentity({})
    expect(cfg.currentBotName()).toBe('Marveen')
  })
})

describe('identitySavePlan (identity-save decision core)', () => {
  it('mid-setup rename with the fleet up restarts the channels session (the VPS wizard path)', async () => {
    const { identitySavePlan } = await import('../web/routes/onboarding.js')
    expect(identitySavePlan(true, true, true)).toEqual({ restart: true, restartNeeded: false })
  })

  it('mid-setup rename with no fleet does not restart anything (pre-install flow: launch picks the name up)', async () => {
    const { identitySavePlan } = await import('../web/routes/onboarding.js')
    expect(identitySavePlan(false, true, true)).toEqual({ restart: false, restartNeeded: false })
  })

  // The #758 review case: a pre-wizard-era install has no IDENTITY_CONFIRMED
  // flag, yet its running session is a long-lived working agent, not setup
  // state. freshSetup comes from the auth/channel/pairing probes (all true on
  // such an install => freshSetup=false), so a rename must NOT bounce it --
  // it reports restartNeeded and the wizard copy says so.
  it('rename on a configured (incl. pre-wizard legacy) running install never implicitly bounces a working fleet', async () => {
    const { identitySavePlan } = await import('../web/routes/onboarding.js')
    expect(identitySavePlan(true, false, true)).toEqual({ restart: false, restartNeeded: true })
  })

  it('rename on a configured stopped install needs no restart flag either', async () => {
    const { identitySavePlan } = await import('../web/routes/onboarding.js')
    expect(identitySavePlan(false, false, true)).toEqual({ restart: false, restartNeeded: false })
  })

  it('a no-op save (name unchanged) never restarts and never demands one, in any state', async () => {
    const { identitySavePlan } = await import('../web/routes/onboarding.js')
    for (const servicesUp of [true, false]) {
      for (const freshSetup of [true, false]) {
        expect(identitySavePlan(servicesUp, freshSetup, false)).toEqual({ restart: false, restartNeeded: false })
      }
    }
  })
})
