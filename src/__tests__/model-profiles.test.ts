// Behaviour-neutral model profiles.
//
// The whole point of Phase 1's profile layer is that it changes NOTHING. These
// tests are therefore mostly about what must not happen: an explicit model
// never loses, a bad profile never silently relocates an agent to a different
// model, and a missing map never rewrites anybody's model.

import { describe, expect, it } from 'vitest';
import {
  MODEL_PROFILE_IDS,
  isModelProfileId,
  resolveAgentModelFromConfig,
  validateModelProfileMap,
  type ModelProfileMapState,
} from '../model-profiles.js';

const DEFAULT_MODEL = 'claude-opus-5';
const ALIASES: Record<string, string> = { sonnet: 'claude-sonnet-5', 'sonnet-5': 'claude-sonnet-5' };
const alias = (raw: string) => ALIASES[raw] ?? raw;

// Mirrors the shape shipped in config-examples/model-profile-map.example.json.
const GOOD_MAP_STATE = validateModelProfileMap({
  version: 'test-1',
  profiles: {
    premium_reasoning: 'claude-opus-5',
    build_strong: 'claude-sonnet-5',
    analysis_efficient: 'deepseek-v4-pro',
    routine_lowcost: 'deepseek-v4-pro',
  },
}) as Extract<ModelProfileMapState, { ok: true }>;

const PROFILE_MAP = {
  premium_reasoning: 'claude-opus-5',
  build_strong: 'claude-sonnet-5',
  analysis_efficient: 'deepseek-v4-pro',
  routine_lowcost: 'deepseek-v4-pro',
} as const;

describe('model profile map validation', () => {
  it('accepts a complete map', () => {
    expect(GOOD_MAP_STATE.ok).toBe(true);
    expect(GOOD_MAP_STATE.map.profiles.build_strong).toBe('claude-sonnet-5');
  });

  it('accepts a complete map with no version and leaves version undefined', () => {
    // Hits the false branch of the version type-guard (line 64). Any
    // non-string version (including missing) must surface as `undefined`,
    // not as `null` or as the raw value.
    const state = validateModelProfileMap({ profiles: PROFILE_MAP }) as Extract<ModelProfileMapState, { ok: true }>;
    expect(state.ok).toBe(true);
    expect(state.map.version).toBeUndefined();
  });

  it('accepts a complete map with a non-string version and coerces it to undefined', () => {
    // The v8 ternary needs both branches. The string branch is covered by
    // GOOD_MAP_STATE; this test pins the "anything that is not a string"
    // branch and asserts the type coercion the validator chose.
    const state = validateModelProfileMap({
      version: 5,
      profiles: PROFILE_MAP,
    }) as Extract<ModelProfileMapState, { ok: true }>;
    expect(state.ok).toBe(true);
    expect(state.map.version).toBeUndefined();
  });

  it('rejects a PARTIAL map instead of filling the gap with a default', () => {
    // A missing entry would resolve that profile to the install default, i.e.
    // move an agent onto a different model without anyone choosing it.
    const state = validateModelProfileMap({
      profiles: { premium_reasoning: 'claude-opus-5', build_strong: 'claude-sonnet-5' },
    });
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error).toContain('analysis_efficient');
  });

  it('rejects an empty model string', () => {
    const state = validateModelProfileMap({
      profiles: {
        premium_reasoning: 'claude-opus-5',
        build_strong: '   ',
        analysis_efficient: 'deepseek-v4-pro',
        routine_lowcost: 'deepseek-v4-pro',
      },
    });
    expect(state.ok).toBe(false);
  });

  it('rejects an unknown profile id in the map', () => {
    const state = validateModelProfileMap({
      profiles: {
        premium_reasoning: 'a', build_strong: 'b', analysis_efficient: 'c', routine_lowcost: 'd',
        cheap_and_cheerful: 'e',
      },
    });
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error).toContain('cheap_and_cheerful');
  });

  it('rejects non-objects, arrays and a missing profiles key', () => {
    expect(validateModelProfileMap(null).ok).toBe(false);
    expect(validateModelProfileMap([]).ok).toBe(false);
    expect(validateModelProfileMap({ version: 'v1' }).ok).toBe(false);
  });

  it('rejects a profiles field that is an array (not a plain object)', () => {
    // Array.isArray short-circuits `typeof === 'object'` -- this is the single
    // shape that slips through every other guard, so the validator must catch
    // it explicitly.
    const state = validateModelProfileMap({ profiles: ['a', 'b'] });
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error).toBe('profile_map_missing_profiles');
  });

  it('rejects a non-object raw payload (string, number, boolean)', () => {
    // Pins all three of the `!raw` / `typeof raw !== 'object'` family at once.
    expect(validateModelProfileMap('oops').ok).toBe(false);
    expect(validateModelProfileMap(42).ok).toBe(false);
    expect(validateModelProfileMap(true).ok).toBe(false);
  });

  it('exposes exactly the four Phase 1 profile ids', () => {
    expect([...MODEL_PROFILE_IDS]).toEqual([
      'premium_reasoning', 'build_strong', 'analysis_efficient', 'routine_lowcost',
    ]);
    expect(isModelProfileId('build_strong')).toBe(true);
    expect(isModelProfileId('turbo')).toBe(false);
  });

  it('isModelProfileId is a type guard that closes over non-string inputs', () => {
    // The type guard is the only path that protects the unknown-profile branch
    // from crashing on a non-string. Lock its input contract.
    expect(isModelProfileId(undefined)).toBe(false);
    expect(isModelProfileId(null)).toBe(false);
    expect(isModelProfileId(42)).toBe(false);
    expect(isModelProfileId({})).toBe(false);
    expect(isModelProfileId([])).toBe(false);
  });
});

describe('resolver precedence', () => {
  it('a legacy explicit model still resolves exactly as before', () => {
    const r = resolveAgentModelFromConfig({ model: 'claude-sonnet-5' }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.source).toBe('explicit_model');
  });

  it('still applies the legacy alias table to an explicit model', () => {
    const r = resolveAgentModelFromConfig({ model: 'sonnet' }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
    expect(r.model).toBe('claude-sonnet-5');
  });

  it('an explicit model BEATS a modelProfile', () => {
    const r = resolveAgentModelFromConfig(
      { model: 'deepseek-v4-pro', modelProfile: 'premium_reasoning' },
      GOOD_MAP_STATE, DEFAULT_MODEL, alias,
    );
    expect(r.model).toBe('deepseek-v4-pro');
    expect(r.source).toBe('explicit_model');
  });

  it('a whitespace-only explicit model is treated as if not set, profile wins', () => {
    // The explicit-model guard is `typeof === 'string' && trim()`. An empty or
    // whitespace-only string is NOT a valid override; the resolver must fall
    // through to the modelProfile branch.
    const r = resolveAgentModelFromConfig(
      { model: '   ', modelProfile: 'build_strong' },
      GOOD_MAP_STATE, DEFAULT_MODEL, alias,
    );
    expect(r.source).toBe('model_profile');
    expect(r.model).toBe('claude-sonnet-5');
  });

  it('a non-string explicit model is ignored (profile still wins)', () => {
    // Pre-Phase 1 configs sometimes carried a model set to a number or null
    // because of a hand-rolled editor. The resolver must not crash; the
    // explicit-model branch must simply not match.
    const r = resolveAgentModelFromConfig(
      { model: 42, modelProfile: 'build_strong' as const },
      GOOD_MAP_STATE, DEFAULT_MODEL, alias,
    );
    expect(r.source).toBe('model_profile');
    expect(r.model).toBe('claude-sonnet-5');
  });

  it('resolves a modelProfile when no explicit model is set', () => {
    const r = resolveAgentModelFromConfig({ modelProfile: 'build_strong' }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.source).toBe('model_profile');
  });

  it('falls back to the install default when neither is configured', () => {
    const r = resolveAgentModelFromConfig({}, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
    expect(r.model).toBe(DEFAULT_MODEL);
    expect(r.source).toBe('default');
  });

  it('a null modelProfile is treated as not configured', () => {
    // Pins the `config.modelProfile !== null` branch. With null the
    // profile-track short-circuits, the default wins, and no error is
    // reported (null is a deliberate "unset" sentinel, not a misconfig).
    const r = resolveAgentModelFromConfig({ modelProfile: null }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
    expect(r.source).toBe('default');
    expect(r.model).toBe(DEFAULT_MODEL);
    expect(r.error).toBeUndefined();
  });

  it('an empty-string modelProfile is treated as not configured', () => {
    // Pins the `config.modelProfile !== ''` branch. Same intent as null:
    // empty string is a deliberate "unset" sentinel.
    const r = resolveAgentModelFromConfig({ modelProfile: '' }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
    expect(r.source).toBe('default');
    expect(r.model).toBe(DEFAULT_MODEL);
    expect(r.error).toBeUndefined();
  });
});

describe('failure semantics -- no silent model change', () => {
  it('an unknown profile id reports an error rather than passing silently', () => {
    const r = resolveAgentModelFromConfig({ modelProfile: 'turbo' }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
    expect(r.source).toBe('default');
    expect(r.error).toContain('unknown_model_profile');
  });

  it('truncates a long unknown profile id in the error message to 40 chars', () => {
    // The slice(0, 40) cap on the error string is deliberate so the message
    // does not balloon for a 10kB blob. The unknown profile is still
    // non-silent: the default is chosen AND the error is surfaced.
    const tooLong = 'x'.repeat(80);
    const r = resolveAgentModelFromConfig({ modelProfile: tooLong }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
    expect(r.source).toBe('default');
    expect(r.error).toContain('unknown_model_profile:');
    expect((r.error ?? '').length).toBeLessThan(`unknown_model_profile:${'x'.repeat(80)}`.length);
  });

  it('a missing map with a legacy explicit model changes nothing and raises nothing', () => {
    const r = resolveAgentModelFromConfig({ model: 'claude-sonnet-5' }, null, DEFAULT_MODEL, alias);
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.error).toBe(undefined);
  });

  it('a missing map with ONLY a modelProfile is a surfaced error, not a quiet default', () => {
    const r = resolveAgentModelFromConfig({ modelProfile: 'build_strong' }, null, DEFAULT_MODEL, alias);
    expect(r.source).toBe('default');
    expect(r.error).toBe('model_profile_map_missing');
  });

  it('a broken map with ONLY a modelProfile carries the map error forward', () => {
    const r = resolveAgentModelFromConfig(
      { modelProfile: 'build_strong' },
      { ok: false, error: 'profile_map_unparseable' },
      DEFAULT_MODEL, alias,
    );
    expect(r.source).toBe('default');
    expect(r.error).toBe('profile_map_unparseable');
  });

  it('a broken map does NOT disturb an agent that names an explicit model', () => {
    const r = resolveAgentModelFromConfig(
      { model: 'deepseek-v4-pro', modelProfile: 'build_strong' },
      { ok: false, error: 'profile_map_unparseable' },
      DEFAULT_MODEL, alias,
    );
    expect(r.model).toBe('deepseek-v4-pro');
    expect(r.error).toBe(undefined);
  });
});

describe('behaviour neutrality (spec 5.5 acceptance)', () => {
  // The live fleet snapshot recorded at build time, 2026-07-29.
  const LIVE_SNAPSHOT: Array<{ agent: string; model: string; profile: string }> = [
    { agent: 'buildfejleszto', model: 'claude-sonnet-5', profile: 'build_strong' },
    { agent: 'research', model: 'deepseek-v4-pro', profile: 'analysis_efficient' },
  ];

  it.each(LIVE_SNAPSHOT)(
    'the canary agent $agent resolves to the SAME model through its profile as through its explicit model',
    ({ model, profile }) => {
      const before = resolveAgentModelFromConfig({ model }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
      const after = resolveAgentModelFromConfig({ modelProfile: profile }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
      // This equality IS the acceptance criterion: switching a canary agent to
      // a neutral profile must produce an EMPTY resolved-model diff.
      expect(after.model).toBe(before.model);
      expect(after.model).toBe(model);
    },
  );

  it('every profile in the shipped map resolves to a model the fleet already runs', () => {
    const live = new Set(['claude-opus-5', 'claude-sonnet-5', 'deepseek-v4-pro']);
    for (const id of MODEL_PROFILE_IDS) {
      expect(live.has(GOOD_MAP_STATE.map.profiles[id])).toBe(true);
    }
  });

  it('two profiles pointing at the same model is valid -- Phase 1 abstracts, it does not re-tier', () => {
    expect(GOOD_MAP_STATE.map.profiles.analysis_efficient).toBe(GOOD_MAP_STATE.map.profiles.routine_lowcost);
  });

  it('resolution touches only the model -- account and config-dir are not part of this layer', () => {
    // Guards against scope creep: if a later change makes the profile carry an
    // account or CLAUDE_CONFIG_DIR, this assertion is where it surfaces.
    const r = resolveAgentModelFromConfig({ modelProfile: 'build_strong' }, GOOD_MAP_STATE, DEFAULT_MODEL, alias);
    expect(Object.keys(r).sort()).toEqual(['model', 'source']);
  });
});
