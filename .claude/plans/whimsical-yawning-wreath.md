# Needs-fix kör: két halott ág eltávolítása + INDEX könyvelés

## Context

A `docs/needs-to-be-fix/` 175 bug MD-t tartalmaz, ebből 126 megoldatlan. A cél a
következő adag lezárása a legkisebb módosítás és legkisebb bukási esély mentén.

Egy Plan agent 5 jelöltet rangsorolt, majd három független pre-verifikáló agent
adverzálisan felülvizsgálta őket. Az eredmény érdemben szűkítette a kört:

| Jelölt | Verdikt | Sors |
| --- | --- | --- |
| `command-task.ts:34` | SAFE | **megy** (A) |
| `claude-credentials-guard.ts:224` | SAFE-WITH-CAVEAT | **megy** (B) |
| `channel-request-watcher.ts:67` | **UNSAFE** | kimarad, MD-be figyelmeztetés |
| `agent-team.ts:191-192` | nem fordulna le | kimarad |
| `routes/docs.ts:62` | traversal védelem | kimarad |

Két eredeti javaslat tévesnek bizonyult, ezért nem kerül be:

- `agent-team.ts:191-192`: a `TeamConfig.trustFrom` opcionális (`agent-team.ts:23`),
  `strict: true` mellett a `??` eltávolítása TS18048. Nem halott ág, a típus
  követeli. A valódi javítás a mező kötelezővé tétele, amit a
  `agent-team-trustfrom-required-type-narrow-deferred.md` már elhalasztott.
- `routes/docs.ts:62`: a `basename(name) !== name` redundáns a `NAME_RE` miatt, de
  path traversal védelmi réteg, a 12-13. sori komment is rá hivatkozik, és a
  repóban nyitva van a `profiles-traversal-id` High súlyosságú traversal bug.

Kívánt végállapot: 3 commit (A fix, B fix, docs), mindegyik zöld typecheck +
teljes tesztfutás + lint után, minden fix után frissített INDEX.md.

## Végrehajtási rend

Három **külön** workflow futás, szigorúan sorban. A következő csak akkor indul,
ha az előző commitolva van és a teljes suite zöld:

```
W1 (fix A) -> commit -> W2 (fix B) -> commit -> W3 (docs) -> commit
```

Ha bármelyik workflow review gate-je FAIL, a futás `git checkout -- <fájlok>`-kal
visszaáll, és a kör megáll jelentéssel. Nem megyünk tovább.

## Workflow architektúra (W1 és W2 azonos, 4 agent)

```
phase 'Plan'     1x planner        read-only, pontos patch spec (structured output)
phase 'Apply'    1x implementer    edit + pinning teszt + typecheck + teszt + lint
phase 'Review'   2x reviewer       PÁRHUZAMOSAN, két különböző lencse
gate             r1.pass && r2.pass  -> a main loop commitol
```

- **planner**: beolvassa a bug MD-t és a forrást, visszaadja az `old_string` /
  `new_string` párt karakterre pontosan, a pinning teszt helyét és a verify
  parancsokat. Nem szerkeszt.
- **implementer**: alkalmazza a patchet és a pinning tesztet, majd lefuttatja:
  `bun run typecheck`, `bun --bun vitest run <érintett teszt>`, `bun run test`,
  `bun run lint`. Visszaadja mind a négy kimenet státuszát.
- **reviewer 1, korrektség lencse**: `git diff` alapján ellenőrzi, hogy a diff
  pontosan a spec, nincs scope creep, a viselkedés bájtra azonos, és az ág
  valóban elérhetetlen. Read-only.
- **reviewer 2, regresszió lencse**: `isolation: 'worktree'`, hogy szabadon
  mutálhasson. Visszacsinálja a fixet a worktree-ben és lefuttatja a pinning
  tesztet: **ha a teszt így is átmegy, a pinning teszt értéktelen és a gate FAIL**.
  Emellett ellenőrzi, hogy nem tűnt el lefedettség.

## A fix: `src/web/command-task.ts:34`

```diff
 function persist(): void {
-  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(healthMap ?? {}, null, 2)) }
+  try { atomicWriteFileSync(HEALTH_PATH, JSON.stringify(load(), null, 2)) }
   catch (err) { logger.warn({ err }, "command-task: failed to persist health map") }
 }
```

Miért biztonságos: `load()` (27-32. sor) cache-hit ágon ugyanazt a referenciát
adja vissza, amit a `runCommandTask` a 88. sorban elkapott és a 91. sorban
in-place mutált, tehát a `JSON.stringify` kimenete bájtra azonos. `persist()`
modul-privát, egyetlen hívója a 92. sor, az is a `load()` után. A repóban sehol
nincs `healthMap = null` visszaállítás a 29-30. soron kívül.

Nem használunk `healthMap!` non-null assertiont. A bug MD egy nagyobb
átalakítást preferál (`healthMap: HealthMap = {}`), de az egy külön `loaded`
flaget igényelne, tehát több kód, nem kevesebb.

Pinning teszt: `src/__tests__/web-command-task.test.ts`, a `describe('load + persist')`
blokkba. Azt pinneli, hogy a kiírt JSON a cache tartalmát hordozza, nem üres
objektumot.

## B fix: `src/web/claude-credentials-guard.ts:188 + 224`

```diff
 export function isPromotableSetupCredential(
   cred: { accessToken?: string; expiresAt?: number },
   nowMs: number,
-): boolean {
+): cred is { accessToken: string; expiresAt: number } {
```

```diff
-    const accessToken = (cred.accessToken ?? '').trim()
+    const accessToken = cred.accessToken.trim()
```

Miért biztonságos: a 189. sor `looksLikeSetupToken`-je az `OAUTH_TOKEN_RX`
(`/^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/`, 39. sor) miatt üres és whitespace-only
tokenre is false, a 190. sor pedig `typeof cred.expiresAt === 'number'`-t
követel. A tsconfigban nincs `exactOptionalPropertyTypes`, tehát a predicate
típusa legális. A `cred` `let`, de a 221. sori utolsó hozzárendelés után nincs
újra hozzárendelés és nincs closure a 223-224 között, szóval a narrowing él.

Ez a projekt typeguard szabályát is teljesíti: boolean helyett valódi type
predicate kerül a helyére.

**Teszt törlés nincs.** A korábbi terv a `claude-credentials-guard.test.ts:1085-1125`
szintetikus tesztjének törlését javasolta, de a pre-verifikáció szerint az a
fix után is átmegy, mert az ESM binding viselkedése nem változik. Surgical
elv: marad.

Egyetlen nyitott pont a `vi.doMock` stub a 1099. soron:

```ts
isPromotableSetupCredential: () => true,
```

Egy `boolean`-t adó függvény nem elégít ki egy predicate szignatúrát. A vitest
factory lazán tipizált, ezért lehet, hogy változatlanul lefordul. Az implementer
**először futtat `bun run typecheck`-et**, és csak ha ez a sor hibát ad, cseréli
valódi predicate-re:

```ts
isPromotableSetupCredential: (
  _cred: { accessToken?: string; expiresAt?: number },
  _now: number,
): _cred is { accessToken: string; expiresAt: number } => true,
```

`as any` és `as unknown as` tilos, a projekt szabálya szerint.

Pinning teszt: `src/__tests__/claude-credentials-guard.test.ts`, a 814-825
happy-path teszt mellé. Azt pinneli, hogy a `.trim()` a 224. soron továbbra is
lefut, tehát whitespace-szel körbevett token esetén is tiszta érték kerül a
fleet token fájlba. Ez pont az a viselkedés, amit a `?? ''` eltávolításakor
véletlenül el lehetne törölni.

## W3 docs commit

Kód nem változik.

1. `docs/needs-to-be-fix/channel-request-watcher-unreachable-provider-check.md`:
   figyelmeztető szakasz a nyers törlés ellen, a teljes szivárgási trace-szel
   (`resolveAgentProvider` 10-14. sor nem cache-el, a 99. sori külső guard és a
   66. sori belső olvasás nem atomi, a törlés után `Bearer <TELEGRAM_BOT_TOKEN>`
   megy a `slack.com/api/conversations.info` felé). A hoisting variáns
   (`provider: 'slack'` paraméterként) mint javasolt jövőbeli irány.
2. `docs/needs-to-be-fix/agent-team-trustfrom-nullish-coalesce.md`: rögzíteni,
   hogy a `??` eltávolítása `strict` alatt nem fordul, a mező opcionális, a
   javítás a deferred type-narrow MD-hez tartozik.
3. `docs/needs-to-be-fix/routes-docs-basename-redundant.md`: rögzíteni, hogy
   traversal védelmi réteg, amíg a `profiles-traversal-id` nyitva van, nem
   nyúlunk hozzá.
4. `INDEX.md` könyvelés helyreállítása: a fejléc 168-at ír, a tábla 154 sor, a
   lemezen 175 bug MD van. 21 MD-nek nincs sora, ezeket fel kell venni a helyes
   Resolved státusszal (több már javított, pl. `routes-recall-25-ts-strict-blocks-delete`,
   `mcp-list-warn-execError-dead-branch`, `agent-process-777-ts-strict-blocks-delete`).
   A `channel-monitor-importwith-existsoverride-leaks-live-store` sorhoz nincs
   fájl: először `git log --diff-filter=D` a törlés keresésére, ha nem volt
   törlés, a sor kikerül. Nem gyártunk kitalált MD tartalmat.

## Commit konvenció

A `08d7508` és `c2b4ea2` mintáját követve: `refactor: ...` cím, a body pedig
`fájl:sor` felsorolás azzal, hogy miért volt elérhetetlen az ág.

## Verifikáció

Minden kódfix után, az implementer és a reviewer 2 is futtatja:

```
bun run typecheck                                   # tsc --noEmit, 0 hiba
bun --bun vitest run src/__tests__/web-command-task.test.ts          # A
bun --bun vitest run src/__tests__/claude-credentials-guard.test.ts  # B
bun run test                                        # teljes suite zöld
bun run lint                                        # eslint --max-warnings 0
```

Gate feltételek egy fix commitolásához, mind a négynek igaznak kell lennie:

1. typecheck 0 hiba
2. teljes suite zöld, a commit előtti állapottal azonos teszt- és assert-számmal
3. reviewer 1: a diff pontosan a spec, nincs scope creep
4. reviewer 2: a pinning teszt **elhasal**, ha a fixet visszacsinálja a worktree-ben

W3 után `git log --oneline -4` és `find docs/needs-to-be-fix -name '*.md' | wc -l`
összevetése az INDEX fejlécszámával.

## Kritikus fájlok

- `src/web/command-task.ts` (A)
- `src/__tests__/web-command-task.test.ts` (A pinning)
- `src/web/claude-credentials-guard.ts` (B)
- `src/__tests__/claude-credentials-guard.test.ts` (B pinning, esetleg a 1099. sori stub)
- `docs/needs-to-be-fix/INDEX.md` (mindhárom kör)
- `docs/needs-to-be-fix/channel-request-watcher-unreachable-provider-check.md` (W3)
