# E.1 + E.2 — `PortLockAcquirer` + `PidfileLockAcquirer` osztály-kiemelés

## Context

A `docs/refactor-to-classbase/` a teljes `src/` fa függvény→osztály migrációját tervezi meg,
8 alrendszerre bontva (A–H). A gyökér `docs/refactor-to-classbase/00-summary.md:86-112` három
legkisebb kockázatú tételt nevez meg; ebből a **#1 (`channel-provider.ts`) már kész** ezen a
branchen (`ed2dd0b` … `2707900`), a **#3 (`auto-restart.ts`) pedig nem használható**: ugyanaz
a dokumentum a `:39` sorban a "Utility modules (**no conversion**)" listára teszi, tehát
önmagával ellentmond, ráadásul egy nem létező `dailyPhaseAtMs` függvényre hivatkozik (`:110`;
valódi név: `dailyDueAtMs`, `src/auto-restart.ts:117`).

Marad a **#2: `src/process-lock.ts` → `PortLockAcquirer` + `PidfileLockAcquirer`**. Ez a
legjobb kockázat/érték arányú következő lépés, mert a modul már ma is tiszta DI-seam-en áll
(`ProcessLockContext` `:26`, `PidfileLockContext` `:226` minden I/O primitívet hordoz), tehát
az átalakítás szó szerinti fordítás: **a `ctx` paraméterből `this.ctx` lesz**.

**Cél:** a két osztály létrejön, a meglévő exportált szabad függvények vékony
explicit-delegation wrapperként megmaradnak. Ebből következik, hogy **egyetlen fájlon kívül
semmi nem változik**: `src/index.ts`, `src/__tests__/index.test.ts` és
`src/__tests__/process-lock.test.ts` érintetlen marad. Pontosan a `ed2dd0b` / `10d06cb`
minta, ami ezen a branchen már bevált.

---

## Mért baseline (2026-08-30, ezen a worktree-n, flag nélkül)

| Gate | Parancs | Érték |
|---|---|---|
| Teszt | `bun --bun vitest run` | **383 file / 11211 teszt zöld**, exit 0, 135s |
| Coverage | `bun run coverage` | **exit 0** (gate zöld; `perFile: true`, 100% mind a 4 metrikán, `vitest.config.ts:42-48`) |
| Typecheck | `bun tsc --noEmit` | **1729** hiba (pre-existing `bun:sqlite` típusdrift) |
| Lint | `bun run lint` | **10048** probléma (10044 error / 4 warning) |
| Live-install guard | `ls store/` | nem létezik → `assert-not-live-install.ts` nem blokkol |

A gate-ek abszolút értelemben pirosak (tsc/lint), ezért **differenciálisan** használjuk:
a szám nem nőhet.

A `bun run coverage`-ot **gate-ként** futtatjuk, nem artifactért: a `coverage/` és
`coverage-temp/` a `.gitignore:98-99`-ben van, tehát commitolható kimenet nem keletkezik
(CLAUDE.md §8).

**Lint-kockázat lezárva:** a `@typescript-eslint/parameter-properties`,
`explicit-member-accessibility`, `class-methods-use-this`, `promise-function-async` és
`prefer-readonly` szabályok csak az `all.js` presetben élnek, a repo által használt
`strict-type-checked` + `stylistic-type-checked` párosban (`eslint.config.js:66-69`)
nincsenek. Ami be van kapcsolva és érinthetné az új alakot — `no-extraneous-class`,
`no-useless-constructor`, `require-await`, `no-unnecessary-condition` — azt a tervezett
szerkezet kielégíti (a parameter property miatt a konstruktor nem "useless", az osztályoknak
van példányállapota és példánymetódusa).

---

## Mit csinálunk — `src/process-lock.ts` (364 sor)

### `PortLockAcquirer`

Beköltözik: `findOwnNodeHolders` (`:77`), `findOwnBinaryMatches` (`:88`),
`filterOwnNodeCandidates` (`:93`, ma modul-privát), `terminateProcesses` (`:127`),
`acquirePortLock` (`:169`).

```ts
export class PortLockAcquirer {
  constructor(private readonly ctx: ProcessLockContext) {}

  findOwnNodeHolders(port: number): number[]
  findOwnBinaryMatches(pattern: RegExp): number[]
  private filterOwnNodeCandidates(pids: number[]): number[]
  async terminateProcesses(pids: number[], opts: { graceMs: number }): Promise<void>
  async acquire(port: number, opts: AcquirePortLockOptions = {}): Promise<void>
}
```

### `PidfileLockAcquirer`

Beköltözik: `acquirePidfileLock` (`:289`).

```ts
export class PidfileLockAcquirer {
  constructor(private readonly ctx: PidfileLockContext) {}
  async acquire(path: string, selfPid: number, opts: AcquirePidfileLockOptions = {}): Promise<void>
}
```

### A wrapperek (publikus felület **változatlan**)

Az osztálymetódusok **egymást `this`-en keresztül hívják**, nem a szabad függvényeken át.
Konkrétan: `acquire()` `:177`/`:178`/`:191` hívásai `this.findOwnNodeHolders(port)` és
`this.findOwnBinaryMatches(pattern)` lesznek, a `:182` pedig
`this.terminateProcesses(victims, { graceMs })`. Ha maradnának a szabad függvény hívások, a
drain-ciklus minden körben új `PortLockAcquirer`-t allokálna — viselkedésben azonos, de
biztos `/code-review` finding.

```ts
export function findOwnNodeHolders(port: number, ctx: ProcessLockContext): number[] {
  return new PortLockAcquirer(ctx).findOwnNodeHolders(port)
}
export function findOwnBinaryMatches(pattern: RegExp, ctx: ProcessLockContext): number[] {
  return new PortLockAcquirer(ctx).findOwnBinaryMatches(pattern)
}
export function terminateProcesses(pids: number[], ctx: ProcessLockContext, opts: { graceMs: number }): Promise<void> {
  return new PortLockAcquirer(ctx).terminateProcesses(pids, opts)
}
export function acquirePortLock(port: number, ctx: ProcessLockContext, opts?: AcquirePortLockOptions): Promise<void> {
  return new PortLockAcquirer(ctx).acquire(port, opts)
}
export function acquirePidfileLock(path: string, selfPid: number, ctx: PidfileLockContext, opts?: AcquirePidfileLockOptions): Promise<void> {
  return new PidfileLockAcquirer(ctx).acquire(path, selfPid, opts)
}
```

### Sorrend a fájlban

Fejléc-komment (`:1-17`) → `LogFn` (`:19`) → `SignalOutcome` (`:24`) →
`ProcessLockContext` (`:26`) → `AcquirePortLockOptions` (`:52`) → `DEFAULT_*` (`:67-69`) →
**`class PortLockAcquirer`** → 4 port-wrapper → `writeBufferFully` (`:207`) →
`ExclusiveCreateOutcome` (`:224`) → `PidfileLockContext` (`:226`) →
`AcquirePidfileLockOptions` (`:256`) → `DeferToPeerError` (`:272`) →
**`class PidfileLockAcquirer`** → `acquirePidfileLock` wrapper.

Osztály a saját wrapperei ELŐTT. TDZ nincs: a wrapper törzse csak híváskor fut, addigra a
modul betöltése rég lezárult.

---

## Négy eldöntött részletkérdés (ezek a fejlesztés alatt derülnének ki különben)

**1. Default paraméter és az istanbul branch-számlálás.**
A default **csak a metóduson** van (`opts: X = {}`), a wrapper `opts?: X`-et deklarál és
továbbadja. Így pontosan **egy** default-branch keletkezik osztályonként, és mindkét karja
lefedett a meglévő tesztekből: `process-lock.test.ts:336` / `:345` opts nélkül hívja
(→ default felveszi), `:354`+ opts-szal (→ nem veszi fel). Ugyanez pidfile oldalon: `:536`
opts nélkül, a többi 12 opts-szal. Ha default lenne a wrapperen IS, a metódusé sose sülne el
a wrapper-úton → uncovered branch → bukna a 100% perFile gate.

**2. Parameter property engedélyezett.** Precedens ugyanebben a 100%-os gate-ben:
`src/web/remote-status-cache.ts:22` (`constructor(private readonly ttlMs: number) {}`) és
`src/channel-coordinator/telegram-client.ts:46-49`. Az üres konstruktortörzs 0 branch-et ad,
és minden `new` hívás fedi.

**3. A wrapperek `async` nélkül, explicit `Promise<void>` return típussal.**
Nem azért, mintha az `async` forma megbukna: a `@typescript-eslint/require-await`
implementációja (`node_modules/@typescript-eslint/eslint-plugin/dist/rules/require-await.js:243`,
`if (expression && isThenableType(expression))`) thenable return esetén **nem** jelent hibát.
A `function ... : Promise<void>` alakot house style okán választjuk (`src/web/agent-process.ts:63`,
`src/web/mcp-list.ts:78`, `src/web/federation/poller.ts:245`), és mert így nincs vita tárgya.
Viselkedésbeli eltérés nincs: a wrapper törzse csak `new X(ctx)`-et hív (nem dobhat) és
visszaad egy promise-t.

**4. `filterOwnNodeCandidates` NEM kap `ctx` paramétert.** Privát metódusként `this.ctx`-et
olvassa. Ha megtartaná a paramétert (miközben `this.ctx` is ott van), az garantált
`/code-review` finding lenne. A függvény 8 `if`-je marad lefedett a meglévő tesztekből —
alább a `continue`/`warn` ág fedő tesztje soronként; a komplementer (átesik) ágakat minden
sikeres eset fedi (pl. `:87`, `:118`, `:140`):

| Ág | Fedő teszt | Sor |
|---|---|---|
| `!Number.isFinite(pid) \|\| pid <= 0` (`:97`) | `'skips non-positive or non-finite PIDs defensively'` | `:130` |
| `pid === ctx.currentPid` (`:98`) | `'excludes the current PID even if it appears in the holder list'` | `:92` |
| `seen.has(pid)` (`:99`) | `'deduplicates PIDs that appear twice in the holder list'` | `:143` |
| `cmd == null` (`:102`) | `'skips PIDs that are gone between lsof and ps'` | `:122` |
| `ctx.uid != null` false-ág (`:103`) | `'skips UID check when the platform has no getuid (uid=null)'` | `:135` |
| `ownerUid == null` (`:105`) | `'skips a PID whose owning UID lookup returns null…'` | `:151` |
| `ownerUid !== ctx.uid` (`:106`) | `'excludes processes owned by a different UID'` | `:101` |
| `!/node\|tsx/i.test(cmd)` (`:111`) | `'excludes non-node commands'` | `:111` |

---

## Amit a roadmap előír, de SZÁNDÉKOSAN kihagyunk

A `05-refactor-roadmap.md` E.1/E.2 szakasza három olyat kér, ami itt hibát okozna. Ezt a
docs-commit rögzíti is:

| Roadmap | Miért nem |
|---|---|
| `new PortLockAcquirer(ctx, opts).acquire(port)` — opts a **konstruktorban** (`:34`) | Az opts a metódusra kerül. A jelenlegi kód hívásonként értékeli ki a defaultokat (`:174-176`), amit a per-hívás opts triviálisan megőriz. Ezt a roadmap saját risk-jegyzete is elismeri (`:45-50`). |
| `release()` metódus (`:58`, `:102-105`) | Ma nem létezik; a `releaseLock()` az `index.ts:356-364`-ben él. Új metódus production hívó nélkül **dead code** → CLAUDE.md §8 szerint `/code-review` CRITICAL. |
| `acquire(port, overrides)` override-szemantika (`:59-61`) | A roadmap maga `[ASSUMPTION]`-ként jelöli. Nem kért funkció, CLAUDE.md §2. |

Szintén kihagyva (E.5/E.6, külön fázisok): a szabad függvények törlése, az `index.ts` hívóhely
migrációja, a `LogFn` → `LoggerLike` csere.

---

## Új teszt fájl: `src/__tests__/process-lock-classes.test.ts`

**Nem coverage miatt kell** — a wrapperek végrehajtják a metódusokat, tehát az istanbul
function/branch számláló amúgy is teljesülne. Azért kell, mert két **új exportált osztály**
kerül a publikus felületre, és annak közvetlen szerződés-tesztje kell legyen (a `10d06cb`
`channel-provider-classes.test.ts` precedense).

Fixture: **kompakt, célra szabott** ctx literálok a fájlon belül. NEM másoljuk át a
`process-lock.test.ts:29` `makeCtx` 55 soros opció-vezérelt gépezetét — ezek a tesztek
egyszerű forgatókönyveket futtatnak.

7 `it()` eset:

1. `PortLockAcquirer#findOwnNodeHolders` közvetlen hívásból a saját-UID node holdereket adja
2. `PortLockAcquirer#findOwnBinaryMatches` közvetlen hívásból argv-egyezést ad
3. `PortLockAcquirer#terminateProcesses` SIGTERM után SIGKILL-el egy túlélőt
4. `PortLockAcquirer#acquire(port, { graceMs })` — explicit-opts ág
5. `PortLockAcquirer#acquire(port)` opts nélkül — default ág, **és ugyanaz a példány két
   különböző porton** (bizonyítja, hogy a `ctx` példányállapot, nem per-hívás argumentum)
6. `PidfileLockAcquirer#acquire(path, selfPid)` opts nélkül létrehozza a pidfile-t — default ág
7. `PidfileLockAcquirer#acquire(path, selfPid, { onLiveLegitimate: 'defer' })` `DeferToPeerError`-t
   dob, `peerPid === recorded`, és `instanceof DeferToPeerError` igaz az osztály-úton is

Várt teszt-összeg utána: **11211 + 7 = 11218**.

---

## Végrehajtás — Workflow (4 agent, 3 fázis)

A `Workflow` tool egy scriptet kap; a script maga nem fér a fájlrendszerhez, a git-műveleteket
az agentek végzik.

### Fázis 1 — Implement (1 agent, EBBEN a worktree-ben)

Közvetlenül `/Users/eggp/marveen-develop/test-baseline`-ben dolgozik a `refactor/classbase`
branchen, így a commit eleve a helyén van — nincs merge-back manőver.

Lépések:
1. `src/process-lock.ts` átírása a fenti szerkezet szerint.
2. `src/__tests__/process-lock-classes.test.ts` létrehozása (7 eset).
3. Gate-ek, mind flag NÉLKÜL (CLAUDE.md §8):
   - `bun run coverage` → **384** file (az új teszt fájllal), **11218** teszt, exit 0
   - `bun tsc --noEmit` → **≤ 1729**
   - `bun run lint` → **≤ 10048**
   - `git diff --stat` → pontosan **2** fájl (`src/process-lock.ts` + az új teszt fájl)
4. Commit: `refactor(process-lock): extract PortLockAcquirer + PidfileLockAcquirer classes (E.1/E.2)`
5. Két verifier-worktree előkészítése (a SHA ismeretében, versenyhelyzet nélkül):
   `git worktree add --detach $HOME/claw-verify-a <SHA>` és `…-b`, majd mindkettőbe
   `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules <path>/node_modules`.
   `$HOME` alatt, **nem `/tmp/`** alatt (CLAUDE.md §8: `/tmp/` alatt a
   `src/web/agent-scaffold.ts` `_TMP_PREFIXES` guard 19 hamis failt okoz).
6. Strukturált visszatérés: `{ commitSha, worktreeA, worktreeB, tests, testFiles, tscErrors, lintProblems, changedFiles[] }`

### Fázis 2 — Verify (2 agent párhuzamosan, ELTÉRŐ szögből)

CLAUDE.md §8: a két verifier nem futtathat azonos checklistet. Külön worktree-ben futnak,
így két egyidejű vitest nem tud egymás `store/` állapotába belelógni.

- **Verifier A — strukturált PASS/FAIL checklist.** Minden állítást egyenként, bizonyítékkal:
  a 3 érintetlen fájl tényleg érintetlen (`git show --stat`); a publikus export-felület
  szignatúrái azonosak a szülő committal (`git diff <SHA>~1 <SHA> -- src/process-lock.ts`);
  nincs `as`, nincs `any`, nincs string-konkatenáció (CLAUDE.md §7); a `filterOwnNodeCandidates`
  mind a 8 `if`-ága fedett. Önállóan újrafuttatja: `bun run coverage` + `bun run lint`.

- **Verifier B — adverzariális falszifikáció.** Szabad kézzel próbálja megdönteni az
  ekvivalencia-állítást. Eldobható (soha nem commitolt) próbateszteket írhat: azonos inputon
  a `git show <SHA>~1:src/process-lock.ts` viselkedése egyezik-e az újéval; van-e `this`-kötési
  út, ahol a delegáció eltér; a `DeferToPeerError` `instanceof` diszkrimináció tényleg
  átmegy-e az osztály-úton; a `ctx` objektum futásidejű mutálása
  (`process-lock.test.ts:161` ezt csinálja) átüt-e a `private readonly ctx`-en. Futtatja a
  teljes `bun --bun vitest run`-t.

Barrier (`parallel`) itt indokolt: a javítási döntéshez mindkét verdikt kell.

### Fázis 3 — Repair (feltételes, 1 agent)

Csak ha a két verifier közül bármelyik **megerősített** defektust talál. Javít, teszttel fedi
(CLAUDE.md §7: minden bugot teszt fed a javítás után), újrafuttatja a gate-eket, és külön
committal zár: `fix(process-lock): …`. Ha nincs finding, a fázis kimarad.

### Workflow után — docs commit (a fő session-ben)

`docs(e-process-lock): mark E.1/E.2 landed + correct measured refs`

Figyelem: a terv két különböző `00-summary.md`-re hivatkozik. A docs-commit **kizárólag** a
`docs/refactor-to-classbase/e-process-lock/` alatti fájlokat érinti; a gyökér
`docs/refactor-to-classbase/00-summary.md` (amit a Context szakasz idéz) **nem változik**.

- `docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md`: E.1 (`:23`) és E.2
  (`:73`) megjelölése landolt-ként, a fenti három szándékos eltérés (opts helye, `release()`,
  `overrides?`) rögzítése, és a refaktor UTÁNI `wc -l src/process-lock.ts` érték felvétele.
- `docs/refactor-to-classbase/e-process-lock/00-summary.md` három mért hibája:
  - `:5` és `:37` — "365 lines" → **"364 lines (pre-E.1/E.2)"**. A `pre-E.1/E.2` minősítés
    kötelező: a mondat a 2026-08-30-i elemzés állapotát írja le, és a refaktor után a fájl
    hosszabb lesz, tehát puszta "364" azonnal félrevezető volna.
  - `:39` — "33 `it()` cases" → **50 `it()` hívóhely + 2 `it.each` blokk (`:798` 5 eset,
    `:808` 6 eset) = 61 futó teszteset**. (A puszta "50" is pontatlan lenne.)
  - `:40` — `withRealAcquirePortLock` `:1363` → **`:1365`**, `withRealAcquirePidfileLock`
    `:1314` → **`:1317`**

A SHA-t nem inline-oljuk a commit előtt (CLAUDE.md §8): `(this commit)` placeholder, majd
szükség esetén follow-up commit írja át.

### Lezárás — `/code-review max --fix`

CLAUDE.md §8 szerint ez a skill `disable-model-invocation` flag-es: a Skill tool elutasítja,
és a §8 kifejezetten tiltja, hogy megkíséreljem vagy más toollal lemásoljam a workflow-ját.
Tehát **neked kell beírnod a terminálba**: `/code-review max --fix`. Az általa talált
javítások külön `fix(process-lock): apply code-review fixes` commitba mennek.

### Takarítás

`git worktree remove $HOME/claw-verify-a --force` és `…-b` a fázis 2 után.
Stash-t nem használunk (megosztott stack, CLAUDE.md).

---

## Verification — mikor kész

| # | Ellenőrzés | Elvárt |
|---|---|---|
| 1 | `bun run coverage` (flag nélkül) | exit 0, **384** file, **11218** teszt |
| 2 | `src/process-lock.ts` perFile coverage | 100% / 100% / 100% / 100% |
| 3 | `bun tsc --noEmit` | ≤ **1729** |
| 4 | `bun run lint` | ≤ **10048** |
| 5 | `git show --stat <SHA>` | pontosan 2 fájl |
| 6 | `git diff <SHA>~1 <SHA> -- src/index.ts src/__tests__/index.test.ts src/__tests__/process-lock.test.ts` | üres |
| 7 | Export-felület | `findOwnNodeHolders`, `findOwnBinaryMatches`, `terminateProcesses`, `acquirePortLock`, `acquirePidfileLock`, `writeBufferFully`, `DeferToPeerError`, `SignalOutcome`, `ExclusiveCreateOutcome`, `ProcessLockContext`, `PidfileLockContext`, `AcquirePortLockOptions`, `AcquirePidfileLockOptions` mind megmarad, azonos szignatúrával; **plusz** `PortLockAcquirer`, `PidfileLockAcquirer` |
| 8 | Két verifier verdikt | mindkettő PASS, vagy a findingok javítva + újramérve |
| 9 | `/code-review max --fix` | lefutott (user hívja), findingok javítva |

## Rollback

Egyetlen `git revert <SHA>`. A wrapper-szignatúrák bit-azonosak a mostaniakkal, tehát
downstream fájl nem igényel igazítást.
