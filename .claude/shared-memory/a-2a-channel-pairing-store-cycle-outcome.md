# A.2a ChannelPairingStore class extraction — Cycle outcome (2026-09-12)

## Összefoglaló

A `refactor/classbase` branch-en a 2026-09-12-i A.2a ciklus
3 commit-ból áll:

| SHA | Szerző | Tartalom |
|---|---|---|
| `98976a9` | EggProjectTeams | Implementer commit: `class ChannelPairingStore` + 4 thin wrapper + 13 `it()` blokk az új teszt fájlban |
| `d014dcd` | EggProjectTeams | Code-review --fix commit: HIGH finding (singleton const hozzáadás), 2 vacuous typeof teszt kiszedés, as cast kiszedés |
| `f0067cd` | EggProjectTeams | Docs reconciliation commit: LANDED státusz, SHA placeholder-ek cseréje, deliberate deviations szekció |

A refactor/classbase végállapot HEAD-je `f0067cd`. Az 50a417b
baseline óta összesen 3 commit a refactor/classbase ágon.

## Gate-ek végállapota

| Gate | Érték | Megjegyzés |
|---|---|---|
| `bun tsc --noEmit` | 0 errors | baseline 0, +0 |
| `grep -cE "^export function " src/db.ts` | 155 | wrappers byte-equiv replacement |
| `grep -cE "^export class " src/db.ts` | 5 | +1 (`ChannelPairingStore`) |
| `grep -cE "^export (interface\|type) " src/db.ts` | 37 | unchanged |
| `bun --bun vitest run src/__tests__/channel-pairing-store.test.ts` | 12 passed, 0 failed | code-review --fix után |
| `bun --bun vitest run channel-request*.test.ts + db-100 + agents-routes` | 515 passed, 0 failed | no regressions |
| ESLint on test file | 17 → 12 errors | a maradék 12 pre-existing unrelated |
| Pre-existing scripts/agent-memory/* fails | unchanged | (11 module-load, scope-on kívül) |

## Lessons / tanulságok (refactor-cycle §7)

1. **Implementer text ambiguity** — a terv „NEVER touch the 4
   pre-existing free functions" ÉS „insert the class + 4 wrappers"
   ellentmondás volt (a literal insert TS duplicate-exportot
   produkált volna). A subagent jól döntött: a free-fn shimek
   felülírják az eredeti törzseket (signature + name marad
   byte-identical, csak a body delegál a class method-ra). A
   közeljövő terveiben explicit ki kell jelölni, hogy a wrapper
   SURVIVES vagy REPLACES az eredeti free function-t.

2. **Verifier B vacuous-test audit hatékonysága** — a két
   vacuous assertion (`returns false for an unknown id` +
   `returns [] for no rows agent`) ellenőrizhetetlen lett volna
   a suite-level PASS mellett. A paired-assertion javítás
   (positive control) után a 2 gut-mintázat egyaránt FAILED,
   ahogy a spec kívánta. A refactor-cycle §5b szabály érvényesítése
   működik — a CLAUDE.md §8 erre a második corpus hit (E.1/E.2 a
   2026-08-30, F.3 az F.3 cycle `ac13503`).

3. **Workflow tool safety classifier NEW precedens** — a code-review
   skill (`disable-model-invocation` miatt) jelen session-ben
   SIKERESEN lefutott user-triggered fork formában
   (`agentId: a451258575bbd8112`). A Skill tool blockolta volna, a
   direct fork a `/code-review max --fix` parancsot a user
   termináljából AGENT-ként futtatta (`<forked-skill-launch>`-ban
   capture-ölve). Ez ÚJ minta: a session mainloopból a
   code-review skill-t a user indítja, és a rendszer notification
   útján hozza vissza az eredményt. A Honcho entry ezt
   külön kiemeli.

4. **Class-vs-functional-decision szabály rendszerszintű eltérése** —
   a három kis-DI-only store (ChannelPairingStore, IdeaStore,
   ApprovalStore) formálisan 1/5-öt ér el a szabály 5 kérdésén
   (≥2 kell, ≥1 az 1/2/3 kategóriából). A kód review
   Skipped-ként dokumentálta, mert a három revertálása out-of-
   scope. A usernek kell döntenie az ADR-ről: vagy (a)
   elfogadjuk a „DI-only store" kivételt class formára, vagy
   (b) revert mind a hármat module function-ökre.

## Hivatkozások

- Honcho entry: `2026-09-12 A.2a ChannelPairingStore class extraction CYCLE OUTCOME`
- Skipped finding: `.claude/shared-memory/a-2a-channel-pairing-store-skipped-finding.md`
- Plan file: `.claude/plans/quiet-finding-gadget.md`
- Cycle commits on refactor/classbase: `98976a9`, `d014dcd`, `f0067cd`
- Implementer worktree (cleaned up): `$HOME/claw-a2a`
- Verifier worktrees (cleaned up): `$HOME/claw-a2a-verify-A`, `$HOME/claw-a2a-verify-B`
- Code-review worktree (cleaned up by code-review agent): `$HOME/claw-review-test`
