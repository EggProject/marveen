# A.2a ChannelPairingStore — Skipped finding (2026-09-12)

## Miért van ez a fájl

A CLAUDE.md §7 kötelezővé teszi, hogy a `/code-review max --fix`
`Skipped` findingjeit vagy javítani kell, vagy a Honcho + shared-
memory rendszerbe kell írni release checklist nélkül NEM zárható
session. Ez a fájl a 2026-09-12-i code-review `Skipped` szekciójának
teljes leírását tárolja.

## A Skipped finding szövege (verbatim)

> "class form may be ceremony per `.claude/rules/class-vs-functional-decision.md`.
> ChannelPairingStore has DI (point 4 of the rule's 5 questions) but
> no instance state / polymorphism / lifecycle, which the rule says
> is below the threshold. However, `ApprovalStore` and `IdeaStore`
> already establish this exact pattern in the codebase, and
> identifying it would require a broader refactor revert that's out
> of scope for a single-commit review."

## Resolution a 2026-09-12-i sessionben

A `ChannelPairingStore` class forma MARADT, mert:
1. A három érintett store (`ChannelPairingStore` — `d014dcd`,
   `IdeaStore` — `3f41c08`, `ApprovalStore` — `863b325`) közös
   pattern-t követ. Ha ezt revertáljuk, a másik kettőt is.
2. A code-review HIGH finding megoldotta a formát:
   `const channelPairingStore = new ChannelPairingStore()` module
   singleton, ÍGY a free-function wrappers nem allokálnak minden
   hívásnál új class instance-ot.
3. A revertálás szélesebb architektúrai döntés, ami külön ADR-t
   igényel.

## Class-vs-functional-decision szabály alkalmazása

A 5 kérdés:
1. Per-instance mutable state? — **NEM** (a `getDb` mező readonly)
2. `implements X` polymorphism? — **NEM**
3. Lifecycle? — **NEM**
4. Constructor-injected DI? — **IGEN** (`deps?: { getDb?: () => Database }`)
5. Per-instance izoláció javítja a tesztelhetőséget? — **NEM**
   (tesztelhetőség javul a wrapper-ökön át is)

Eredmény: 1/5 IGEN. A szabály szerint ≥2 kell (≥1 a 1/2/3 kategóriákból).
Ez a 3 store FORMÁLISAN nem teljesíti a szabályt — DE a `class-only-
statics` 0/5-ös esettel ellentétben (AutoRestartSchedule, WITHDRAWN
2026-08-31) itt van DI override út.

## Mit KELL dönteni a usernek a következő alkalommal

A `ChannelPairingStore` + `IdeaStore` + `ApprovalStore` hármas
együttesen érintett. Két járható út:

**(a) Megtartjuk a class formát mindháromnál** — a rule-t kell
frissíteni, hogy elfogadja a „DI-only" class formát a store-ok
számára, mert a vi.mock('../db.js', ...) site-ok NEM illeszkednek
constructor-injection-re egy production caller migráció nélkül.
A doc string-be bekerül: „A store classes elfogadhatók DI-only
formában, MERT a production caller migráció scope-on kívül esik
és a wrapper-ök biztosítják a backward compatot."

**(b) Visszavonjuk mindhármat module function-ökre** — az A.2a
commit + 2 korábbi commit visszavonása, az új class formától
való elállás. A honcho peer card-on az „AI tooling: ... workflow
tool, parallel subagent orchestration" említi a refactor scope-ját;
ez a döntés a backlogot csökkenti, de a code-review skill által
kifogásolt formát szanálja.

A (b) opció 3 commit revert + docs reconciliation komplexebb,
mint a (a) opció 1 file-szerkesztés a .claude/rules/class-vs-functional-decision.md-ben.

## Hivatkozások

- Honcho entry: `2026-09-12 refactor A.2a ChannelPairingStore
  /code-review max --fix Skipped finding` (create_conclusion output)
- CLAUDE.md §7: „Skipped finding KÖTELEZŐEN vagy javítva, vagy
  memóriába írva"
- CLAUDE.md §6: „Nincs AI klisé"; entry hangnem konzervatív
- `.claude/rules/class-vs-functional-decision.md` — az eredeti
  szabály 2026-08-31-i AutoRestartSchedule WITHDRAWN után
- Commit `d014dcd` (code-review --fix) — ahol a HIGH findinget
  alkalmazták (singleton const hozzáadása)
- Commit `98976a9` (implementer commit) — eredeti class + thin wrapper

## Cycles

- 2026-09-12: created (this entry)
