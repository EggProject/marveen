# agent-bundle.ts: single-line try-catch and defensive-guard branches block 100% branch coverage

## Location

`src/web/agent-bundle.ts`, lines 94, 126 and 461.

```ts
// line 94 (inside copyEntryInto)
if (!existsSync(src)) return

// line 126 (inside stageAgentDirForExport, channels loop)
try { if (!statSync(providerDir).isDirectory()) continue } catch { continue }

// line 461 (inside importAllAgentsBundle, agents loop)
try { if (!statSync(stagedAgentDir).isDirectory()) continue } catch { continue }
```

## Excerpt

Two structurally unrelated patterns both land here.

**1. `copyEntryInto`'s defensive guard (line 94, the early `return`).**

`copyEntryInto` is only called from `stageAgentDirForExport`, and every call
site has already gated on `existsSync(join(srcRoot, rel))` returning true:

```ts
for (const rel of PORTABLE_ENTRIES) {
  if (existsSync(join(srcRoot, rel))) {
    copyEntryInto(srcRoot, stageAgentDir, rel)
    staged.push(rel)
  }
}
```

Inside `copyEntryInto` the path is recomputed as `const src = join(srcRoot, rel)`
and `existsSync(src)` is checked again -- always true, so the early `return`
never fires. The function is not exported and the import paths do not call
it, so there is no test-side lever. Removing the redundant `existsSync` line
(or inlining `copyEntryInto`) would close the branch without changing
behaviour.

**2. v8 reports single-line `try { ... } catch { ... }` catch handlers as
uncovered even when the code is executed.**

Lines 126 and 461 are the same one-liner idiom:

```ts
try { if (!statSync(...).isDirectory()) continue } catch { continue }
```

The throw path is exercised by tests -- the test
`'skips agent entries that vanish between readdirSync and statSync (catch branch)'`
installs a `node:fs` mock that throws `ENOENT` for one entry, and the test
passes only because the catch fires (importing the other agent, skipping
the throwing one). Yet v8's branch counter on this v8 version marks the
catch as untaken. The same shape on `src/web/fleet-transfer.ts:593` and
`src/web/token-usage.ts:32/62` has the same behaviour.

This is a v8 instrumentation limitation, not a real branch gap. Splitting
the catch onto its own line (or an `istanbul ignore next` comment) is the
only way to register as covered.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. The suite drives every reachable branch of `copyEntryInto` and the
   per-entry checks of both import paths.
2. `copyEntryInto`'s `if (!existsSync(src)) return` is gated by the
   caller's `existsSync` check, so v8 records the early return as untaken.
3. The `catch { continue }` on a single-line `try { ... } catch { ... }` is
   not tracked correctly by v8 even when the throw path is hit.
4. Branch coverage caps at 98.29% (115/117) -- 1 dead branch from item 1
   and 1 false-negative branch per single-line try-catch (items 2 + 3 -> 1
   unique reported branch per file = 2 visible gaps).

## Pinning test

`src/__tests__/web-agent-bundle.test.ts`:

- `describe('stageAgentDirForExport') > 'copies the portable subset when
  present and returns the relative paths'` exercises the call site whose
  outer `existsSync` is the only thing keeping line 94 from firing.
- `describe('importAllAgentsBundle') > 'skips agent entries that vanish
  between readdirSync and statSync (catch branch)'` drives the catch arm
  via a `node:fs` mock that throws for one entry, then asserts only the
  other entry is imported.

## Suggested direction

Two independent edits; each removes the gap without changing behaviour.

(a) Line 94 -- drop the defensive inner `existsSync`, since every call site
    already checks:

    ```ts
    function copyEntryInto(srcRoot: string, dstRoot: string, rel: string): void {
      const dst = join(dstRoot, rel)
      mkdirSync(join(dst, '..'), { recursive: true })
      cpSync(srcRoot + sep + rel, dst, { recursive: true })
    }
    ```

    Or, if the redundant check is kept on purpose, add an `istanbul ignore
    next` on the line above it -- a single one-line annotation exempts the
    branch from the threshold check.

(b) Lines 126 / 461 -- split the `try { ... } catch { ... }` across two
    lines so v8 can attach branch counters to both arms. This is purely a
    formatting change:

    ```ts
    try {
      if (!statSync(stagedAgentDir).isDirectory()) continue
    } catch {
      continue
    }
    ```

Per task rule "NEVER modify src/web/agent-bundle.ts" the source edits are
blocked until the user overrides; the test suite documents the gap and pins
every reachable sibling branch.
