# Silent-catch-to-typed-throw scope check pattern (2026-09-07)

When migrating a `} catch { return <fallback> }` to `throw new XxxError(...)`, the planning step that checks for impact must be framed as a **CALLER check**, not a catch-site check.

## The bug mode

`grep -rn '<funcName>' src/ --include='*.ts' | grep -v __tests__ | grep -v '<selfFile>'` returns ALL callers — both call sites with their own try/catch wrapper AND call sites that rely on the fallback return value. The plan step that framed this grep as "catch site check" missed the second category.

If ANY caller has no try/catch wrapper around the call, the throw becomes uncaught in the rare error path that the silent catch had previously hidden. User-facing impact:

- HTTP 500 from a route handler that consumed the call's result and the fallback was load-bearing
- Process crash from a top-level function call (no upstream error handler)
- Silent data corruption from a downstream consumer that expected the fallback shape and didn't handle the throw

## The fix (in the planning phase)

For each caller in the grep output, classify it:

1. **Has own try/catch around the call** → throw is compatible, scope unchanged. The caller's catch handles the throw consistently with its own semantics.
2. **Relies on the fallback return value** (e.g. `const ftsResults = searchMemories(...)` and then iterate over `ftsResults`) AND has no try/catch → two options:
   - **(a) Scope expand in the SAME cycle**: add `try { ... } catch (err) { if (err instanceof XxxError) { <fallback> } else { throw err } }` in the caller, preserving graceful degradation. This is the H.4 pattern (e.g. `http-helpers.ts:46` reject + caller-handled via Express middleware).
   - **(b) Abort the throw migration**: keep the silent `return <fallback>` in the original function. The error path stays silent but at least no new uncaught errors are introduced.

Option (a) is preferred when the H.4 / AppError convention has already been established in the codebase. Option (b) is preferred for purely internal helper functions where the silent failure is well-understood and documented.

## Canonical example: A.8 cycle (2026-09-07)

The `searchMemories` function (`src/db.ts:239-256`) had `try { ... } catch { return [] }` (silent FTS5 parse failure → empty results). The throw migration to `MemoryStoreError` would have been uncaught in:

- `src/memory.ts:83` (`buildMemoryContext`): relied on the `[]` fallback to compose with `recentMemories`; FTS5 failure would have crashed the memory-context pipeline (which is called from the agent turn loop, so a thrown error there halts the turn).
- `src/web/routes/memories.ts:89` (route handler): relied on the `[]` fallback to fall through to the LIKE-based search at L91-93; FTS5 failure would have produced HTTP 500 instead of the degraded LIKE results.

User approved scope expansion (3 extra files, ~25 extra lines) before implementation. Both callers got `try { ... } catch (err) { if (err instanceof MemoryStoreError) { <fallback> } else { throw err } }` wrappers:

- `memory.ts:84-94`: `ftsResults = []` fallback (graceful degradation, `recent` memories still available).
- `memories.ts:89-99`: `results = []` + LIKE fallback at L91-93.

The `else { throw err }` branches are defensive dead code in production (the wrapped `searchMemories` never throws a non-`MemoryStoreError` after the throw migration), but represent intentional defense-in-depth.

## Anti-pattern

Framing the planning step as "catch site check" (which would only return calls inside `catch` blocks) under-counts the impact by missing all the unwrapped callers. The grep output is a CALLER list — frame it that way in the plan, in the verifier prompts, and in the implementer's step-by-step instructions.

## Related

- A.8 cycle lessons: `.claude/shared-memory/a8-memory-store-error-cycle-lessons.md` — the session that surfaced this pattern (commits 2c4669f + 283fd82, scope-expand user approval).
- `class-vs-functional-decision.md` — when deciding whether the throw migration itself is justified. A.8 was justified because H.4 had established the AppError convention in commit `be2a450`; without that precedent, the migration would have been ceremony.
- CLAUDE.md §7 "kötelező mindig commitolni" — applies to scope-expansion commits too.
- CLAUDE.md §8 "Integráció implementálása előtt ellenőrizd, hogy a célfüggvény production-ból hívódik" — the `grep` described here is the implementation of that rule.
