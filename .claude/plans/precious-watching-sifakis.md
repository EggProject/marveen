# Plan: Cycle 31 — Lowest-Risk Needs-Fix Items

## Context

A `test/baseline` branchon 181 needs-to-be-fix MD van filed. A legutóbbi ciklusok (28/29/30) a magas kockázatú/defenzív javításokra fókuszáltak, több revert tanulsággal. Most a maradék nyitott item-ek közül a **legkisebb, legalacsonyabb kockázatú** tételeket vesszük célba, hogy:

- A kódot ne érintő (pure doc) MD-eket retire-oljuk, hogy az index a valóságot tükrözze
- 1-5 soros, mintailleszkedő kód-javításokat hajtsunk végre, ahol a pinning test már készen áll
- Ne nyúljunk magas kockázatú/defenzív refaktorokhoz (keychain `-T, SECURITY`, message-router helper-throws, profile traversal)

A branch jelenlegi állapota (ellenőrizve saját paranccsal):
- HEAD: `d92beee` `test/baseline`-on
- Working tree clean, 0 unpushed commit
- Typecheck baseline: 1701 pre-existing errors (az `agent-restart-policy.test.ts:317,320` mintájú tolerance +5 delta)

Minden batch független, a saját commit-sorával fut, és a workflow végén `/code-review xhigh --fix` zárja.

---

## BATCH 1: Stale MD retirement sweep (pure docs)

**Bug ID-k** (mind path-mismatch vagy már megváltozott forrás):
1. `routes-dashboard-auth-nonexistent-sut`
2. `routes-reauth-detect-missing-source-path`
3. `routes-reauth-healer-missing-file`
4. `routes-remote-status-cache-path-mismatch`
5. `routes-update-checker-path-mismatch`
6. `routes-agent-team-unreachable-branches` — **kivétel**: csak akkor retire, ha a MD törzsében explicit note kerül, hogy `agent-team-trustfrom-nullish-coalesce` és `agent-team-trustfrom-required-type-narrow-deferred` továbbra is nyitott marad
7. `channel-coordinator-coverage-limits` — forrás már `setOffset(SOURCE, maxUpdateId)` (line 401)
8. `agent-process-runtmux-host-truthy-cond-unreachable` — forrás már `opts.timeout ?? 3000` (line 777)
9. `routes-voice-runproc-stdin-dead` — forrás már required `stdinData`/`timeoutMs`. **Kivétel**: `src/__tests__/voice-routes.test.ts:492-496` tartalmaz elavult kommentet ami azt állítja, hogy `stdinData` opcionális — ez a teszt-komment is javítandó ugyanabban a commitban
10. `remote-enroll-fs-rename-failure-cleanup-untestable` — MD maga írja: "no code change needed"
11. `schedule-mcp-precheck-subtree-cycle-defensive` — MD maga írja: "leave the source unchanged"

**Commit**: 1 docs commit
```
docs(needs-to-be-fix): retire 11 stale MDs (path-mismatch + source already fixed + MD-self-retire)
```

**Changes**:
- `docs/needs-to-be-fix/INDEX.md`: 11 sor Resolved státusza `Resolved: 2026-08-18 <sha>` formátumra cserélve (vagy "Documented only — source unchanged" ha a MD maga javasolta)
- 11 MD fájlhoz `## Resolution` szekció hozzáadva (1-3 sor)

**Risk**: NONE — nulla kód változás
**Verification**: `bun run typecheck` (delta 0), `git diff --check`, no test futtatás (nincs kód-változás)

---

## BATCH 2: routes-research-stale-basename-narrative (comment-only)

**Bug ID**: `routes-research-stale-basename-narrative`

**Forrás**:
- `src/web/routes/research.ts:8-11` (a module preamble comment)
- `src/__tests__/research-routes.test.ts:8-12` (a test preamble comment)

A `basename` import törölve lett a `e62be87` commitban (cycle 30 fix), de a kommentek még mindig "basename-checked"-et állítanak. Az egyetlen védelmi vonal most a `NAME_RE` karakter-osztály.

**Commits**: 2 (src komment + test komment + docs)
```
fix(routes-research): update stale basename-checked comment in module preamble
test(research-routes): update stale basename-checked comment in test preamble
docs(needs-to-be-fix): mark routes-research-stale-basename-narrative resolved
```

**Risk**: NONE — csak komment
**Verification**: `bun run typecheck` (delta 0), `bun run test src/__tests__/research-routes.test.ts` (meglévő 60+ teszt zöld marad)

---

## BATCH 3: telegram-client-probehighwater-ignores-okfalse (1-line guard)

**Bug ID**: `telegram-client-probehighwater-ignores-okfalse`

**Forrás**: `src/channel-coordinator/telegram-client.ts:222`
A `probeHighWater` 200 OK + `ok:false` válasz esetén nem dob, hanem egy nemlétező `update_id`-t ad vissza. A testvér `getUpdates` függvény (line 188) már kezeli ezt a mintát — ugyanazt a guardot kell tükrözni.

**Commit sequence**:
```
fix(telegram-client): mirror getUpdates ok:false guard in probeHighWater
test(telegram-client): flip probeHighWater PIN test to expect TelegramApiError; add no-description variant
docs(needs-to-be-fix): mark telegram-client-probehighwater-ignores-okfalse resolved
```

**Gotcha**: A MD-ben javasolt pontos leírás-fallback (`res.description ?? 'transient'`) egy új `??` ágat hoz létre. Ahhoz hogy 100% branch coverage megmaradjon a teszt commitnak tartalmaznia kell MINDKÉT esetet:
- description jelen van (`'transient error message'`)
- description hiányzik (fallback ág)

A pinning test (`PIN: probeHighWater returns 99999 from a 200 OK with ok: false (defect: should throw)`) assertionje `expect(result).toBe(99999)` → `expect(result).toBeInstanceOf(TelegramApiError)`.

**Risk**: LOW — testvér minta 1:1 tükrözése
**Verification**: `bun run typecheck` (delta 0), `bun run test src/__tests__/channel-coordinator-telegram-client.test.ts`, `bun run coverage -- src/channel-coordinator/telegram-client.ts` (100% branch coverage)

---

## BATCH 4: routes-research-malformed-uri-500 (5-line try/catch)

**Bug ID**: `routes-research-malformed-uri-500`

**Forrás**: `src/web/routes/research.ts:61-62`
A két `decodeURIComponent` hívás `URIError`-t dobhat rossz `%G0` inputra, ami a web.ts generic catch-én át 500-at ad vissza 400 helyett.

**Commit sequence**:
```
fix(routes-research): wrap decodeURIComponent in try/catch to return 400 on URIError
test(research-routes): add malformed-URI test asserting 400 response
docs(needs-to-be-fix): mark routes-research-malformed-uri-500 resolved
```

A MD-ben javasolt fix szöveg használható (`Invalid file name` üzenettel, konzisztens a többi 400-as válasszal).

**Risk**: LOW — tiszta error-handling javítás
**Verification**: `bun run typecheck` (delta 0), `bun run test src/__tests__/research-routes.test.ts` (meglévő 60+ + 1 új teszt)

---

## BATCH 5: platform-xdg-session-type-tty-bug (5-line OR-chain)

**Bug ID**: `platform-xdg-session-type-tty-bug`

**Forrás**: `src/platform.ts:13`
A `XDG_SESSION_TYPE=tty` jelenleg GUI session-nek minősül (az OR-chain minden truthy XDG értéket GUI-nak veszi). A fix: explicit allowlist (`x11`/`wayland`/`mir`).

**Commit sequence**:
```
fix(platform): narrow XDG_SESSION_TYPE detection to x11/wayland/mir only
test(platform): flip XDG_SESSION_TYPE=tty PIN test to assert linux-server
docs(needs-to-be-fix): mark platform-xdg-session-type-tty-bug resolved
```

A pinning test (`treats XDG_SESSION_TYPE=tty as a GUI session (pinned as a bug)`) assertionjét át kell írni `PLATFORM === 'linux-server'`-re.

**Risk**: LOW — keskenyített detekció, csak az explicit nem-GUI eseteket érinti
**Verification**: `bun run typecheck` (delta 0), `bun run test src/__tests__/platform.test.ts`, `bun run coverage -- src/platform.ts`

---

## Összevonási döntések (garantáltan biztonságos)

| Kombináció | Indoklás |
|---|---|
| Batch 1 mind a 11 MD | Mind path-mismatch vagy "MD-self-retire", nulla kód érintett |
| Batch 2 src + test komment együtt | Komment-fix batch konvenció (egyetlen témakör: research.ts basename narrative) |
| Batch 3/4/5 szétválasztva | Runtime kód-változás — minden batch külön fájlt és eltérő kockázati profilt érint; Plan agent kifejezetten javasolta az 1-bug-per-batch szétválasztást |

---

## Dupla-ellenőrzési lista (mit kell a subagent verify-elnie execution előtt)

1. **Batch 1**: `routes-agent-team-unreachable-branches` MD body-ját olvasni — biztosítani, hogy a Resolution szekció hozzáadja a cross-linket `agent-team-trustfrom-nullish-coalesce`-hez és `agent-team-trustfrom-required-type-narrow-deferred`-hez.
2. **Batch 1**: `src/__tests__/voice-routes.test.ts:492-496` pontos szövegét beolvasni, hogy a javított komment megegyezzen a forrás valóságával (`stdinData: string` required, `timeoutMs: number` required).
3. **Batch 2**: A MD pontos komment-replacement szövegét használni (a MD fájl tartalmazza).
4. **Batch 3**: `src/channel-coordinator/telegram-client.ts:188`-at olvasni, hogy a `getUpdates` guard szintaktikája pontosan másolható legyen (különösen a `description` fallback).
5. **Batch 3**: A MD `Suggested direction` szekciójából a pontos `description ?? 'transient'` fallback stringet használni.
6. **Batch 4**: A meglévő 400-as üzeneteket a `src/web/routes/research.ts`-ben olvasni, hogy a konzisztens üzenet-formátum használható legyen.
7. **Batch 5**: `src/platform.ts` teljes függvényt elolvasni a jelenlegi OR-chain pontos helyettesítéséhez.

---

## Explicit DEFERRED (nem ebben a ciklusban)

| Bug ID | Miért halasztva |
|---|---|
| `keychain-store-insecure-acl` | Real-host teszt szükséges a `-T, SECURITY` cseréhez; cycle 30 Option A revert megerősítette, hogy a `-A` eltávolítás headless macOS-en vault unusability-t okoz. Külön ciklus, valós környezetben. |
| `message-router-cache-fallback-unreachable` | A helper-throws refaktor 100% coverage-ot adna, de +71 typecheck error kockázat; a revert path jelenleg is működik. Külön ciklus. |
| `routes-research-symlink-traversal` + `routes-research-double-stat-inefficiency` | Real security fix (TOCTOU + symlink-follow); a cycle 30-ban újonnan filed MD-ek. Következő ciklusban párban. |
| `profiles-traversal-id` (High severity) | Path-traversal security bug; komplex validáció; külön ciklus. |
| `config-empty-env-blanks-identity`, `db-missing-telegram-history-table`, `google-api-refresh-race`, `multipart-boundary-greedy`, `multipart-latin1-fields`, `routes-memories-put-skips-validation` | High-severity, mind komplex multi-file javítás; külön ciklusok. |
| `agent-team-trustfrom-required-type-narrow-deferred`, `federation-routes-fedpeer-required-type-narrow-deferred` | TS strict refaktorok; korábban +13 / +71 typecheck deltát produkáltak; külön ciklus. |
| `recall-dayofweek-noon-utc-far-east-skew` | TZ-related behavioral fix; külön ciklus, több zónát érintő regressziós teszt kell. |
| `voice-directive-json-quote-escape` | JSON escape fix; külön ciklus. |

---

## Execution flow

```
1. Workflow indítása (agent-team, max 2 párhuzamos task)
   - Branch: test/baseline (HEAD: d92beee)
   - Al-task-ok: 5 db docs-only/code-fix subagent, egymás utáni sorrendben
   
2. Batch 1 futtatása (subagent: docs-only)
   - Verify: bun run typecheck (delta 0), git diff --check
   
3. Batch 2 futtatása (subagent: comment + test comment + docs)
   - Verify: typecheck, research-routes test
   
4. Batch 3 futtatása (subagent: code + test + docs)
   - Verify: typecheck, telegram-client test + coverage
   
5. Batch 4 futtatása (subagent: code + test + docs)
   - Verify: typecheck, research-routes test
   
6. Batch 5 futtatása (subagent: code + test + docs)
   - Verify: typecheck, platform test + coverage
   
7. SAJÁT KÉZI VERIFY (2026-08-15 szabály):
   - git log --oneline test/baseline -8
   - git diff origin/test/baseline --stat
   - bun run typecheck → quote a tényleges számot
   - bun run test → quote a tényleges összesítést
   - git diff --check
   
8. /code-review xhigh --fix skill hívása (kötelező záró lépés)
   - Elvárt: 0 új P1/P2 finding (mivel minden batch meglévő konvenciót követ)
```

---

## Végállapot várakozás

- **Beküldött commit-ok száma**: 1 (Batch 1) + 3 (Batch 2) + 3 (Batch 3) + 3 (Batch 4) + 3 (Batch 5) = **13 commit**, mind `test/baseline`-on
- **Working tree**: clean
- **Typecheck**: 1701 (baseline preserved, delta 0)
- **Affected test suites**: research-routes, telegram-client, platform, voice-routes (komment) — mind zöld
- **Coverage**: 100% per-file (Batch 3 és 5 kiemelten ellenőrizve)
- **Push**: A user kezében (push tilos a workflow-ból)