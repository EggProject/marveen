# D.1 — `ChannelEnv` class extraction (FULL migration, no legacy wrappers)

## Context

**Goal:** Introduce `class ChannelEnv` in `src/channel-provider.ts` AND immediately migrate all 42 call sites across 12 files. The 4 legacy free functions (`getChannelToken`, `getChannelChatId`, `channelStateDir`, `readChannelToken`) are **deleted** — no wrappers, no `@deprecated` shims, no migration window.

**Why full migration (user decision, 2026-09-04):** the user explicitly rejected legacy/deprecated code patterns. The clean cut means every consumer updates to the class API in the same commit that introduces the class.

**Why D.1 now:**
- D.2 (5 provider classes + `UnsupportedDirectSendProvider` base, commit `10d06cb`, 2026-08-30) and D.4 (`withTestRunMarking` explicit-delegation, commit `ed2dd0b`) already landed.
- D.1 is independent of B.1 (`Config` class): the constructor takes `env: Record<string, string>` (parsed env record, NOT `process.env`).
- Constructor-DI justifies class form per `.claude/rules/class-vs-functional-decision.md`: Q4 (Constructor-injected DI) = YES, Q5 (per-instance test isolation) = YES. ≥2-YES threshold cleared.
- **All 4 helpers become instance methods** (`static`-ceremony trap avoided per `.claude/rules/class-vs-functional-decision.md`: "Class ahol minden metódus `static` és nincs `this`" = ceremony).

**Risk re-classification:** full migration is no longer "lowest risk" — it touches 12 production files + 7 mock factories. The mitigation is the strict TypeScript signature preservation (every call site change is mechanical and compile-time-checked), the workflow's double-verification barrier, and the 100%-coverage gate.

## Scope

### Source files

| File | Change |
|---|---|
| `src/channel-provider.ts` | Insert `class ChannelEnv` (above current `getChannelToken` line 500); DELETE the 4 free functions `getChannelToken` (`:500-506`), `getChannelChatId` (`:508-514`), `channelStateDir` (`:572-583`), `readChannelToken` (`:585-603`); also delete any import statements that become unused |
| `src/__tests__/channel-env.test.ts` | New file: 20 `it()` blocks + vacuous-test table (see §Test strategy) |
| `src/config.ts` | `:8` import update; `:325-326` call site migration |
| `src/notify.ts` | Verify it does NOT import any of the 4 (it imports `getProvider`, untouched) |
| 11 other production files | `channelStateDir` and/or `readChannelToken` call sites updated (see §Call site migration) |
| 7 test files | `vi.mock('../channel-provider.js')` factories updated (see §Mock factory migration) |
| `docs/refactor-to-classbase/d-channel-provider/{00-summary,05-refactor-roadmap,03-class-boundaries}.md` | Status flips + line citation updates |
| `docs/refactor-to-classbase/00-summary.md` | Top-3 list re-check |

### Class shape

```ts
// Inserted in src/channel-provider.ts immediately above the (now deleted)
// getChannelToken line. All methods are INSTANCE methods (no static ceremony).
class ChannelEnv {
  static readonly TABLE: Record<ChannelProviderType, {
    readonly tokenKey: string
    readonly chatIdKey: string
    readonly subdir: string
  }> = {
    telegram:   { tokenKey: 'TELEGRAM_BOT_TOKEN',          chatIdKey: 'ALLOWED_CHAT_ID',                subdir: 'telegram'   },
    slack:      { tokenKey: 'SLACK_BOT_TOKEN',             chatIdKey: 'SLACK_CHANNEL_ID',               subdir: 'slack'      },
    discord:    { tokenKey: 'DISCORD_BOT_TOKEN',           chatIdKey: 'DISCORD_CHANNEL_ID',             subdir: 'discord'    },
    googlechat: { tokenKey: 'GOOGLECHAT_PROJECT_ID',       chatIdKey: 'GOOGLECHAT_SPACE_ID',            subdir: 'googlechat' },
    teams:      { tokenKey: 'TEAMS_BOT_APP_ID',            chatIdKey: 'TEAMS_ALLOWED_CONVERSATION_ID', subdir: 'teams'      },
  }

  constructor(private readonly env: Record<string, string> = {}) {}

  getToken(provider: ChannelProviderType): string {
    return this.env[ChannelEnv.TABLE[provider].tokenKey] ?? ''
  }

  getChatId(provider: ChannelProviderType): string {
    return this.env[ChannelEnv.TABLE[provider].chatIdKey] ?? ''
  }

  stateDirFor(provider: ChannelProviderType, agentDir?: string): string {
    const base = agentDir
      ? join(agentDir, '.claude', 'channels')
      : join(homedir(), '.claude', 'channels')
    switch (provider) {
      case 'telegram':   return join(base, 'telegram')
      case 'slack':      return join(base, 'slack')
      case 'discord':    return join(base, 'discord')
      case 'googlechat': return join(base, 'googlechat')
      case 'teams':      return join(base, 'teams')
    }
  }

  readTokenFor(provider: ChannelProviderType, envFilePath: string): string | null {
    if (!existsSync(envFilePath)) return null
    try {
      const raw = readFileSync(envFilePath, 'utf8')
      const key = ChannelEnv.TABLE[provider].tokenKey
      const match = raw.match(new RegExp(`^${key}=(.+)$`, 'm'))
      return match ? (match[1] ?? null) : null
    } catch {
      return null
    }
  }
}
```

### Migration pattern (apply to every call site)

```ts
// Before → After
getChannelToken(provider, env)               → new ChannelEnv(env).getToken(provider)
getChannelChatId(provider, env)             → new ChannelEnv(env).getChatId(provider)
channelStateDir(provider, agentDir?)        → new ChannelEnv().stateDirFor(provider, agentDir)
readChannelToken(provider, envFilePath)     → new ChannelEnv().readTokenFor(provider, envFilePath)
```

For call sites where `env` (parsed env record) is already in scope, pass it directly. For call sites where it isn't, default `env = {}` works because:
- `getToken`/`getChatId` for missing keys return `''` (graceful degradation)
- `stateDirFor`/`readTokenFor` don't consume `this.env`

### Call site migration (live-grepped 2026-09-04)

**Pattern repeats across files; representative paths listed below. The implementation agent MUST grep again at start to catch any drift.**

| Old call | New call | Files (representative) |
|---|---|---|
| `getChannelToken(provider, env)` | `new ChannelEnv(env).getToken(provider)` | `src/config.ts:325` |
| `getChannelChatId(provider, env)` | `new ChannelEnv(env).getChatId(provider)` | `src/config.ts:326` |
| `channelStateDir(provider, agentDir?)` | `new ChannelEnv().stateDirFor(provider, agentDir)` | `liveness.ts`, `agent-process.ts`, `agent-scaffold.ts`, `channel-invites.ts`, `channel-monitor.ts`, `channel-poller-reap.ts`, `channel-request-watcher.ts`, `discord-group-bootstrap.ts`, `routes/agents.ts`, `routes/onboarding.ts`, `schedule-runner.ts`, `telegram.ts` — 31 sites |
| `readChannelToken(provider, envFilePath)` | `new ChannelEnv().readTokenFor(provider, envFilePath)` | `channel-request-watcher.ts`, `agent-process.ts`, `routes/agents.ts`, `routes/onboarding.ts`, `channel-monitor.ts` — 9 sites |

Total: **42 call sites, 12 production files.** The implementation agent verifies count with `grep -rn 'channelStateDir\|readChannelToken\|getChannelToken\|getChannelChatId' src/ --include='*.ts' | grep -v __tests__` before merge.

### Mock factory migration (7 test files)

| Mock factory shape | New shape |
|---|---|
| `vi.mock('../channel-provider.js', () => ({ readChannelToken: vi.fn(() => null), ... }))` | `vi.mock('../channel-provider.js', () => ({ ChannelEnv: vi.fn().mockImplementation(() => ({ readTokenFor: vi.fn(() => null), ... })), ... }))` |
| `vi.doMock(join(SRC_DIR, '..', 'channel-provider.js'), () => ({ channelStateDir: m.channelStateDir, ... }))` | `vi.doMock(join(SRC_DIR, '..', 'channel-provider.js'), () => ({ ChannelEnv: vi.fn().mockImplementation(() => ({ stateDirFor: m.stateDirFor, ... })), ... }))` |

Files needing mock factory update (live-grepped 2026-09-04):
- `src/__tests__/onboarding-routes.test.ts:74`
- `src/__tests__/channel-monitor-coverage.test.ts:279`
- `src/__tests__/agent-process.test.ts:200`
- `src/__tests__/channel-monitor-baseline.test.ts:268`
- `src/__tests__/agents-routes.test.ts:449`
- `src/__tests__/channel-monitor.test.ts:284`
- `src/__tests__/channel-coordinator-liveness.test.ts:99`

Pattern: each mock factory returns an object that includes `ChannelEnv` as a `vi.fn()` that returns instances with mocked methods. The agent MUST read each test file's existing assertions to keep them passing — the new `ChannelEnv` instance must expose `readTokenFor`/`stateDirFor` as `vi.fn()` with the same return values as before.

### What gets DELETED from `src/channel-provider.ts`

- Lines `:500-506` `export function getChannelToken(...)` (the function and its 5-branch chain)
- Lines `:508-514` `export function getChannelChatId(...)` (the function and its 5-branch chain)
- Lines `:572-583` `export function channelStateDir(...)` (the function and its 5-branch chain)
- Lines `:585-603` `export function readChannelToken(...)` (the function and its 5-branch chain)
- Any related JSDoc or comments
- Any now-unused imports (the implementation agent must check `homedir`, `join`, `readFileSync`, `existsSync` are still used by `class ChannelEnv`; if not, remove them)

### `src/notify.ts` — NO edit needed

`src/notify.ts:1-5` imports `CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID` from `./config.js` and `getProvider` from `./channel-provider.js`. None of the 4 deleted helpers are imported. Verified live 2026-09-04.

### `src/__tests__/channel-provider-classes.test.ts` + `src/__tests__/channel-provider.test.ts` — verify

These two test files do NOT import the 4 helpers (verified by `grep`). They test the D.2 provider classes. NO edit needed for the migration — but if they import from `../channel-provider.js` and rely on named exports, the import list must remain valid (D.1 only deletes the 4 helpers; all other named exports stay).

## Measured baselines (2026-09-04 against HEAD `2a9fd96`, clean)

| Gate | Baseline | D.1 target |
|---|---|---|
| `bun tsc --noEmit` | 0 errors | 0 errors (strict equality) |
| `bun --bun vitest run` (full suite) | 11228 / 11228 passed (384 files, 131.95s) | 11248+ passed (11228 + 20 new in `channel-env.test.ts`; strictly non-decreasing) |
| `bun --bun vitest run src/__tests__/channel-provider-classes.test.ts src/__tests__/channel-provider.test.ts` | 146 / 146 passed (244ms) | 146+ passed (strictly non-decreasing) |
| `bun run lint` | 9783 problems | 9783 problems (no change — no new `as`/`any`/concatenation) |
| HEAD | `2a9fd96` | `(this commit)` |
| `git log -1 --format='%an <%ae>'` | `EggProjectTeams <eggprojectteams@gmail.com>` | Same after D.1 (mandatory pre-flight) |
| `git config user.email` | `eggprojectteams@gmail.com` | (reference) |

If `bun --bun vitest run` finds **>5 fails**, per CLAUDE.md §8 the implementation agent MUST also run on baseline commit `a330462` in a separate worktree to distinguish pre-existing regressions from D.1-introduced ones.

## Implementation steps

Each step → verify sub-step. Production code first, then tests, then docs, then merge.

1. **Worktree setup.** `git worktree add --detach $HOME/claw-d1-test refactor/classbase` + `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-d1-test/node_modules`. Verify `git log -1 --format='%an <%ae>'` matches `git config user.email`.
2. **Re-grep call sites (defensive).** Run `grep -rn 'channelStateDir\|readChannelToken\|getChannelToken\|getChannelChatId' src/ --include='*.ts' | grep -v __tests__` and confirm 42 sites / 12 files. If count differs, stop and re-plan.
3. **Insert `class ChannelEnv`** in `src/channel-provider.ts` immediately above current line 500. Reuses existing imports (`homedir`, `join`, `readFileSync`, `existsSync`).
   - Verify: `bun tsc --noEmit` stays at 0 errors.
4. **Delete the 4 free functions** from `src/channel-provider.ts` (lines `:500-506`, `:508-514`, `:572-583`, `:585-603`). Clean up unused imports if any.
   - Verify: `grep -n 'export function \(getChannelToken\|getChannelChatId\|channelStateDir\|readChannelToken\)' src/channel-provider.ts` returns zero matches.
5. **Migrate `src/config.ts:325-326`** from `getChannelToken(...)`/`getChannelChatId(...)` to `new ChannelEnv(env).getToken(...)` / `.getChatId(...)`. Update import at `:8`.
   - Verify: `bun tsc --noEmit` still 0 errors.
6. **Migrate the 31 `channelStateDir` call sites** across 11 files. Pattern: replace `channelStateDir(P, A?)` with `new ChannelEnv().stateDirFor(P, A?)`. Update any imports.
   - Verify: `grep -rn 'channelStateDir(' src/ --include='*.ts' | grep -v __tests__` returns zero matches.
7. **Migrate the 9 `readChannelToken` call sites** across 5 files. Pattern: replace `readChannelToken(P, F)` with `new ChannelEnv().readTokenFor(P, F)`. Update any imports.
   - Verify: `grep -rn 'readChannelToken(' src/ --include='*.ts' | grep -v __tests__` returns zero matches.
8. **Migrate the 7 mock factories** in test files. Each `vi.mock('../channel-provider.js', () => ({ ... }))` must now return `{ ChannelEnv: vi.fn().mockImplementation(() => ({ readTokenFor: vi.fn(...), stateDirFor: vi.fn(...), getToken: vi.fn(...), getChatId: vi.fn(...) })), ... }`.
   - Verify: `bun --bun vitest run src/__tests__/onboarding-routes.test.ts src/__tests__/channel-monitor-coverage.test.ts src/__tests__/agent-process.test.ts src/__tests__/channel-monitor-baseline.test.ts src/__tests__/agents-routes.test.ts src/__tests__/channel-monitor.test.ts src/__tests__/channel-coordinator-liveness.test.ts` shows all 7 suites passing.
9. **Create `src/__tests__/channel-env.test.ts`** with 20 `it()` blocks (see §Test strategy).
10. **Run gate suite** — `bun tsc --noEmit`, `bun --bun vitest run` (full), `bun --bun vitest run channel-provider-classes + channel-provider + channel-env` subset, `bun run lint`.
11. **Docs updates** — flip D.1 status in 3 doc files (§Documentation).
12. **Commit** — single commit (or two: code + docs) with `(this commit)` placeholder for SHA; verify `git log -1 --format='%an <%ae>'` matches `git config user.email` BEFORE next step.
13. **Merge** — `git merge --ff-only <SHA>` from the detached worktree back to `refactor/classbase`. Per CLAUDE.md §8, NEVER `git reset --hard`.
14. **Cleanup** — `git worktree remove $HOME/claw-d1-test --force` (BEFORE merge, per CLAUDE.md §8).

## Test strategy

### `src/__tests__/channel-env.test.ts` — 20 `it()` blocks

Mirror `channel-provider-classes.test.ts` structure: top-level `describe('ChannelEnv', …)`, import `ChannelEnv` and `type ChannelProviderType` from `../channel-provider.js`. Each `it()` has a concrete non-vacuous assertion (see §Vacuous-test check).

```ts
describe('ChannelEnv constructor injection (CLAUDE.md DR4 regression gate)', () => {
  it('getToken reads from constructor-injected env, NOT process.env', () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_BOT_TOKEN
    try {
      const env = new ChannelEnv({ TELEGRAM_BOT_TOKEN: 'injected' })
      expect(env.getToken('telegram')).toBe('injected')
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved
    }
  })
})

describe('ChannelEnv.getToken (5-provider dispatch, env-derived)', () => {
  it('returns env.TELEGRAM_BOT_TOKEN for telegram', () => {
    expect(new ChannelEnv({ TELEGRAM_BOT_TOKEN: 'tg' }).getToken('telegram')).toBe('tg')
  })
  it('returns env.SLACK_BOT_TOKEN for slack', () => {
    expect(new ChannelEnv({ SLACK_BOT_TOKEN: 'sk' }).getToken('slack')).toBe('sk')
  })
  it('returns env.DISCORD_BOT_TOKEN for discord', () => {
    expect(new ChannelEnv({ DISCORD_BOT_TOKEN: 'dc' }).getToken('discord')).toBe('dc')
  })
  it('returns env.GOOGLECHAT_PROJECT_ID for googlechat', () => {
    expect(new ChannelEnv({ GOOGLECHAT_PROJECT_ID: 'gc' }).getToken('googlechat')).toBe('gc')
  })
  it('returns env.TEAMS_BOT_APP_ID for teams', () => {
    expect(new ChannelEnv({ TEAMS_BOT_APP_ID: 'tm' }).getToken('teams')).toBe('tm')
  })
  it('returns "" (NOT undefined) when key missing', () => {
    expect(new ChannelEnv({}).getToken('telegram')).toBe('')
  })
  it('ignores unexpected keys, only reads TABLE-defined keys', () => {
    const env = new ChannelEnv({ RANDOM_KEY: 'x', TELEGRAM_BOT_TOKEN: 'tg', ANOTHER: 'y' })
    expect(env.getToken('telegram')).toBe('tg')
  })
})

describe('ChannelEnv.getChatId (5-provider dispatch, env-derived)', () => {
  it('returns env.ALLOWED_CHAT_ID for telegram (NOT TELEGRAM_CHAT_ID — legacy quirk)', () => {
    expect(new ChannelEnv({ ALLOWED_CHAT_ID: '1268077055' }).getChatId('telegram')).toBe('1268077055')
  })
  it('returns env.SLACK_CHANNEL_ID for slack', () => {
    expect(new ChannelEnv({ SLACK_CHANNEL_ID: 'C01234' }).getChatId('slack')).toBe('C01234')
  })
  it('returns env.DISCORD_CHANNEL_ID for discord', () => {
    expect(new ChannelEnv({ DISCORD_CHANNEL_ID: '1234567890' }).getChatId('discord')).toBe('1234567890')
  })
  it('returns env.GOOGLECHAT_SPACE_ID for googlechat', () => {
    expect(new ChannelEnv({ GOOGLECHAT_SPACE_ID: 'spaces/AAAA' }).getChatId('googlechat')).toBe('spaces/AAAA')
  })
  it('returns env.TEAMS_ALLOWED_CONVERSATION_ID for teams', () => {
    expect(new ChannelEnv({ TEAMS_ALLOWED_CONVERSATION_ID: '19:abc' }).getChatId('teams')).toBe('19:abc')
  })
  it('returns "" when key missing', () => {
    expect(new ChannelEnv({}).getChatId('telegram')).toBe('')
  })
})

describe('ChannelEnv.stateDirFor (instance method, not static)', () => {
  it('returns agentDir verbatim when provided (telegram)', () => {
    expect(new ChannelEnv().stateDirFor('telegram', '/custom/dir')).toBe(join('/custom/dir', '.claude', 'channels', 'telegram'))
  })
  it('returns agentDir verbatim when provided (slack)', () => {
    expect(new ChannelEnv().stateDirFor('slack', '/var/lib/slack')).toBe(join('/var/lib/slack', '.claude', 'channels', 'slack'))
  })
  it('falls back to <homedir>/.claude/channels/<subdir> when agentDir is undefined', () => {
    const result = new ChannelEnv().stateDirFor('discord', undefined)
    expect(result).toBe(join(homedir(), '.claude', 'channels', 'discord'))
  })
  it('falls back to homedir when agentDir is empty string (truthy check, NOT !== undefined)', () => {
    const result = new ChannelEnv().stateDirFor('googlechat', '')
    expect(result).toBe(join(homedir(), '.claude', 'channels', 'googlechat'))
    expect(result).not.toBe('')
  })
  it('uses TABLE subdir for teams', () => {
    const result = new ChannelEnv().stateDirFor('teams', '/agent')
    expect(result.endsWith('/teams')).toBe(true)
  })
})

describe('ChannelEnv.readTokenFor (instance method, 3 null paths)', () => {
  it('returns null when the envFilePath does not exist', () => {
    expect(new ChannelEnv().readTokenFor('telegram', '/nonexistent/.env')).toBeNull()
  })
  it('returns the matched value when the file has TELEGRAM_BOT_TOKEN=...', () => {
    const tmp = `${os.tmpdir()}/channel-env-test-${Date.now()}.env`
    fs.writeFileSync(tmp, 'TELEGRAM_BOT_TOKEN=test-token-123\n', 'utf8')
    try {
      expect(new ChannelEnv().readTokenFor('telegram', tmp)).toBe('test-token-123')
    } finally { fs.unlinkSync(tmp) }
  })
  it('returns null when the file has no matching KEY=... line', () => {
    const tmp = `${os.tmpdir()}/channel-env-test-${Date.now()}-no-match.env`
    fs.writeFileSync(tmp, 'OTHER_KEY=value\n', 'utf8')
    try {
      expect(new ChannelEnv().readTokenFor('telegram', tmp)).toBeNull()
    } finally { fs.unlinkSync(tmp) }
  })
  it('returns null when readFileSync throws (passing a directory path)', () => {
    expect(new ChannelEnv().readTokenFor('telegram', os.tmpdir())).toBeNull()
  })
})
```

### Vacuous-test check (CLAUDE.md §8 E.1/E.2 precedent)

For each `it()` above, mentally simulate the implementation stripped to `return undefined` (or always-throw). Each MUST fail:

| `it()` | No-op result | Test failure |
|---|---|---|
| `getToken('telegram') returns 'tg'` | `undefined` | `expect(undefined).toBe('tg')` → FAIL |
| `getToken returns '' when key missing` | `undefined` (no `?? ''`) | `expect(undefined).toBe('')` → FAIL |
| `getToken ignores unexpected keys` | returns `undefined` or reads first key | FAIL |
| `getChatId('telegram') returns '1268077055'` | `undefined` | FAIL |
| `stateDirFor('telegram', '/custom/dir')` | `undefined` | FAIL |
| `stateDirFor falls back when agentDir undefined` | `undefined` | FAIL |
| `stateDirFor empty-string agentDir falls back` | returns `''` or `undefined` | exact-equality + suffix → FAIL |
| `readTokenFor returns null for missing file` | `undefined` | `expect(undefined).toBeNull()` → FAIL |
| `readTokenFor returns matched value` | `undefined` | FAIL |
| `readTokenFor returns null for no-match file` | `undefined` (no regex) | FAIL |
| `readTokenFor returns null when readFileSync throws` | re-throws the EISDIR error | unhandled rejection → FAIL |

**No vacuous tests.** Every assertion would fail under a no-op implementation.

### Coverage target

Maintain current per-file coverage (cited in §Measured baselines).

## Verification gates (with measured baselines)

Same as §Measured baselines. Additional gates for the full migration:

| Gate | Source | Target |
|---|---|---|
| `grep -rn 'export function \(getChannelToken\|getChannelChatId\|channelStateDir\|readChannelToken\)' src/ --include='*.ts'` | implementation agent | 0 matches (legacy functions deleted) |
| `grep -rn 'channelStateDir(' src/ --include='*.ts' \| grep -v __tests__` | implementation agent | 0 matches |
| `grep -rn 'readChannelToken(' src/ --include='*.ts' \| grep -v __tests__` | implementation agent | 0 matches |
| `grep -rn 'getChannelToken\|getChannelChatId' src/ --include='*.ts' \| grep -v __tests__` | implementation agent | 0 matches (only `class ChannelEnv` references remain) |
| `grep -rn 'class ChannelEnv' src/ --include='*.ts' \| grep -v __tests__` | implementation agent | ≥1 match (the new class declaration) |
| `grep -rn 'class ChannelEnv' src/__tests__/ --include='*.ts'` | implementation agent | ≥1 match (the new test file) |

## Workflow design

**Recommendation: Option A — single-phase Workflow tool with `parallel()` barrier.**

Phases (via `phase()`):

1. **Setup** — worktree + node_modules symlink + author pre-flight check.
2. **Implement** — single `claude` agent executes §Implementation steps 1-12 in the worktree. Outputs diff + `git status --short` as structured output.
3. **Verify1 (parallel)** — Verifier A (structured PASS/FAIL checklist).
4. **Verify2 (parallel)** — Verifier B (adverzariális falsification).
5. **Merge barrier** — `parallel()` aggregates Verify1 + Verify2. Both must PASS before merge.
6. **Merge** — `git merge --ff-only <SHA>`. NEVER `git reset --hard`.
7. **Cleanup** — `git worktree remove --force` BEFORE merge.
8. **Docs commit** — separate commit flips D.1 status in 3 doc files.
9. **Final gate** — `bun tsc --noEmit`, `bun --bun vitest run` (full), `bun run lint`. Document results.

**Why Workflow tool:** barrier + structured output schema + 2 coordinated verifiers with different angles = exactly the Workflow tool's use case per CLAUDE.md §8.

## Double verification subagent prompts

Both READ-ONLY. Both output schema: `{ items: [{ probe/claim, verdict/result, evidence }] }`. Both run in parallel.

### Verifier A — Structured PASS/FAIL checklist

```
You are Verifier A. Read live source (NO edits).

Claims to verify (PASS/FAIL with quoted file:line + git evidence):
1. class ChannelEnv exists at src/channel-provider.ts (above current line 500)
2. ChannelEnv has 4 instance methods: getToken, getChatId, stateDirFor, readTokenFor (NOT static)
3. ChannelEnv has static readonly TABLE with all 5 entries: telegram, slack, discord, googlechat, teams
4. TABLE.telegram.chatIdKey === 'ALLOWED_CHAT_ID' (legacy quirk pin)
5. TABLE.googlechat.tokenKey === 'GOOGLECHAT_PROJECT_ID'
6. The 4 free functions are DELETED (no export function declarations for getChannelToken, getChannelChatId, channelStateDir, readChannelToken)
7. No @deprecated JSDoc remains in src/channel-provider.ts related to channel-env helpers
8. src/config.ts:325-326 migrated to new ChannelEnv(env).getToken(...) / .getChatId(...)
9. All 31 channelStateDir call sites migrated to new ChannelEnv().stateDirFor(...)
10. All 9 readChannelToken call sites migrated to new ChannelEnv().readTokenFor(...)
11. All 7 vi.mock factory files updated to expose ChannelEnv as vi.fn()
12. src/__tests__/channel-env.test.ts exists with 20 it() blocks + vacuous-test table
13. Each new it() has a concrete expected-value assertion (no typeof-only patterns)
14. stateDirFor uses `if (agentDir)` truthy check (NOT !== undefined)
15. readTokenFor has all 3 null paths (file missing, throws, no match)
16. bun tsc --noEmit returns 0 errors
17. bun --bun vitest run (full) passes 11248+ tests
18. bun --bun vitest run channel-provider-classes + channel-provider + channel-env passes 166+ tests
19. bun run lint returns 9783 problems (no new ones)
20. git log -1 --format='%an <%ae>' matches git config user.email
21. Working tree clean before merge
22. No 'as' casts, no 'any' types, no string concatenation in the new code (CLAUDE.md §7)
23. No git push occurred (CLAUDE.md §6)
24. (this commit) placeholder used in docs, NOT inline SHA (CLAUDE.md §8)
25. grep -rn 'export function \(getChannelToken\|getChannelChatId\|channelStateDir\|readChannelToken\)' src/ returns 0 matches
```

### Verifier B — Adversarial falsification

```
You are Verifier B (falsifier). Your job is to BREAK the implementation. Read-only.

DO NOT use Verifier A's checklist. Independently attempt:

1. Construct `new ChannelEnv({})` empty env, verify each method's edge-case behavior:
   - getToken('telegram') === '' (not undefined, not throw)
   - getChatId('telegram') === '' (not undefined)
   - stateDirFor('telegram', undefined) ends with `/telegram` (full path)
   - readTokenFor('telegram', '/nonexistent') === null (not undefined, not throw)

2. Run vitest on baseline a330462 (in $HOME/claw-test-baseline worktree) BEFORE then AFTER.
   Compute exact delta. Baseline 11228 → expected 11248 (delta +20 from new channel-env.test.ts).
   If delta != +20, the migration broke or added unexpected tests.

3. For each new it() in channel-env.test.ts, simulate no-op implementation:
   `return undefined` (or always-throw). Confirm each test would FAIL.

4. Check production callers don't break:
   - grep -rln 'getChannelToken\|getChannelChatId\|channelStateDir\|readChannelToken' src/ --include='*.ts' | grep -v __tests__
   - MUST return 0 matches (full migration).

5. Falsify the dispatch TABLE exhaustiveness:
   - Adding a 6th ChannelProviderType without updating TABLE must be a TS compile error.

6. Test type-widening: pass `readEnvFile()` return value (verify the actual type at src/env.ts:13)
   to `new ChannelEnv(env)`. If a cast is needed, FAIL.

7. Falsify mock factory correctness in the 7 updated test files:
   - Read each vi.mock factory
   - Verify the test still passes (`bun --bun vitest run <file>`)
   - Verify the mocked ChannelEnv instance returns the values the test expects

8. Verify stateDirFor and readTokenFor are INSTANCE methods (not static):
   `grep -n 'static.*stateDirFor\|static.*readTokenFor' src/channel-provider.ts` MUST return 0.

9. Confirm docs-update commit landed: re-read the 3 doc files, confirm D.1 marked LANDED,
   stale line numbers fixed.

10. Sanity-check the migration by reading 3 random production call sites and confirming the
    new code shape is consistent with the migration pattern.

11. Verify all 7 mock factory files still pass their test suites (read the actual
    `bun --bun vitest run <each-file>` output).

12. Confirm no consumer outside the listed 12 files imports the deleted helpers:
    `grep -rln 'from .*channel-provider' src/ --include='*.ts'` and inspect each.
```

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| **R1** | Stale line numbers in the 3 doc files pre-date D.2 land | Docs-commit MUST re-measure with `grep -n` and update doc cross-references. |
| **R2** | 7 mock factories break tests if `ChannelEnv` not exposed as `vi.fn()` | Each mock factory updated; the 7 test files re-run after the migration. |
| **R3** | Static-method ceremony (the 4-method static class trap) | All methods are instance methods per user decision. |
| **R4** | `process.env` leakage — class silently reads global instead of injected env | Test "getToken reads from constructor-injected env, NOT process.env" deletes `process.env.TELEGRAM_BOT_TOKEN` first. |
| **R5** | Empty-string `agentDir` falls through to `homedir()` (legacy truthy check) | Test "falls back to homedir when agentDir is empty string" pins this verbatim. |
| **R6** | Subagent author override (`claude@anthropic.com` instead of `eggprojectteams@gmail.com`) | Mandatory `git log -1 --format='%an <%ae>'` check before merge; STOP and ask user on mismatch. |
| **R7** | 42 call sites is a large blast radius — a single missed site breaks compilation | Implementation agent MUST grep again at start (§Implementation step 2) and again before commit (§Implementation step 6 verify). The tsc gate catches missed sites at compile time. |
| **R8** | Mock factory shape changes break 7 test files in subtle ways | Each test file's mock factory is read individually; the implementation agent tests each one with `bun --bun vitest run <file>` before moving on. |
| **R9** | `new ChannelEnv()` (no env) is used for stateDirFor/readTokenFor — does any existing caller pass `env` to these helpers? | Legacy signature is `channelStateDir(provider, agentDir?)` and `readChannelToken(provider, envFilePath)` — neither takes `env`. Confirmed: `new ChannelEnv()` is the correct shape for these. |

## Out of scope

Explicit. D.1 ONLY this cycle.

- **D.2** — 5 provider classes + `UnsupportedDirectSendProvider` base. **Already landed** (`10d06cb`, 2026-08-30). Do not touch.
- **D.3** — `ChannelProviderRegistry` class wrapping `markedProviders`. Future cycle.
- **D.4** — `withTestRunMarking` Form B explicit-delegation. **Already landed** (`ed2dd0b`). Do not touch.
- **D.5** — wrapper removal. **MERGED INTO D.1** as part of full migration.
- **D.6** — `LoggerLike` adoption. Conditional on H.1.
- **B.1** — `Config.env` class. D.1 ships WITHOUT B.1; `config.ts:17` keeps `const env = readEnvFile()` and passes `env` to `new ChannelEnv(env)`.
- **A.1–A.16** (db entity stores) — out of scope.
- **B.2–B.7** (config consumer migration) — out of scope; B.7 verification only.
- **C.1–C.10** (web classes, 44 route handlers) — out of scope.
- **E.5, E.6** (process-lock follow-ups) — out of scope.
- **F.1–F.8** (agent subsystem) — out of scope.
- **G.1–G.8** (channel coordinator) — out of scope.
- **H.1–H.5** (cross-cutting: LoggerLike, LazyBin, AppError) — out of scope.

## Documentation updates

A separate docs-commit (after the code merge, per CLAUDE.md §8 "Inline SHA doksiban túsz egy későbbi history rewrite kezében"):

1. **`docs/refactor-to-classbase/d-channel-provider/00-summary.md`** — D.1 marked LANDED. Note `(this commit)`. Remove "D.5 wrapper removal" reference (merged into D.1).
2. **`docs/refactor-to-classbase/d-channel-provider/05-refactor-roadmap.md`** — flip Phase D.1 status. Phase D.5 marked REMOVED (merged into D.1). Update line citations:
   - The doc currently cites pre-D.2 numbers; verify and update.
3. **`docs/refactor-to-classbase/d-channel-provider/03-class-boundaries.md`** — §D1 marked landed. Note the 42 call sites migrated. Insertion line: above `:500`.
4. **`docs/refactor-to-classbase/00-summary.md`** — Top-3 lowest-risk wins list re-checked; remove D.2/D.4 (already landed), add D.1 (now LANDED).

**No inline SHA** in any doc. Use `(this commit)` placeholder.

**`/code-review max --fix` skill (CLAUDE.md §8):** this skill has `disable-model-invocation`. Skill tool will refuse. **Documented as a user-manual step at the very end of the cycle**: after the docs-commit lands, the user runs `/code-review max --fix` in their terminal against `refactor/classbase`.

## Verifier A & B fixes applied in this revision

| Original gap (Verifier A/B) | Fix |
|---|---|
| Stale line numbers (channelStateDir:520, readChannelToken:533) | Re-measured 2026-09-04: channelStateDir:572-583, readChannelToken:585-603 |
| `readChannelToken` mock count (plan said 0; actual 6) | Updated §Scope with the 6 file list (+1 vi.doMock = 7 total) |
| Wrapper migration gate (plan said 21 calls; actual 40) | Updated §Scope: 31 channelStateDir + 9 readChannelToken + 2 token/chatId = 42 total |
| Vacuous-test table incomplete | 20 it() with full vacuous-test table |
| Out-of-scope enumeration missing A/B/C/E/F/G/H | Full §Out of scope added |
| Doc cross-references cite pre-D.2 line numbers | §Documentation specifies re-measurement + line-number update |
| `static stateDirFor`/`readTokenFor` ceremony (Verifier B cross-cutting) | User decided: ALL instance methods (not static) |
| Verifier B prompt missing | §Double verification now includes both prompts |
| User rejected legacy wrappers / @deprecated | Full migration (no wrappers, no @deprecated); 42 call sites + 7 mock factories migrated in one cycle |

## Critical files

- `src/channel-provider.ts` — `class ChannelEnv` insert + 4 helper function deletions
- `src/__tests__/channel-env.test.ts` — new file (20 `it()` + vacuous-test table)
- `src/config.ts` — 2 call sites migrated + import updated
- 10 other production files — 40 call sites migrated
- 7 test mock factories — updated to expose `ChannelEnv` as `vi.fn()`
- `docs/refactor-to-classbase/d-channel-provider/{00-summary,05-refactor-roadmap,03-class-boundaries}.md` — docs-commit
- `docs/refactor-to-classbase/00-summary.md` — Top-3 list re-checked

## End-to-end verification

After merge:
1. `bun tsc --noEmit` — must show 0 errors (was 0)
2. `bun --bun vitest run` — must show 11248+ tests passing (was 11228; +20 from new file)
3. `bun --bun vitest run src/__tests__/channel-provider-classes.test.ts src/__tests__/channel-provider.test.ts src/__tests__/channel-env.test.ts` — must show 166+ tests passing (was 146; +20)
4. `bun run lint` — must show 9783 problems (no change)
5. `git log -1 --format='%an <%ae>'` must equal `git config user.email` (`eggprojectteams@gmail.com`)
6. User runs `/code-review max --fix` manually in their terminal (CLAUDE.md §8)
