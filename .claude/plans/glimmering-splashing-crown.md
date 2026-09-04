# Cycle 38 — Smallest, Lowest-Risk Needs-Fix Batch

## Context

A `test/baseline` branchon 28 needs-fix MD van pending (5 High + 3 Medium + 7 Low + 10 baseline addenda + 3 orphan addenda), ezek kozul a legtobb "NEVER modify X.ts" szabaly alatt all (pl. `src/web.ts`, `src/index.ts`, `src/web/keychain.ts`). A harom ciklusra visszanyulo minta: 1-2 kis surgialis fix per ciklus, kulon commitokban, mindig `docs/needs-to-be-fix/INDEX.md` Resolved flip a vegen, soha `git push`.

Ez a ciklus ket **HIGH severity** security fixet von egybe:
1. **`google-api-refresh-race`** — konkurrens `refreshAccessToken` hivasok lost-update-ot okoznak a token lemezre irasakor.
2. **`profiles-traversal-id`** — `loadProfileTemplate(id)` nem validalja az `id`-t, igy `../../outside` kilep a `PROFILES_DIR` mappabol es tetszoleges JSON-t ad vissza security profile-nak.

Mindketto:
- Surgialis (5-10 sor kodvaltozas)
- Kulonallo fajlokban (nincs kozos logika)
- Explicit pinning test-tel rendelkezik (a test jelenleg a BUGGY viselkedest rogziti, a fix flip-peli az assertiont)
- A MD-k "Suggested direction" szakasza konkret fix-mintat ad

A ciklus vegen a user manualisan meghivja a `/code-review max --fix` skillt (CLAUDE.md §6 tiltja, hogy az agent invokalja a skillt, plusz a skill `disable-model-invocation` flag-gel rendelkezik).

## Recommended approach

### Commit 1 — `fix(google-api): deduplicate in-flight refreshAccessToken calls`

**File:** `src/google-api.ts`

A `refreshAccessToken()` bodyjat (L109-141) athelyezzuk egy uj `doRefresh()` helper-be, majd a kulfoldi fuggvenyt 4 soros single-flight wrapper-re csereljuk:

```ts
let refreshInFlight: Promise<string> | null = null

async function refreshAccessToken(): Promise<string> {
  // Single-flight: concurrent callers share one POST + one saveTokens.
  // Without this wrapper the second caller's save overwrites the first
  // caller's response, leaving the first caller holding a bearer the
  // server may treat as stale on its next request.
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = doRefresh().finally(() => { refreshInFlight = null })
  return refreshInFlight
}

async function doRefresh(): Promise<string> {
  // ... a jelenlegi body verbatim athelyezve (L109-141)
}
**

**File:** `src/__tests__/google-api.test.ts`

- L510-529 pinning test: `describe('refreshAccessToken race (pinned defect: ...)')` → atnevezve `describe('refreshAccessToken race (single-flight)')`-re, a `2` → `1` assertion flip (`refreshes.length` es `tokenWrites.length`).
- Az `importFresh` pattern mar kezeli a `refreshInFlight` module-state resetjet (`vi.resetModules()` per describe).

### Commit 2 — `fix(profiles): reject traversal ids in loadProfileTemplate`

**File:** `src/web/profiles.ts`

A `loadProfileTemplate` (L42-49) tetejere egy allowlist regex check kerul:

```ts
export function loadProfileTemplate(id: string): ProfileTemplate {
  // Allowlist rejects traversal before any filesystem read. Matches every
  // shipped profile id (applier, default, developer-junior, developer-
  // senior, marketer, researcher, sub-dev).
  if (!/^[a-z0-9-]+$/i.test(id)) {
    return id !== 'default' ? loadProfileTemplate('default') : HARDCODED_DEFAULT_PROFILE
  }
  const path = join(PROFILES_DIR, `${id}.json`)
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf-8')) as ProfileTemplate } catch { /* fall through */ }
  }
  if (id !== 'default') return loadProfileTemplate('default')
  return HARDCODED_DEFAULT_PROFILE
}
```

**File:** `src/__tests__/profiles.test.ts`

- L289 pinning test (`'PINS BUG: a traversing id reads a JSON file outside PROFILES_DIR'`): atnevezve `rejects traversal ids and falls back to the on-disk default`-re, `escaped.label === 'ESCAPED'` → `escaped.label === 'On-disk default'`, `escaped.id === 'outside'` → `escaped.id === 'default'`.
- Ket uj test a traversal coverage-hoz: `'../package.json'`, `'foo/bar'`, `'foo bar'`, `''`, `'sub_dev'` (alulvonas nincs a charset-ben) → mind `default` fallback.
- Egy pozitiv teszt: `developer-junior` (kötőjellel) load-olodik, `sub-dev` (nem ültetett) → default fallback.

### Commit 3 — `docs(needs-to-be-fix): mark google-api-refresh-race + profiles-traversal-id Resolved`

**File:** `docs/needs-to-be-fix/INDEX.md`

- L24 (`google-api-refresh-race`): `—` → `Resolved: 2026-08-21 <sha1>` (a commit 1 SHA-ja)
- L27 (`profiles-traversal-id`): `—` → `Resolved: 2026-08-21 <sha2>` (a commit 2 SHA-ja)

SHA-kat a `git log --format=%H -n 2` adja commit 1 es 2 utan.

### Out of scope (nem resze ennek a ciklusnak)

- `POST /api/agents` profile.id !== requested → 400 guard: MD explicit "Independently" szoval elvalasztja, a regex mar lezarja a security bugot. Kovetkezo ciklus.
- Staleness self-retry a doRefresh-ben: a verifier megerositette, hogy a természetes kovetkezo getValidAccessToken hivas 1h expiry-jü friss tokent lat, 5min ablakon kívül.

## Critical files

- `/Users/eggp/marveen-develop/test-baseline/src/google-api.ts` (refreshAccessToken, L108-142)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/google-api.test.ts` (pinning test, L505-560)
- `/Users/eggp/marveen-develop/test-baseline/src/web/profiles.ts` (loadProfileTemplate, L42-49)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/profiles.test.ts` (pinning test, L280-320)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` (2 Resolved row edit, L24 es L27)

## Existing utilities reused

- `importFresh()` helper `src/__tests__/google-api.test.ts` (~L283) — `vi.resetModules()`-szal reseteli a module-state-et, igy a `refreshInFlight` per-test null. Nem kell valtoztatni.
- `HARDCODED_DEFAULT_PROFILE` es `PROFILES_DIR` constant a `src/web/profiles.ts`-ben — fallback celjaira mar hasznalva, nem kell uj.
- `MEMORY_CATEGORIES` set `src/web/routes/memories.ts:14` — **nem** hasznaljuk ebben a ciklusban, csak emlekezteto.

## Repo conventions enforced

- Commit message-eket fajlba irjuk (`git commit -F /tmp/commit-N.txt`), nem `-m`-be — a backtick-es kodreszletek miatt (safe-commit-message skill).
- Em-dash tiltas — `—` helyett `--` vagy `-` (CLAUDE.md §6).
- Strict TypeScript: nincs uj `as`/`any`/`+ 'string'` — csak meglevo mintak.
- Working tree clean marad a workflow kozben (a workflow phase-ek idempotensek).
- Nincs `git push` — user kezeben marad.

## Verification

### Per-commit (3 phase, mindegyikben):
1. Szerkesztes utan `bun --bun vitest run src/__tests__/<file>.test.ts` (egy fajlra szukitve, gyors).
2. Commit message fajlba, `git add -p <valtozott fajlok>`, `git commit -F /tmp/commit-N.txt`.

### Final phase:
1. `bun --bun vitest run` — teljes suite, megbizonyosodni hogy mas test nem torik el.
2. `git log --oneline origin/test/baseline..HEAD` — elvaras: 3 commit, mind lokalis.
3. `git status` — elvaras: clean.
4. `git diff --stat origin/test/baseline..HEAD` — elvaras: 5 fajl modosult (a 4 source + INDEX.md).
5. Report "done" a usernek — user ezutan **manualisan** meghivja a `/code-review max --fix` skillt a terminalban (az agent NEM invokalja, CLAUDE.md §6 + `disable-model-invocation` flag).

### Pre-flight guard (CLAUDE.md §8)

A `ls store/` ellenorzese: ha nem ures, a `assert-not-live-install.ts` guard blokkolja a vitest suite-ot. Ebben a ciklusban a `store/` mappa nem letezik (clean working tree + friss checkout), igy kozvetlenul futtathato `bun --bun vitest run`. Ha barmi megjelenik a `store/` mappaban, automata temp worktree-t kell kesziteni: `git worktree add --detach /tmp/claw-test38 test/baseline` + `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-test38/node_modules`.

### 5+ vitest fail eset (CLAUDE.md §8)

Ha a teljes suite-ban >5 fail, automatikusan osszehasonlitani a `a330462` baseline-on futtatva ugyanazt a subset-et. Ha a baseline-on is fail, pre-existing regression — duzzasztott outputtal bizonyitani a usernek, nem automatikusan magunkat vadolni.

## Workflow structure (vegrehajtas)

A terv vegrehajtasa egyetlen Workflow-nal, 4 phase + 1 verify:

```
phase('Pre-flight')
  // git status, ls store/ check
phase('Apply google-api fix')
  // edit src/google-api.ts + test, vitest src/__tests__/google-api.test.ts, commit
phase('Apply profiles fix')
  // edit src/web/profiles.ts + test, vitest src/__tests__/profiles.test.ts, commit
phase('Docs flip')
  // capture SHAs, edit INDEX.md, commit
phase('Verify')
  // full vitest, git log/status/diff, report done
```

Minden phase kulon subagent-et kap (javasolt: 1-1 implementer agent per fix + 1 verify), de a konkret split a user beleegyezese utan dontodik el. A user a workflow elinditasa elott megerositheti a strukturat.

## Risk surface (a verifier megerositette)

| Fix | Risk | Verdict |
|---|---|---|
| google-api single-flight | Module-scoped `refreshInFlight` + `importFresh` + `vi.resetModules()` pattern mar mukodik | LOW |
| google-api single-flight | 401-retry branch (`getCalendarEvents` L177) transzparens modon kapja a wrapper-t | LOW |
| google-api single-flight | Soros (nem konkurrens) hivasok nem coalescealodnak — `.finally` azonnal nullazza a slot-ot | LOW |
| profiles regex | Mind a 7 shipped ID (`applier`, `default`, `developer-junior`, `developer-senior`, `marketer`, `researcher`, `sub-dev`) match-eli `/^[a-z0-9-]+$/i` | LOW |
| profiles regex | Recursion `loadProfileTemplate('default')` biztonsagos — `'default'` match-eli a regexet, terminal 1 lepes utan | LOW |
| profiles regex | 4 production caller (`agents.ts:831`, `agents.ts:1216`, `agents.ts:1236`, `agent-process.ts:1049`) mind transzparens modon kapja a guard-ot | LOW |

## Summary

3 commit a `test/baseline` branchon, working tree clean, no push. A ket fix teljesen kulonallo (kulon fajlok, nincs kozos logika, nincs kozos test helper), igy a cycle-os commitok egyike sem blokkolja a masikat ha rollback kell. A `/code-review max --fix` skill-t a user manualisan inditja a workflow befejezese utan.
