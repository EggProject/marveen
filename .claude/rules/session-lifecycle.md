---
paths:
  - ".claude/shared-memory/**/*.md"
  - ".claude/retrospectives/**/*.md"
---

# Session lifecycle — commit before stop

## Miért van ez a dokumentum

A Claude Code session-ök gyakran hoznak létre új fájlokat a
`.claude/shared-memory/` és `.claude/retrospectives/` mappákban. Ha ezek
a session végén untracked maradnak, a corpus széttöredezik: a Honcho
memória entry megvan, de a projekt-lokális fájl hiányzik (vagy fordítva).
A release checklist nélkül ezek a fájlok elvesznek a következő session
számára, és a tanulságok rekurzíven ismétlődnek.

A 2026-09-09-i A.2d ApprovalStore session (session-id `389d5af2`) négy
alkalommal hozta létre ezt a helyzetet 24 óra alatt, és a retrospective
skill a 4. hit-et külön proposal-ként azonosította.

## A fő szabály (egy mondat)

**Ha a session új fájlt hoz létre a `.claude/shared-memory/` vagy
`.claude/retrospectives/` mappában, azt a session vége előtt a working
branch-re commitolni kell.**

## Hol él ez a szabály

Ez a rule a `.claude/rules/` mappában van, NEM a `CLAUDE.md`-ben. A
különbség:

- `.claude/CLAUDE.md` — a felhasználó által jegyzett policy fájl.
  Módosítása policy-döntés; a workspace convention tiltja az agent-ek
  általi közvetlen szerkesztést.
- `.claude/rules/*.md` — always-loaded rule fájlok (a Claude Code a
  session indításakor betölti). Ide a Claude (vagy a user) által
  alkalmazott session-end viselkedési szabályok kerülnek.

A paths frontmatter jelen esetben a `.claude/shared-memory/**/*.md` és
`.claude/retrospectives/**/*.md` mintákra szűkíti a rule érvényességét
(a class-vs-functional-decision.md mintáját követi), mert csak ezekre
a fájltípusokra vonatkozik a session-end commitment pattern.

## Hogyan működik a Stop hook

A `.claude/hooks/stop-guard/core.ts` `decideStopAction` függvénye egy
új szabállyal egészült ki:

1. A hook entrypoint (`hook.ts`) a session cwd-jében futtatja a
   `git ls-files --others --exclude-standard .claude/shared-memory/
   .claude/retrospectives/` parancsot.
2. Ha a parancs kimenete nem üres, és a per-session state
   (`uncommittedMemoryNudged` flag) hamis, a hook blokkol: exit 2,
   stderr-re a fájlok listája, hogy a user `git add` + `git commit`
   után újra próbálkozhasson.
3. Ha a state már `true` (a session egyszer már blokkolt ezen a
   szabályon), a hook átenged (once-per-session, hogy ne ragadjon
   be).

A szabály a Todo-list szabály ELŐTT fut, mert az uncommitted memory
fájl release-blocker (elveszik a corpus), míg a Todo list emlékeztető.

## Session-end commit pattern (operational)

A session végén, ha bármely új fájl keletkezett a két mappában:

```
git add .claude/shared-memory/ .claude/retrospectives/
git -c user.email=<author-email> -c user.name=<author-name> commit -m "chore(retrospective): commit session outputs (memory dual-write + retrospectives)"
```

A commit author a project author kell legyen (a `git log -1` az adott
branch-en), NEM `Claude <claude@anthropic.com>` — lásd CLAUDE.md §8
commit-author pre-check szabály.

## Kapcsolódó precedensek

- `135e948` — az első dual-write Honcho + shared-memory commit. A
  pattern csak a Honcho entry-t commitolta, a shared-memory fájlt nem
  — ez volt az eredeti tanulság.
- `9ff2360` — a 2026-09-09-i A.2d session follow-up commitja, ami a
  retrospective skill észlelése után commitolta a shared-memory fájlt.
- A 2026-09-06-i `f84a8666` session — két confirmed bug került a
  `/code-review` Skipped szekciójába, és a user háromszor javította,
  majd 4 új worktree + 5 fix commit kellett a pótláshoz. A
  release-checklist prevention mintát ez a rule is követi.
- `.claude/CLAUDE.md` §7 — a Honcho + shared-memory dual-write POLICY
  (itt van rögzítve, mert policy, nem rule).

## Anti-pattern lista (explicit, NE)

- ❌ **Shared-memory fájl létrehozása commit nélkül.** A session
  utolsó lépése a `git add .claude/shared-memory/ && git commit` kell
  legyen, ha bármi új fájl keletkezett.
- ❌ **Retrospective fájl létrehozása commit nélkül.** Ugyanaz, mint
  fent, a `.claude/retrospectives/` mappára.
- ❌ **A dual-write szabályt Honcho-only-nak tekinteni.** A Honcho
  entry a keresést segíti, de a perzisztenciát a shared-memory fájl
  adja. Csak Honcho-ba írni = "elveszik a session restartkor".
- ❌ **CLAUDE.md módosítása rule-ok helyett.** A `CLAUDE.md` policy,
  a `.claude/rules/*.md` rule. A kettő NEM felcserélhető; a
  workspace convention tiltja a `CLAUDE.md` agent-oldali módosítását.
- ❌ **A Stop hook skip-elése `uncommittedMemoryNudged: true` rögtön
  beállításával.** A flag per-session egyszer blokkol; a második
  hívás átenged. A flag manuális beállítása a release-blocker elkerülését
  jelenti.