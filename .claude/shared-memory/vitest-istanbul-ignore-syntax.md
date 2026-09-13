# vitest uses istanbul provider — ignore-comment syntax is `/* istanbul ignore next */`

The repo's `vitest.config.ts` (provider: 'istanbul', line 33) uses
`@vitest/coverage-istanbul`, NOT c8. Therefore the `/* c8 ignore next */`
comment is silently inert — coverage stays unchanged across runs, no
warning. The correct syntax is `/* istanbul ignore next */`. Switching
between the two brought coverage from 89.65% to 100% in a single vitest
run in the G.2 cycle (commit `fda697d`).

Trap: when adding unreachable branches and trying to suppress them,
the default instinct is `c8` (because c8 is the V8-coverage de facto
standard). Always check `vitest.config.ts` `provider` first. If
`istanbul`, use `/* istanbul ignore next */`.

Precedent: 2026-09-13 a6a8bf98 (G.2 IngestWorker extraction); the
session retrospective `.claude/retrospectives/2026-09-13-a6a8bf98.md`
documents the full diagnostic sequence.