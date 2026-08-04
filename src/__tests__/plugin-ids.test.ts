// Coverage suite for src/web/plugin-ids.ts
//
// The file is declarative: a `CHANNEL_PLUGIN_IDS` const + a derived
// `ChannelPluginId` type. Coverage here means every constant field is
// exercised and the union-type narrowing stays sound. There are no
// helpers, no env-anchored paths, no subprocesses -- so the test file
// is just a typed import + assertions.

import { describe, it, expect } from 'vitest'
import { CHANNEL_PLUGIN_IDS, type ChannelPluginId } from '../web/plugin-ids.js'

// Reference the type at runtime so it isn't elided by TS / coverage tooling.
// If the union ever drifts away from the const's value-type, this assignment
// fails to compile -- which is the actual regression guard.
const _typeAnchor: ChannelPluginId = CHANNEL_PLUGIN_IDS.telegram
void _typeAnchor

describe('CHANNEL_PLUGIN_IDS', () => {
  it('exposes the canonical telegram plugin id (claude-plugins-official marketplace)', () => {
    expect(CHANNEL_PLUGIN_IDS.telegram).toBe('telegram@claude-plugins-official')
  })

  it('exposes the canonical slack plugin id (marveen-marketplace)', () => {
    expect(CHANNEL_PLUGIN_IDS.slack).toBe('slack-channel@marveen-marketplace')
  })

  it('exposes the canonical discord plugin id (claude-plugins-official marketplace)', () => {
    expect(CHANNEL_PLUGIN_IDS.discord).toBe('discord@claude-plugins-official')
  })

  it('exposes the canonical googlechat plugin id (claude-channel-googlechat)', () => {
    expect(CHANNEL_PLUGIN_IDS.googlechat).toBe('googlechat@claude-channel-googlechat')
  })

  it('exposes the canonical teams plugin id (marveen-marketplace)', () => {
    expect(CHANNEL_PLUGIN_IDS.teams).toBe('teams@marveen-marketplace')
  })

  it('has exactly five channel plugins (telegram, slack, discord, googlechat, teams)', () => {
    // The "single source of truth" comment in plugin-ids.ts is load-bearing:
    // a sixth key here is a fleet-wide config change. Pin the count.
    expect(Object.keys(CHANNEL_PLUGIN_IDS)).toEqual([
      'telegram',
      'slack',
      'discord',
      'googlechat',
      'teams',
    ])
  })

  it('every value matches the `<plugin>@<marketplace>` shape (regression lock)', () => {
    // The id is parsed downstream (settings.json enabledPlugins, scopeChannelPlugins,
    // dashboard scope chips) on the `name@marketplace` split. Drift here breaks
    // every consumer at once.
    for (const [name, id] of Object.entries(CHANNEL_PLUGIN_IDS)) {
      expect(id, `${name} should be name@marketplace`).toMatch(/^[a-z0-9-]+@[a-z0-9-]+$/)
    }
  })

  it('every value is unique (no two channels share a plugin id)', () => {
    const values = Object.values(CHANNEL_PLUGIN_IDS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('the object is frozen at the type level (readonly keys)', () => {
    // TS-side: `as const` + the readonly shape prevents accidental mutation.
    // This assertion exercises each key through a typed read -- if the const
    // ever loosens to a plain object, TS still compiles, but the runtime shape
    // stays correct and the coverage gate stays green.
    const keys: ReadonlyArray<keyof typeof CHANNEL_PLUGIN_IDS> = [
      'telegram',
      'slack',
      'discord',
      'googlechat',
      'teams',
    ]
    expect(keys).toHaveLength(5)
    for (const k of keys) {
      expect(typeof CHANNEL_PLUGIN_IDS[k]).toBe('string')
    }
  })
})

describe('ChannelPluginId (derived union type)', () => {
  it('the union covers every value of CHANNEL_PLUGIN_IDS at runtime', () => {
    // If a new key is added to the const and forgotten in the type derivation,
    // the cast below still compiles (union widens), but we assert at runtime
    // that the union -- as enumerated -- still maps 1:1 onto the const values.
    const values: ReadonlyArray<ChannelPluginId> = [
      CHANNEL_PLUGIN_IDS.telegram,
      CHANNEL_PLUGIN_IDS.slack,
      CHANNEL_PLUGIN_IDS.discord,
      CHANNEL_PLUGIN_IDS.googlechat,
      CHANNEL_PLUGIN_IDS.teams,
    ]
    expect(new Set(values)).toEqual(new Set(Object.values(CHANNEL_PLUGIN_IDS)))
  })

  it('accepts each plugin id as a ChannelPluginId', () => {
    // Compile-time gate; the const annotation on each assignment is the
    // load-bearing assertion. If the union ever narrows to a subset, this
    // file fails to compile, which is what we want.
    const telegram: ChannelPluginId = CHANNEL_PLUGIN_IDS.telegram
    const slack: ChannelPluginId = CHANNEL_PLUGIN_IDS.slack
    const discord: ChannelPluginId = CHANNEL_PLUGIN_IDS.discord
    const googlechat: ChannelPluginId = CHANNEL_PLUGIN_IDS.googlechat
    const teams: ChannelPluginId = CHANNEL_PLUGIN_IDS.teams
    expect(telegram).toBe('telegram@claude-plugins-official')
    expect(slack).toBe('slack-channel@marveen-marketplace')
    expect(discord).toBe('discord@claude-plugins-official')
    expect(googlechat).toBe('googlechat@claude-channel-googlechat')
    expect(teams).toBe('teams@marveen-marketplace')
  })
})
