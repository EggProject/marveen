import { describe, it, expect } from 'vitest'
import { resolveKanbanDispatchTarget } from '../kanban-dispatch.js'

const base = {
  ownerName: 'Gábor',
  botName: 'GorcsevIvan',
  mainAgentId: 'gorcsevivan',
  agentNames: ['tuskohopkins', 'sentinel'],
  isRunning: (n: string) => n === 'tuskohopkins', // only tuskohopkins is "running"
}

describe('resolveKanbanDispatchTarget', () => {
  it('returns null for empty / null / undefined / whitespace assignee', () => {
    expect(resolveKanbanDispatchTarget(null, base)).toBeNull()
    expect(resolveKanbanDispatchTarget(undefined, base)).toBeNull()
    expect(resolveKanbanDispatchTarget('', base)).toBeNull()
    expect(resolveKanbanDispatchTarget('   ', base)).toBeNull()
  })

  it('never dispatches to the human owner', () => {
    expect(resolveKanbanDispatchTarget('Gábor', base)).toBeNull()
  })

  it('maps the bot display name to the main agent id', () => {
    expect(resolveKanbanDispatchTarget('GorcsevIvan', base)).toBe('gorcsevivan')
  })

  it('maps the canonical main agent id to itself', () => {
    expect(resolveKanbanDispatchTarget('gorcsevivan', base)).toBe('gorcsevivan')
  })

  it('matches the bot/main case-insensitively', () => {
    expect(resolveKanbanDispatchTarget('gorcsevIVAN', base)).toBe('gorcsevivan')
    expect(resolveKanbanDispatchTarget('GORCSEVIVAN', base)).toBe('gorcsevivan')
  })

  it('dispatches to a sub-agent only when its session is running', () => {
    expect(resolveKanbanDispatchTarget('tuskohopkins', base)).toBe('tuskohopkins')
    expect(resolveKanbanDispatchTarget('sentinel', base)).toBeNull() // not running -> silent no-op
  })

  it('matches sub-agent names case-insensitively', () => {
    expect(resolveKanbanDispatchTarget('TuskoHopkins', base)).toBe('tuskohopkins')
  })

  it('returns null for an unknown assignee name', () => {
    expect(resolveKanbanDispatchTarget('SomebodyElse', base)).toBeNull()
  })
})

// The module is pure (no fs / env / tmux), so no tem-sandbox helper is needed
// here -- nothing touches disk. Everything below pins behaviour that the 8
// tests above leave unspecified: trimming, the isRunning call contract, the
// owner-guard casing asymmetry, and the main-vs-sub liveness asymmetry.

describe('resolveKanbanDispatchTarget -- trimming', () => {
  it('trims the assignee before every comparison', () => {
    expect(resolveKanbanDispatchTarget('  tuskohopkins  ', base)).toBe('tuskohopkins')
    expect(resolveKanbanDispatchTarget('\tGorcsevIvan\n', base)).toBe('gorcsevivan')
    expect(resolveKanbanDispatchTarget('  Gábor  ', base)).toBeNull()
  })

  it('trims the configured names -- a padded BOT_NAME still matches (resolved trim asymmetry)', () => {
    // .env values are trimmed by readEnvFile, but a QUOTED value keeps its
    // padding ("Marveen " -> Marveen<space>). The norm() helper closes this
    // gap so the main agent still wakes even when .env quotes leak padding.
    const padded = { ...base, botName: 'GorcsevIvan ', mainAgentId: 'gorcsevivan ' }
    expect(resolveKanbanDispatchTarget('GorcsevIvan', padded)).toBe('gorcsevivan')
  })
})

describe('resolveKanbanDispatchTarget -- isRunning call contract', () => {
  it('passes the CANONICAL registry name to isRunning, not the assignee casing', () => {
    const seen: string[] = []
    const opts = { ...base, isRunning: (n: string) => { seen.push(n); return true } }
    expect(resolveKanbanDispatchTarget('TUSKOHOPKINS', opts)).toBe('tuskohopkins')
    // The caller wires isRunning to isAgentRunning(), which resolves a tmux
    // session by exact name -- feeding it the raw card casing would miss.
    expect(seen).toEqual(['tuskohopkins'])
  })

  it('never consults isRunning for an unknown assignee', () => {
    const seen: string[] = []
    const opts = { ...base, isRunning: (n: string) => { seen.push(n); return true } }
    expect(resolveKanbanDispatchTarget('SomebodyElse', opts)).toBeNull()
    expect(seen).toEqual([])
  })

  it('never consults isRunning for the bot / main agent branch', () => {
    // Asymmetry by design: main is the channels session, dispatched blind.
    const seen: string[] = []
    const opts = { ...base, isRunning: (n: string) => { seen.push(n); return false } }
    expect(resolveKanbanDispatchTarget('gorcsevivan', opts)).toBe('gorcsevivan')
    expect(seen).toEqual([])
  })

  it('a non-running sub-agent returns null and does not fall through to main', () => {
    expect(resolveKanbanDispatchTarget('sentinel', base)).toBeNull()
    expect(resolveKanbanDispatchTarget('sentinel', base)).not.toBe(base.mainAgentId)
  })

  it('returns the first registry entry when two dirs differ only in case', () => {
    const opts = { ...base, agentNames: ['Sentinel', 'sentinel'], isRunning: () => true }
    expect(resolveKanbanDispatchTarget('SENTINEL', opts)).toBe('Sentinel')
  })
})

describe('resolveKanbanDispatchTarget -- degenerate config', () => {
  it('an empty ownerName cannot swallow an assignee', () => {
    // '' === '' would null every card; the empty-assignee early return guards it.
    const opts = { ...base, ownerName: '' }
    expect(resolveKanbanDispatchTarget('tuskohopkins', opts)).toBe('tuskohopkins')
    expect(resolveKanbanDispatchTarget('', opts)).toBeNull()
  })

  it('an empty botName / mainAgentId cannot swallow an assignee', () => {
    const opts = { ...base, botName: '', mainAgentId: '' }
    expect(resolveKanbanDispatchTarget('tuskohopkins', opts)).toBe('tuskohopkins')
  })

  it('handles an empty agent registry', () => {
    const opts = { ...base, agentNames: [] }
    expect(resolveKanbanDispatchTarget('tuskohopkins', opts)).toBeNull()
    expect(resolveKanbanDispatchTarget('GorcsevIvan', opts)).toBe('gorcsevivan')
  })

  it('the owner guard wins over an identically named running sub-agent', () => {
    const opts = { ...base, agentNames: ['Gábor'], isRunning: () => true }
    expect(resolveKanbanDispatchTarget('Gábor', opts)).toBeNull()
  })
})

// BUG PIN (resolved) -- kanban-dispatch-owner-case
// The owner guard (kanban-dispatch.ts:34) used to be the ONLY case-sensitive
// comparison in the function; the bot, main-id and sub-agent matches all
// lowercased both sides. The guard now matches case-insensitively too --
// the three scenarios below exercise the previously-bypassed branches.
describe('resolveKanbanDispatchTarget -- owner guard casing', () => {
  it('recognises the owner case-insensitively even when no agent matches', () => {
    // The owner guard fires for 'gábor' and 'GÁBOR' before the agent scan
    // runs. The result is still null (today the same outcome fell through
    // because no agent matched), but the reason is now the owner guard.
    expect(resolveKanbanDispatchTarget('gábor', base)).toBeNull()
    expect(resolveKanbanDispatchTarget('GÁBOR', base)).toBeNull()
  })

  it('the owner guard wins over a case-insensitive collision with a running sub-agent', () => {
    // Operator has both OWNER_NAME=Gábor and a personal agent dir "gábor".
    // Before the fix the lowercase assignee fell through to the agent; now
    // the owner guard swallows it (humans never get a prompt).
    const opts = { ...base, agentNames: ['gábor'], isRunning: () => true }
    expect(resolveKanbanDispatchTarget('Gábor', opts)).toBeNull()
    expect(resolveKanbanDispatchTarget('gábor', opts)).toBeNull()
  })

  it('a mis-cased owner name no longer leaks to the main session', () => {
    // OWNER_NAME and BOT_NAME both equal 'GorcsevIvan'; the mis-cased
    // 'gorcsevivan' used to slip past the owner guard and route to main.
    const opts = { ...base, ownerName: 'GorcsevIvan' }
    expect(resolveKanbanDispatchTarget('GorcsevIvan', opts)).toBeNull()
    expect(resolveKanbanDispatchTarget('gorcsevivan', opts)).toBeNull()
  })
})
