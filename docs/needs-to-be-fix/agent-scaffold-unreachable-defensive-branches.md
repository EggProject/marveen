# agent-scaffold.ts: four unreachable defensive branches block 100% branch coverage

## Location

`src/web/agent-scaffold.ts`, lines 278, 574, 576 and 581.

```ts
// line 278, inside ensureAgentHooks (the seed branch at line 271-281)
})).filter((entry) => (entry.hooks?.length ?? 0) > 0)

// line 574, inside injectDomainRestrictions
const sectionStart = heading ? (heading.index ?? 0) + heading[0].length : 0

// line 576, inside injectDomainRestrictions
const sectionEnd = nextHeading ? sectionStart + (nextHeading.index ?? 0) : stripped.length

// line 581, inside injectDomainRestrictions
const at = sectionStart + (last.index ?? 0) + last[0].length
```

## Excerpt

All four are defensive fallbacks that the surrounding code makes
unreachable. Each is dead for a different structural reason.

**1. `(entry.hooks?.length ?? 0)` (line 278, the `?? 0` right arm).**

This filter immediately follows a `.map` that always materialises an array:

```ts
const safeEntries = (entries as HookEntry[]).map((entry) => ({
  ...entry,
  hooks: (entry.hooks ?? []).filter((h) => !h.command || !isUnsafeHookCommand(h.command)),
})).filter((entry) => (entry.hooks?.length ?? 0) > 0)
```

The `entry.hooks` field is rewritten by the map to the result of
`Array.prototype.filter`, which always returns an array. So
`entry.hooks?.length` is always a number, never `undefined`, and the `?? 0`
fallback can never fire. The optional chain is the only piece that would be
load-bearing in the abstract; on this concrete value it is decorative.

**2-4. `heading.index ?? 0`, `nextHeading.index ?? 0`, `last.index ?? 0`**
(lines 574, 576, 581, all inside `injectDomainRestrictions`).

`RegExp.prototype.exec` returns `RegExpExecArray | null`. When the result is
non-null, the `index` property is always a number (the byte/character
position of the match). The three consumers gate on a truthy result before
reading `.index` (e.g. `heading ? heading.index ?? 0 : 0`), so the LHS of
each `??` is provably a number. The `?? 0` fallback can only fire when the
outer ternary has already routed the read to its `else` branch, where the
fallback's value is discarded anyway.

This mirrors the `auto-restart-runner` family of `?? Map.get(...)` fallbacks
already documented in `agent-restart-policy-consecutivefailures-nullish-coalesce.md`,
but here the type system (via the standard library) makes the deadness
provable: TypeScript types `RegExpExecArray.index` as `number`, not
`number | undefined`.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. `ensureAgentHooks` is driven through both the merge branch (existing
   hooks, all-`HookEntry` shapes) and the seed branch (no existing hooks).
2. In the seed branch, every `entry` that survives the unsafe-filter pass
   carries a real array; the `?? 0` is never evaluated with a missing LHS.
3. `injectDomainRestrictions` is driven with template content that does
   AND does not carry a `## Domain restriction` heading.
4. For every code path through the heading parse, `exec(...)` either returns
   null (in which case the outer ternary picks the `else` branch and `.index`
   is never read) or returns a match (in which case `.index` is a real
   number).
5. Branch coverage caps at 98.58% (278/282) while statements, lines and
   functions all reach 100%.

There is no test-side lever for any of these four: they are gated on the
shape of values produced by the surrounding code, not on any mockable
collaborator. Reaching them requires editing the source.

## Pinning test

`src/__tests__/agent-scaffold-baseline.test.ts`. The companion reachable
branches are covered by:

- `describe('ensureAgentHooks: HookEntry.hooks ?? [] right branches')` --
  exercises the eight `?? []` arms on `HookEntry.hooks`, and the
  `!existHook.command` early-continue (lines 178, 183, 184, 244, 248, 256,
  259). The defensive `?? 0` arm on line 278 is the single uncovered
  fallback in the same `.map(...).filter(...)` chain.
- `describe('ensureFleetRosterSection: roster prepend (line 810) +
  empty-roster (line 833)')` -- drives the `names.includes(MAIN_AGENT_ID)`
  both branches and the `(nincs regisztrált ágens)` fallback. The
  `injectDomainRestrictions` parse passes through those fleet-roster
  headers naturally; the dead `heading.index ?? 0` arms are the
  `?? 0` defensive fallbacks alongside.

## Suggested direction

Four independent one-line edits; each removes the dead fallback without
changing behaviour.

(a) Line 278 -- drop the optional chain and the fallback, since `entry.hooks`
    is now guaranteed to be an array:

    ```ts
    })).filter((entry) => entry.hooks.length > 0)
    ```

(b) Lines 574, 576, 581 -- drop the `?? 0` since the upstream `exec()` is
    either null (and the read is on the `else` arm) or a match with a real
    `index`:

    ```ts
    const sectionStart = heading ? heading.index + heading[0].length : 0
    const sectionEnd = nextHeading ? sectionStart + nextHeading.index : stripped.length
    const last = bullets[bullets.length - 1]
    const at = sectionStart + last.index + last[0].length
    ```

    Tightening `RegExpExecArray.index` is unnecessary (the spec already
    types it as `number`); the cleanup is purely visual.

Per task rule "NEVER modify src/web/agent-scaffold.ts" the source edits are
blocked until the user overrides; the test suite documents the gap and
covers every reachable sibling branch.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
