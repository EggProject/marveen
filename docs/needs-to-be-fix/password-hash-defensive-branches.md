# password-hash.ts: two defensive branches unreachable through real inputs

## Location

`src/web/password-hash.ts`, lines 100-102 and 112.

```ts
// line 97-102, inside verifyScrypt
try {
  salt = Buffer.from(parts[3], 'base64')
  expected = Buffer.from(parts[4], 'base64')
} catch {
  return false
}

// line 108-112, inside verifyScrypt
derived = await scrypt(pw, salt, expected.length, { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: MAXMEM })
// ...
if (derived.length !== expected.length) return false
```

## Excerpt

Both branches are defensive fallbacks with no production-grade input that
reaches them.

**1. `Buffer.from(parts[3], 'base64')` catch (line 101).**

`phc.split('$')` always yields strings, and `parts[3]` is a member of that
array, so the first argument is always a string. Node's `Buffer.from(string,
'base64')` is documented to be lenient: invalid base64 characters are
silently dropped, empty inputs yield an empty buffer. It does not throw on
any string input, so the `catch` on line 100-102 has no trigger reachable
through public calls.

There is no test-side lever either: `parts` is a fresh array returned by
`String.prototype.split`, and its indices are ordinary strings. The only
way to make the catch fire is to monkey-patch `Buffer.from` itself, which
the suite does via `vi.spyOn` (see pinning test below). Without that
mock, the catch stays uncovered.

**2. `derived.length !== expected.length` early return (line 112).**

The keylen argument to scrypt is `expected.length`, and Node's `scrypt`
returns a `Buffer` whose `length` equals that keylen exactly. So
`derived.length === expected.length` is structurally guaranteed and the
condition never holds.

There is also no test-side lever that does not require module-level
mocking: the `scrypt` constant inside the module is built from
`promisify(scryptCb)` at module load, and `vi.spyOn` cannot redefine the
namespace export of `node:crypto` (ESM module namespace is not
configurable). The suite reaches the branch by re-importing the module
under a `vi.doMock('node:crypto', ...)` that swaps `scrypt` for a stub
returning `Buffer.alloc(keylen + 1)`.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A caller drives every reachable path of `verifyPassword` /
   `verifyScrypt` / `parseScryptParams` -- including a 5-part non-scrypt
   hash, an unknown params key, missing r or p, ln >= 17 (maxmem
   overflow), a null/undefined pw or phc, an argon2 hash under node, and
   an argon2 hash under a fake Bun runtime.
2. `Buffer.from(string, 'base64')` is never called with anything that
   throws, so v8 records line 101 as untaken.
3. `derived.length !== expected.length` is structurally false, so v8
   records line 112 as untaken.
4. Without the two `vi.spyOn` / `vi.doMock` helpers in the suite, branch
   coverage caps at 98% (49/50) and statement coverage at 97.18%
   (69/71); with them, both reach 100%.

## Pinning test

`src/__tests__/password-hash.test.ts`. The reachable siblings are covered
so the gap is exactly the two defensive arms above:

- `describe('hashPassword / verifyPassword')`:
  - "swallows a synchronous throw from Buffer.from inside the base64 try"
    -- wraps `Buffer.from` via `vi.spyOn` to force a throw on the next
    `'base64'` call, asserting the verifier still returns `false`. Pins
    line 101.
  - "returns false when scrypt produces a derived key whose length
    differs from the stored key" -- `vi.doMock('node:crypto')` plus
    `vi.resetModules` re-import the module with a fake scrypt that
    returns `Buffer.alloc(keylen + 1)`. The verifier's `derived.length
    !== expected.length` guard then fires. Pins line 112.

## Suggested direction

Both arms are pure defensive scaffolding; removing them does not change
behaviour in any production code path. If the project later adopts a
hard-line "no unreachable branches" policy, the smallest viable edits
are:

(a) Lines 100-102 -- collapse the try/catch and let an eventual
    `Buffer.from` exception propagate. Currently this is impossible
    (`Buffer.from(string, 'base64')` is documented not to throw), so the
    edit is safe. If the future intent is "also handle base64url or
    hex-encoded salts", the explicit guard should grow with that.

(b) Line 112 -- drop the `if`. The keylen argument pins
    `derived.length === expected.length`, so the check is tautological.
    The remaining `timingSafeEqual(derived, expected)` is the actual
    constant-time compare; `timingSafeEqual` itself throws on length
    mismatch, which is a stronger failure mode than `return false`.

Per task rule "NEVER modify src/web/password-hash.ts" the source edits
are blocked until the user overrides; the test suite documents the gap
and pins every reachable sibling branch via the two `vi.spyOn` /
`vi.doMock` shims above, taking coverage to 100% across all four
metrics.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
