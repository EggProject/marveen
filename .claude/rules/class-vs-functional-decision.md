---
paths:
  - "**/*.ts"
---

# OOP vs Functional Programming — class-extract döntési szabályok

## Miért van ez a dokumentum

A 2026-08-31-i refaktor (`docs/refactor-to-classbase/i-auto-restart/`) során az
`AutoRestartSchedule` class-ba **kizárólag** azért raktam `static` metódusokat,
mert "úgy kell OOP-t csinálni". Ez ceremony, nem OOP. A user kritikája jogos:

> "csak azert mert OOP-t kerek es akkor class csak static fuggvenyekkel nem jo
> megoldas! ... ahol szukseges maradhat functional programming"

A cél: a jövőbeli hasonló refaktor-tervekhez (főleg a
`docs/refactor-to-classbase/` Phase 0–8 klasztereihez) konkrét döntési keretet
adni, hogy NE forduljon elő ilyen "OOP-label a functional content felett"
anti-pattern.

## A fő szabály (egy mondat)

**A class form nem önmagában cél. Csak akkor indokolt, ha legalább az alábbiak
EGYIKE fennáll: (a) per-instance mutable state, (b) interface többféle
implementációja (strategy/polymorphism), (c) lifecycle (init/dispose), (d)
constructor-injected függőségek (DI). Különben module-level függvények
(functional core).**

Ez a "Functional Core, Imperative Shell" minta (Mark Seemann, ploeh blog)
megfordítása: a domain-tiszta logika functional core és MODULE, az orchestration
imperative shell és CLASS.

## Döntési fa (mielőtt class-t írnál, menj végig sorrendben)

Minden kérdésre IGEN/NEM válasz. Ha 0–1 IGEN, a class ceremony — NE.

1. **Van per-instance mutable state?** (cache, connection, accumulator,
   counter, last-read timestamp, stb.)
   - NEM → functional core, module function. **STOP, ne class.**
   - IGEN → tovább

2. **`implements X` — van interface, amit többféleképpen implementálnak?**
   (strategy pattern, pl. `ChannelProvider` 5 provider osztállyal)
   - NEM → functional core + factory function. **STOP, ne class.**
   - IGEN → class az `implements X` formával, tovább

3. **Van lifecycle?** (init → run → dispose, ahol a sorrend fontos,
   pl. `App.shutdown()` order-sensitive kilenc lépésben)
   - NEM → functional core. **STOP, ne class.**
   - IGEN → class, tovább

4. **Constructor-injected függőségek?** (logger, fs, config, network, store
   — azaz a class maga NEM hozza létre a függőségeit, hanem kívülről kapja)
   - NEM → functional core (a függőség paraméterként átadva). **STOP.**
   - IGEN → class, tovább

5. **A tesztelhetőség javul per-instance izolációval?** (két teszt ne
   osztozzon shared state-en)
   - NEM → functional core. **STOP.**
   - IGEN → class

**Döntés:** ha a fenti 5-ből **legalább 2 IGEN** (és legalább az egyik az
1/2/3 pontokból), a class indokolt. Ha 0–1 IGEN, class = ceremony.

## Anti-pattern lista (explicit, NE)

- ❌ **Static-only class instance state nélkül.** A `AutoRestartSchedule` 2026-08-31
  hiba: 5 `static` metódus + `static readonly DEFAULT` mező, nulla `this`,
  nulla DI, nulla lifecycle, nulla polymorphism. Ez ceremony.
- ❌ **Class csak azért, mert "OOP-t kérek".** A class form eszköz, nem cél.
- ❌ **Class ami nem `implements X`.** Nincs interface, nincs többféle
  implementáció → nem class, hanem module.
- ❌ **Class ami singleton-ként használatos lenne, de `App` constructor-on
  át sem kapja meg.** A "class a polcra" nem instance-olás, hanem namespace.
- ❌ **Class ahol minden metódus `static` és nincs `this`.** Ugyanaz, mint
  az első.
- ❌ **Class ami csak a free function-öket csomagolja, anélkül hogy bármit
  hozzáadna (state, lifecycle, polymorphism).** A wrapper-ök "visszafordítása"
  a class-ba ceremony.
- ❌ **`@deprecated` free function wrapper-ök mint "migration window"** —
  ha nincs konkrét consumer aki a class formát használná, a wrapper-ök
  sosem kerülnek eltávolításra, csak élősködnek a kódon.

## Pozitív példák (mikor IGEN a class)

A `docs/refactor-to-classbase/` eddig landolt class-ai — mind az 5 feltétel
közül legalább 2-t teljesítenek:

| Class | Fájl | Instance state | Polymorphism | DI | Lifecycle |
|---|---|---|---|---|---|
| `TelegramChannelProvider` + 4 testvér | `channel-provider.ts` | kis per-instance config | `implements ChannelProvider` 5× | (factory) | – |
| `PortLockAcquirer` | `process-lock.ts:77` | `ctx: ProcessLockContext` `this`-en | – | igen | – |
| `PidfileLockAcquirer` | `process-lock.ts:314` | `ctx: PidfileLockContext` `this`-en | – | igen | – |
| `LazyBin<TName>` | `platform.ts:76` | `private cached: string \| null` | – | (resolver param) | `invalidate()` |

Plusz a tervezett keystones:

| Class | Terv | Miért class |
|---|---|---|
| `Config` (B.1) | 58 const + `fromEnv(logger?)` factory + 23 importer DI | instance state az `env` record + factory entry point |
| `DbClient` (B.2) | entity store-ok konténere + per-instance connection | per-instance connection, lifecycle |
| `App` (B.3) | orchestrator + shutdown order | lifecycle kilenc lépésben, DI aggregate |
| `HeartbeatScheduler` (F.1) | `config + store` constructor | DI + lifecycle |
| `BaseRunner<TFacts, TDecision>` (G6) | ~20 runner abstract base | polymorphism + lifecycle |

## Alkalmazás a `docs/refactor-to-classbase/` MD-vel összhangban

A `00-summary.md` "Top 3 lowest-risk wins" listája TÉVESEN sorolta a
`AutoRestartSchedule`-et a class kategóriába. Ez a téves besorolás az oka,
hogy a 2026-08-31-i ciklus ceremony-ba torkollt. **MD-javítás szükséges a
jövőben:** a "Top 3 lowest-risk wins"第四 (auto-restart) átkerül a
"out-of-scope — functional core" kategóriába, hacsak nem találunk konkrét
instance-state vagy DI célt hozzá.

A Phase 0–8 klaszterek helyes besorolása:
- ✅ Class: `ChannelProvider`, `PortLockAcquirer`, `PidfileLockAcquirer`,
  `LazyBin`, és minden ami instance state-et, polymorphism-ot vagy lifecycle-öt
  valósít meg.
- ❌ Functional core (module function): `AutoRestartSchedule`,
  `SettingsRegistry` helper-ek (per `b-config/00-summary.md` OE-8), minden
  pure-decision helper ami nem kap DI-t.

## Források (a kutatás eredménye)

1. **TypeScript Handbook — Classes:**
   > "A class with only a single instance is typically just represented as a
   > normal object in JavaScript/TypeScript."
   > Ajánlott alternatívák: `function doSomething() {}` vagy
   > `const MyHelperObject = { dosomething() {} }`.

2. **oida.dev — "Tidy TypeScript: Avoid traditional OOP patterns" (2020-11-24):**
   > "a proper module is always preferred to a class with static fields and
   > methods. That's just an added boilerplate with no extra benefit."
   > Anti-pattern lista: static class, namespace (`.d.ts` kivételével),
   > abstract class. Helyette: "Modules, objects, and functions. Occasional
   > classes."

3. **dev.to — "Do you need classes in JS/TS? [2025 version]" (2025-03-18):**
   Mikor IGEN: games (enemy state), data structures with internal state,
   stateful components, complex algorithms with many variables, database
   connection pool. Mikor NEM: data transformations without internal state
   ("classes are a bad fit!"), API request handlers (concurrent isolation
   dangerous with shared state), POD only, methods that don't use `this`.

4. **Mark Seemann — "Functional Core, Imperative Shell" (ploeh blog, 2018+):**
   Domain layer = pure functions (functional core), no class.
   Outer layers = side-effecting orchestration (imperative shell), class
   justified. A kulcs-összefüggés:
   > "impure functions can call pure functions with no particular consequence,
   > but pure functions cannot call an impure function without becoming
   > impure as well"

5. **StackOverflow / Reddit / Quora thread-ek** (konszenzus): a class csak
   indokolt, ha az interface-szerződés vagy az instance state a valódi
   haszna; egyébként module function.

## Mit változtat ez a mostani állapoton?

A `refactor/classbase` branch-en a `db8b140a` + `584135d` + `772f0e5` +
`635d3c8` commitok landoltak. A `635d3c8` code-review fix (`isPlainObject`
typeguard) a TS2322 hibát orvosolta, és a `117/117` teszt zöld.

A usernek KELL döntenie, hogy:
- **(a) Élünk a mostani class formával.** A 4 commit marad, ceremony de
  működik, wrapper-ök biztonsági hálóként megvannak. A `00-summary.md`
  "Top 3 lowest-risk wins" listája TÉVES, de a code-review átengedte.
- **(b) Revert + újraírás module formában.** A 4 commitot újraírjuk
  module-level függvényekkel:
  - A class helyett module-level function-ök (`parseHHMM`,
    `normalizeAutoRestartConfig` stb. — ahogy eredetileg voltak).
  - Az eslint-disable comment-ek törlendők (`no-extraneous-class`,
    `no-deprecated`).
  - A wrapper-ökre nincs szükség, mert nincs class amire delegate-elnének.
  - Az `auto-restart-class.test.ts` fájl újraírandó, hogy a functional
    API-t tesztelje.
  - Ez 1 új revert commit + 1 új refactor commit, history nem duplázódik.

A döntés a useré, de a **jövőbeli refaktor-terveknél** ez a döntési fa
mérvadó: minden class-extract tervet a fenti 5 kérdéssel kell indítani,
és a tervben explicit ki kell jelölni, hogy melyik 1+ feltétel teljesül.
Ha a terv ezt nem tudja megindokolni, a terv ceremony-terv — visszautasítandó.
