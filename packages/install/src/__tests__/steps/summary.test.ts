import { describe, it, expect, beforeEach } from 'vitest'
import { stepSummary } from '../../steps/summary.js'
import { initLocale } from '../../locale/index.js'
import { setColorsEnabled } from '../../ui/theme.js'
import { captureOutput, makeCtx } from '../_helpers.js'

beforeEach(() => {
  initLocale('hu')
  setColorsEnabled(false)
})

describe('steps/summary', () => {
  it('prints the bootstrap URL, the token and the next steps', async () => {
    const ctx = makeCtx({ webPort: 3420, dashboardToken: 'abc123' })
    const { stdout } = await captureOutput(() => stepSummary(ctx))
    expect(stdout).toContain('Marveen telepítés kész')
    expect(stdout).toContain('Dashboard URL: http://127.0.0.1:3420')
    expect(stdout).toContain('Dashboard token: abc123')
    expect(stdout).toContain('Következő lépések')
    expect(stdout).toContain('Nyisd meg a dashboard-ot: http://127.0.0.1:3420')
    expect(stdout).toContain('szkript/channels.sh')
    expect(stdout).toContain('marveen-install update')
  })

  it('falls back to (unset) when no token was captured', async () => {
    const ctx = makeCtx({ dashboardToken: '' })
    const { stdout } = await captureOutput(() => stepSummary(ctx))
    expect(stdout).toContain('Dashboard token: (unset)')
  })

  it('follows the active locale', async () => {
    initLocale('en')
    const ctx = makeCtx({ webPort: 9999, dashboardToken: 'tok' })
    const { stdout } = await captureOutput(() => stepSummary(ctx))
    expect(stdout).toContain('Marveen installation complete')
    expect(stdout).toContain('http://127.0.0.1:9999')
    initLocale('hu')
  })
})
