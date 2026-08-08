# agent-worker.ts: a 20. sor (üres sor) v8 coverage quirk miatt 1 line uncoverable

## Location

`src/web/agent-worker.ts`, line 20 (a `import { notifyChannel } from '../notify.js'`
utáni üres sor).

## Excerpt

```ts
18: import { detectPaneState } from '../pane-state.js'
19: import { notifyChannel } from '../notify.js'
20:                                          // <-- ez a sor: üres
21: // =============================================================================
22: // Interactive-tmux agent worker (jun.15 subscription migration).
```

## Failure scenario

A v8 coverage provider a 20. sort `cline-no` (executable but uncovered) markerrel
jelöli, noha a sor valójában üres (nincs rajta végrehajtható kód). Ez a v8
egyik ismert quirkje: bizonyos esetekben az import blokkok közötti üres sort
is `executable line`-ként kezeli, így a 100% line coverage gate 229/230 = 99.56%-on
ragad.

A sort nem lehet a tesztekből lefedni, mert nincs rajta kód -- a fedéshez a
forráskódot kellene módosítani (pl. törölni a sort vagy kódot írni rá), de a
felhasználó ezt kifejezetten tiltotta.

## Coverage impact

`lines = 99.56% (229/230)`. Az 1 uncoverable line a fenti üres sor.

## Suggested direction

A 100% line coverage gate eléréséhez két lehetőség van:

1. **Forráskód módosítása**: a 20. sort kitörölni vagy egy `// noop` komment
   nélküli sorra cserélni. Ez a legegyszerűbb megoldás, de a felhasználó a
   forráskód módosítását kifejezetten megtiltotta a feladat során.

2. **A v8 coverage provider konfigurációjának módosítása**: a
   `vitest.config.ts`-ben a coverage thresholds alatt explicit kizárni az
   `src/web/agent-worker.ts` fájlt a 100% line gate-ből, miközben a többi
   metrika (statements, branches, functions) marad 100%. Ez a coverage gate
   lazítása, nem a forráskódé.

3. **A `coverage.reportsDirectory` és a v8 opciók finomhangolása**: a v8
   `exclude-after-remap` opciójával vagy a `coverage.exclude` globbal
   kiszűrhetők a comment-only / üres sorok. Ez a `vitest.config.ts`
   `coverage.include` és `exclude` listáin keresztül konfigurálható, de
   nincs rá standard, v8-specifikus megoldás.

A jelenlegi baseline tesztek a lehető legnagyobb lefedettséget érik el
(99.4% branches, 98.93% statements) a forráskód módosítása nélkül.

## Baseline state

A 4 uncoverable elem (üres sor + 3 strukturálisan elérhetetlen branch) a
következő MD-kben van dokumentálva:
- `agent-worker-seedworkercredentials-unreachable.md` (line 211)
- `agent-worker-selfheal-catch-unreachable.md` (line 604 catch)
- `agent-worker-runviaworker-afterloop.md` (line 751)
- ez a fájl (line 20, üres sor v8 quirk)
