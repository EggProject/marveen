# federation.ts:93 -- rememberRef's `if (oldest !== undefined)` falsy arm is unreachable

## Location

`src/web/routes/federation.ts`, lines 88-95 (`rememberRef`):

```ts
function rememberRef(key: string, localId: number): void {
  if (seenRefs.size >= DEDUP_CAP) {
    const oldest = seenRefs.keys().next().value
    if (oldest !== undefined) seenRefs.delete(oldest)
  }
  seenRefs.set(key, localId)
}
```

## Excerpt

The `if (oldest !== undefined)` falsy arm at line 93 is
**structurally unreachable**. The outer `if (seenRefs.size >= DEDUP_CAP)`
gate fires only when the dedup map has at least 1000 entries. A Map with
>= 1 entry cannot have `keys().next().value === undefined` -- that
return value only happens when the iterator is exhausted (the map is
empty). So when we reach `oldest`, the map has at least 1000 keys and
`oldest` is always a string.

The guard exists as defensive insurance against a future Map
implementation that returns `undefined` for a populated map (impossible
in the current V8 Map contract, but cheap to write).

## Failure scenario

v8 reports `branch 2 line=93 type=if counts=[1, 0]` -- the truthy arm
hit once (in `routes-federation-full.test.ts`'s "drops the oldest entry
once the dedup map reaches DEDUP_CAP" test, which inserts 1000 + 1
entries), falsy arm never hit.

The 100% branch coverage gate fails on this file because of this dead
branch.

Options:

1. Drop the `if (oldest !== undefined)` guard. `oldest` is always a
   string here.
2. Use `seenRefs.keys().next().value!` (non-null assertion) to assert
   the invariant in TypeScript.
3. Leave the guard in place (current state) and add a pinning test
   that constructs an empty Map then mutates it to size >= 1000
   without ever calling `seenRefs.set()` -- impossible without breaking
   the function contract.

Option (1) is the cleanest fix.

## Pinning test

None. The dedup map is module-scoped in `federation.ts`; the only way
to construct a state where `seenRefs.size >= 1000` and
`keys().next().value === undefined` is to mutate the Map's internal
state through V8 internals -- which is not exposed via any API the test
can call.

The existing `routes-federation-full.test.ts` "DEDUP_CAP overflow"
test pushes the function through its real limit (1000 entries inserted,
then a 1001st triggers eviction) and the truthy arm fires exactly once.

## Suggested direction

Collapse the guard:

```ts
function rememberRef(key: string, localId: number): void {
  if (seenRefs.size >= DEDUP_CAP) {
    seenRefs.delete(seenRefs.keys().next().value as string)
  }
  seenRefs.set(key, localId)
}
```

The `as string` cast documents the invariant; the runtime check is
removed because it cannot fire.

Per task rule "NEVER modify src/web/routes/federation.ts" this requires
an explicit override from the user.