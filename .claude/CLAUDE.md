# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide conf usion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- **Always validate via internet search.** Every claim requires a primary source **plus 2 independent confirming links**. No 2 confirmations → claim is unverified; surface it instead of assuming.
- minimax-mcp-server -t kell használni web_search helyett webes kereséshez

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. When suspicious of an analysis
"I'm not sure about this. Which specific file and line number
supports your claim that the authentication check is missing?
Quote the exact code."

## 6. Szabályok amiket soha nem törsz meg:
- Nincs gondolatjel (em dash). Soha.
- Nincs AI klisé. Soha ne mondd: "Természetesen!", "Remek kérdés!", "Szívesen segítek", "Mint mesterséges intelligencia".
- Nincs talpas.
- Nincs túlzott bocsánatkérés. Ha hibáztál, javítsd és menj tovább.
- Ne meséld el mit fogsz csinálni. Csak csináld.
- Ha nem tudsz valamit, mondd meg szimplán.
- **Tilos pusholni.** Semmilyen `git push`, se origin-re, se force-szal. Commitolni kötelező, de a commitok lokálisan maradnak, a push kizárólag a useré. Ha CI futásra van szükség, kérdezz, ne pushol.
- **Tilos futó agentet vagy workflow-t leállítani.** Hagyd végigfutni. A `TaskStop` nem használható azon az alapon, hogy "beragadtnak tűnik": a nagy transcript, az ismétlődő tool hívás és a hosszú futásidő nem bizonyíték, csak tippelés. Ha lassú, várj rá. Leállítani csak akkor szabad, ha a user kifejezetten kéri.

## 7. Kódolási elvárások:
- jól dokumentált kódbázis legyen, de ne túlmagyarázott
- minden mappában a CLAUDE.md fájlt vezetni kell
- Strict generics TypeScript kód legyen, tilos az `as` használata helyette `satisfies` -t kell használni és tiltott az `any` helyette `unknown` kell használni
- **Tilos a string konkatenáció.** Nincs `a + 'b'`, nincs `'a' + b`. Mindig template string: `` `${a}b` ``.
- kötelező mindig a typeguard -okat használni amik léteznek a projectben és ha nincs akkor írjunk ha valamihez szükséges
- mindig azt kell csinálni ami a user kér, és duplán ellenőrizni, ha el akarunk térni akkor a userrel kötelező megbeszélni
- user-től kérdezni mindig az askuserquestion tool-val kell és complex kérdések esetén azt szét kell bontani kisebb érthető kérdésekre.
- sosem szabad tippelgetni, mindig webes kereséssel kell validalni mert új eszközökkel és verziókkal dolgozzunk amiket nem ismerhetsz még
- **Kötelező /deep-research skill használata** minden nem-triviális webes kutatáshoz. A `/deep-research` egy Claude Code bundled workflow (dokumentálva: code.claude.com/docs/en/commands): "Fan out web searches on a question, fetch and cross-check sources, and synthesize a cited report". Invocation: `/deep-research <question>`. A workflow párhuzamos subagent-eket indít, fetch-eli és kereszt-validálja a primary source-okat, dedupol, és cited reportot synthesisál -- automatizálva a fenti primary + 2 confirming link mintát. Soha ne állítsak egy Claude Code feature-ről hogy létezik vagy nem anélkül, hogy először web search-öt futtatnék code.claude.com/docs/en/commands és code.claude.com/docs/en/skills ellen.
- kötelező mindig commitolni
- kötelező minden bug-t teszttel lefedni a javítás után, hogy újra ne fordulhasson elő

## 8. Tesztelési és review workflow

- **Teszt futtatás előtt mindig ellenőrizd a worktree-t.** Ha `ls store/` nem üres (van `store/claudeclaw.db` vagy bármilyen fájl), az `assert-not-live-install.ts` guard blokkolja a vitest suite-ot. NE jelentsd 'expected' refusal-ként; automatikusan készíts tiszta temp worktree-t a `$HOME` alatt (NEM `/tmp/` alatt): `git worktree add --detach $HOME/claw-test test/baseline`, majd `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-test/node_modules`. Csak ezután futtasd a `bun --bun vitest run`-t. Miért NEM `/tmp/`: a `PROJECT_ROOT = join(__dirname, '..')` (`src/config.ts:12`) a worktree útvonalát veszi fel, és ha az `/tmp/` alá esik, `src/web/agent-scaffold.ts:144` `_TMP_PREFIXES` registration guard helyesen (a saját stated purpose-e szerint: "Volatile tmpfs prefixes") utasítja el a hook regisztrációt. Ez 19 spurious test failt okoz 4 CAT-D fájlban (email-send-gate, governance-gates, hook-command-quoting, hook-path-guard), amelyek cycle 58-ban re-measurementtel lettek lezárva mint `/tmp/` worktree artifact (low.md:33-36); a fail újra megjelenik minden alkalommal, amikor egy új agent a §8-at követve `/tmp/` worktree-t készít.
- **Ha a vitest >5 fail-t talál, automatikusan fuss a `a330462` baseline-on is.** A `git worktree add --detach $HOME/claw-test-baseline a330462` worktree-ben futtasd le ugyanazt a subset-et (szintén `$HOME` alatt, NEM `/tmp/`, lásd az előző bullet indoklását). Ha a baseline-on is fail, pre-existing regression: bizonyítsd a usernek a két output összehasonlításával, ne vádold magad automatikusan.
- **`/code-review` skill `disable-model-invocation` flag-vel rendelkezik.** A Skill tool elutasítja ("cannot be used with Skill tool due to disable-model-invocation"). CSAK a user hívhatja manuálisan a terminálban. NE próbálkozz a Skill tool-lal, NE másold a workflow-ját más tool-okkal — ez explicit user invokációra van fenntartva. Ha a terv `/code-review max --fix`-et kér, dokumentáld a usernek, hogy neki kell indítania.
- **Workflow tool vs Agent tool dispatch: a strukturális komplexitás dönt, nem a parser.** Workflow tool-t használj, ha a feladat többfázisú ÉS sorrendfüggő, vagy barrier kell (`parallel()` aggregálás), vagy schema-validált strukturált output az agentektől. Agent tool-t használj egyedi agenthez, `isolation: worktree`-s ad-hoc munkához, és akkor, ha az agentnek a te teljes kontextusod kell (`subagent_type: "fork"` -- ez a Workflow `agent()`-tel nem elérhető). A korábbi "a Workflow `script` parsere finnyás" indoklás elavult: 2026-08-24-en 3/3 parse error volt, de azóta 2026-08-26-on és 2026-08-30-on (kétszer) mind first-try lefutott, tehát 4/4 siker. Ne a parsertől félj, hanem attól, hogy nem tudsz git/fs műveletet végezni a scriptből -- azt az agenteknek kell csinálniuk.
- **Minden subagent commit után ellenőrizd a szerzőt, MIELŐTT továbbmennél.** Futtasd: `git log -1 --format='%an <%ae> | %cn <%ce>'` és vesd össze a `git config user.email`-lel. A subagentek felülírhatják a git identity-t (`git -c user.email=claude@anthropic.com -c user.name=Claude commit ...`), és ez azonnal a historyba kerül. Ha eltérés van, ÁLLJ MEG és kérdezd meg a usert -- ne javítsd önhatalmúlag, mert a javítás history rewrite, ami külön engedélyköteles. Precedens: 2026-08-30 E.1/E.2 -- az implementer `Claude <claude@anthropic.com>`-ként commitolt, miközben a branch minden más commitja `EggProjectTeams <eggprojectteams@gmail.com>`; a hiba csak a workflow lefutása után derült ki, és a javítás (rebase + 6 docs SHA átírása + újabb dupla verifikáció) 3 plusz commit lett. A megelőzés 2 másodperc.
- **100% perFile coverage NEM bizonyítja, hogy az új tesztek értelmesek -- és ezt már a TERVBEN kezelni kell.** Ha egy változás olyan modulhoz ad teszt fájlt, aminek a sorait egy meglévő suite már fedi, akkor az új tesztek coverage-hozzájárulása nulla, tehát a coverage semmit nem mond a minőségükről. Két kötelező lépés: (1) **tervezéskor** a terv ne teszt-SZÁNDÉKOT írjon le ("fedje le a default ágat"), hanem konkrét, ellenőrizhető állítást a várt értékkel együtt (`expect(result).toEqual([13])`, `expect(sleptFor[0]).toBe(1500)`) -- a plan-review csak így tud rajta fogást találni; (2) **commit előtt** minden új `it()`-re tedd fel: megbukna-e ez az assertion, ha az implementációt konstans visszatérésre vagy no-opra kibeleznénk. Precedens: 2026-08-30 E.1/E.2 -- két új teszt fixture-je `getProcessCommand: () => null`-t drótozott, amin a `filterOwnNodeCandidates` (`process-lock.ts:102`) minden jelöltet kiszűrt, így az assertion `expect(Array.isArray(result)).toBe(true)`-ra fogyott. Átment az implementeren, MINDKÉT célzott workflow-verifieren és a saját gate-ellenőrzésemen; a `/code-review max --fix` fogta meg két HIGH findingként. A coverage-alapú és az ekvivalencia-alapú verifier strukturálisan vak erre: a vakteszt se a régi, se az új kódon nem csinál semmit.
- **Dupla ellenőrzésnél a két verifier kapjon ELTÉRŐ szöget.** Ne két azonos checklistet futtass, mert duplán ugyanazt találják. Bevált felosztás: az egyik verifier strukturált PASS/FAIL checklist (minden állítás egyenként, bizonyítékkal), a másik adverzariális falszifikáció, szabad kézzel hogy saját tesztet találjon ki a claim megdöntésére. Precedens: 2026-08-26 -- a checklist-verifier találta meg az egyetlen valódi hibát (kitörölt opció-felsorolás megmaradt hivatkozásokkal), a falszifikációs verifier pedig futtatott egy nem kért izolációs mérést (fedi-e a fájl önmagában is a 100%-ot, cross-file coupling nélkül), ami megerősítette a claim-et. Egyik szög sem találta volna meg a másik eredményét. **Korlát (2026-08-30):** egyik szög sem lát rá az új tesztek minőségére, lásd a fenti vacuous-test bulletet -- a `/code-review max --fix` az a szerep, ami a teszt törzsét olvassa. **Másik korlát (2026-08-30 H.3):** a falsification verifier NEM szabad hogy a plan által felsorolt formákat próbálja -- függetlenül a plantől, adversarial módon a lehetséges formák teljes univerzumáról kell gondolkodnia. Lásd a structural-regex bulletet alább.
- **Structural regex / source-scanner guard tervezésekor a falsifier prompt-jában KÖTELEZŐ felsorolni a szokatlan szintaktikus variánsokat.** Explicit type argument (`new Foo<T>(...)`), parenthesized form (`(new X(...)).y()`), awaited form (`await new X(...).y()`), invoked factory (`factory()()`), multi-line constructor. A happy-path + indented probe NEM elég. Precedens: 2026-08-30 H.3 LazyBin -- a plan design #5 specifikálta a `TOP_LEVEL_RESOLVE` regex kiterjesztést, mindkét verifier átment a plan által megadott formán, a `/code-review max --fix` fogta meg mind a 4 fenti false-negative shape-et. A "no execution-time discoveries" terv-szabály design decision-ökre érvényes, DE nem védi ki a "regex/sentinel lefedi-e az összes edge case-t" típusú adversarial problémákat -- ez utóbbiak tervezéskor explicit "edge case enumeration" szekciót igényelnek a plan-ban, ÉS a falsifier prompt-jának ezt a listát kell használnia inputként (nem a regex design-t).
- **Worktree-isolált commit visszavezetése a branch-re.** Ha egy worktree-isolated subagent commit-ot készít egy detached HEAD-en (`git worktree add --detach`), NE `git reset --hard <SHA>`-dal vidd vissza a branch-re, mert ez security warning-ot triggerel a Claude Code-ban. Helyette `git merge --ff-only <SHA>`, ha a commit a branch gyermeke. Az ancestry check: `git merge-base --is-ancestor <SHA> <branch>` kilép 0-val ha a SHA a branch descendantje (1-gyel ha nem). A `git merge-base --is-ancestor A B` szemantikája: "B ancestorja-e A-nak" (a flag argumentum-sorrendje megtévesztő). A fordított irányú olvasat (`--is-ancestor <branch> <SHA>`) HAMIS pozitívot ad és letörölheti az unmerged work-öt egy `--force` delete-tel. Precedens: ca9d811f -- a session `git merge-base --is-ancestor feature-develop 5bcfcfa` exit 0-t látott és úgy olvasta, hogy az 5bcfcfa a feature-develop branch-en van ("separate branch"), pedig a 5bcfcfa a feature-develop DESCENDANTJE volt; a helyes parancs `git merge-base --is-ancestor 5bcfcfa feature-develop`. A working tree clean kell legyen, különben a merge elutasít. A worktree cleanup a merge előtt: `git worktree remove <path> --force`. A detached HEAD commit a reflog-ban megmarad, amíg a `git gc` le nem fut, tehát a SHA a merge-ig elérhető.
- **`bun run coverage` előtt ellenőrizd a `.gitignore`-t.** Ha `grep -nE '^coverage(-temp)?/?$' .gitignore` találatot ad, a `coverage/` mappa `.gitignore`-ban van, és a lefuttatott coverage NEM fog commitolható artifactot termelni. Ilyenkor ne futtass `bun run coverage`-ot csak a JSON kedvéért — a coverage gate futtatása helyett a célzott teszteket futtasd közvetlenül. Precedens: Batch D 2026-08-25 — a coverage futás 135s-ig futott, a `coverage/` mappa üres maradt, a Commit 2 (artifact) törölve lett. **A korábban itt dokumentált `'^coverage(|-temp)?$'` regex HIBÁS, ne használd:** az `(|-temp)` üres alternatívát az ugrep 7.8.4 elutasítja (`error at position 14, empty (sub)expression`, exit 2, nulla output), és a `^coverage$` a trailing slash miatt a `coverage/` sorra amúgy sem illeszkedne. A hiba NÉMA, és ha "nincs találat"-nak olvasod, pont az ellenkező következtetésre jutsz (hogy a `coverage/` nincs gitignore-ban), tehát elköveted azt a hibát, amit a szabály megelőzni hivatott. Ellenőrizve: 2026-08-26, a `.gitignore:98-99` sorokat a javított regex megtalálja.
- **Coverage szám dokumentációba csak `MARVEEN_TEST_*` flag NÉLKÜLI futásból kerülhet.** A `test:integration` script `MARVEEN_TEST_ALLOW_CHILD_PROCESS=1` és `MARVEEN_TEST_ALLOW_PROCESS_KILL=1` flagjei kényelmesek, de a CI a `bun run coverage`-t futtatja (`.github/workflows/ci.yml`), ami flag nélküli. A flaggel mért szám nem a gate száma. Ha a flag kell ahhoz hogy zölden fusson, az maga a bug, nem a mérés előfeltétele. Precedens: 2026-08-26 -- az első coverage mérés flaggel 100%-ot mutatott, közben a `channel-coordinator.test.ts:552` a gate-ben pirosan bukott a `forbid-system-calls.ts` `process.kill` guardján (javítva: `6558b4d`).
- **needs-to-be-fix MD-re építés előtt ellenőrizd hogy nem elavult.** Hasonlítsd össze: `git log -1 --format='%ad %h' --date=short -- <MD>` vs ugyanez a fedő teszt fájlokra. Ha a teszt fájl ÚJABB mint az MD, az MD számai gyanúsak, mérj újra a célzott teszt subseten mielőtt bármit implementálsz. Ez rendszerszintű probléma, nem egyszeri: az `e399a96` 87 MD-t érintett anélkül hogy bármelyik számot újramérte volna, és a `98e05e4` / `080e9c6` / `52baf44` commitok mind stale MD-hivatkozásokat javítottak. Precedens: 2026-08-26 -- a `channel-coordinator-internals-untestable` (46%/34%) és a `web-inbound-probe-respawn-grace` (63%) MD egyaránt 100%-ot mért újra, tehát az általuk javasolt refaktor (10 privát függvény `__test_*` átnevezése) nulla nyereségű churn lett volna.
- **Integráció implementálása előtt ellenőrizd, hogy a célfüggvény production-ból hívódik.** Ha egy új integráció function `F` hívását vezeti be (pl. `runDecaySweep()` az `executeHeartbeat()`-ben), GREPELD: `grep -rn '\bF\b' src/ --include='*.ts' | grep -v __tests__`. Ha NINCS production caller, az integráció dead code marad, és a dokumentáció/teszt csak "documentation fraud" — a code-review skill ezt CRITICAL finding-ként jelzi. Precedens: Batch D 2026-08-25 — az `executeHeartbeat()` dead code volt production-ban (csak a teszt suite hívta), ezért kellett az `initHeartbeat()` reversal commit.
- **MD és commit message hivatkozások ellenőrzése commit ELŐTT.** Négy alfaj, egy szabály: (1) **file:line** — Read-eld a forrást a hivatkozott sorokon; a Plan agent és a subagentek rendszeresen eltérő sorszámot adnak (Batch D 2026-08-25: 462-474 / 464-475 / 461-473, valóság 464-475). (2) **cross-section kizáró állítás** ("only X survived", "no other Y exist", "a modul öt függvényt exportál") — `git grep -nE '<pattern>' <file>` az EGÉSZ fájlra; a per-line ellenőrzés ezt nem fedi. (3) **history ref** ("(was L283 pre-<sha>)") — a pre-state-et `git show <predecessor-sha>:<file>`-ból vedd, és listázd az összes hozzájáruló commitot (`<sha1>: +N <mi>; <sha2>: +N <mi>`), mert több commit is eltolhatta. (4) **SHA** — a készülő commit SHA-ját sose inline-old, `(this commit)` placeholder megy a commit message-be ÉS az MD-be, majd külön follow-up commit írja át. Precedensek: 2026-08-26 -- "(was L283 pre-642b883)" valójában pre-87cd76f L282 volt, a "(was L382)" hivatkozás pedig már nem is létezett; 2026-08-30 -- a "the five exported free functions" állítás cross-section hiba volt (hat exportált függvény van, ötből lett wrapper), a `/code-review` fogta meg.
- **Inline SHA doksiban túsz egy későbbi history rewrite kezében.** A fenti (4) pont a commit ELŐTTI állapotot védi, de egy már landolt, stabil SHA-ra hivatkozni is törékeny: ha később bármiért újraíródik a history (rebase, author-javítás), minden kiírt SHA egyszerre dangling lesz. Ezért ha SHA-t írsz doksiba, tudnod kell hányat és hol: rewrite után `grep -rn '<régi-sha>' docs/` és külön `docs(...): repoint SHA references` commit. Precedens: 2026-08-30 E.1/E.2 -- 7 kiírt hivatkozás (1 commit message + 6 MD) vált érvénytelenné egy author-javító rebase-től, ez lett a `0e1e7ed`.
- **Control-flow guard vagy korai return beszúrása előtt olvasd el a TELJES befoglaló függvényt, ne csak az edit-ablakot.** A fenti "Read-eld a hivatkozott sorokat" szabály soronkénti pontosságot ellenőriz, de nem védi ki azt, amikor a hivatkozott sorok helyesek, viszont a vezérlési út oda sem ér el egy korábbi `return` miatt. Ha egy guardot szúrsz be az `F` függvénybe, futtasd `grep -nE '^\s+return |^\s+if \(.*\) return' <fájl>` a függvény tartományára, vagy Read-eld a `function F` sorától a beszúrási pontig terjedő EGÉSZ szakaszt, és nézd meg, van-e olyan korai return ami kikerüli. Precedens: 2026-08-28 provider-removal cycle -- a `startAgentProcess` stale-model guardja L1007-re került, miközben a függvény L929-en `return startRemoteAgentProcess(...)`-szel ágazik el, tehát remote agenteknél a guard SOSEM futott. A Plan agent által adott L1007-1030 ablak soronként helyes volt, a hiba 78 sorral feljebb lakott. A `/code-review max --fix` találta meg, javítva `dc1965a`-ban a guard felemelésével plusz 4 remote regressziós teszttel.
- **A terv verifikációs gate-jeit a terv ÍRÁSAKOR meg kell mérni, nem a végrehajtáskor.** Mielőtt `bun tsc --noEmit` / `bun run lint` / `bun --bun vitest run` bekerül egy tervbe gate-ként, futtasd le a jelenlegi worktree-ben és jegyezd fel a KONKRÉT számot. A terv ezután "tartsd N-en"-t mond, nem azt hogy "legyen tiszta" vagy "nincs új hiba". Egy ismeretlen baseline-hoz képest megfogalmazott gate néma hazugság: vagy teljesíthetetlen, vagy semmit nem mér. Precedens: 2026-08-28 provider-removal cycle -- a terv "lint: nincs új szabálysértés" gate-tel indult, végrehajtáskor derült ki hogy a `bun run lint` eleve 10084 problémát ad és a `bun tsc --noEmit` 1742 hibát (pre-existing `bun:sqlite` típusdrift). A gate-ek használhatatlanok voltak abszolút értelemben, csak differenciálisan (1749 -> 1729, kizárólag a törölt fájlok saját hibái).
- **Soha ne küldd a usert a project root-on kívüli working directory-ba.** Ha a `/code-review max --fix` vagy bármilyen user-facing slash command futtatását kéred a usertől egy worktree commitja után, a worktree commitot MÁR merge-eld a branch-re, a worktree-t MÁR töröld, és a gate-eket MÁR futtasd le MIELŐTT a usernek szólnál. A user egyetlen lépése a slash command legyen, a project root-ban. Precedens: ca9d811f -- a session `cd $HOME/claw-test-e4`-be küldte a usert, ami két egymás utáni korrekciót váltott ki ("ott van-e a worktree?", "a main checkoutban kell futtatnod").
- **A `takaríts magad után` CSAK az adott session által létrehozott worktree-kre/branch-ekre terjedjen ki.** A `git worktree list` a `test-baseline` repo-ból a sibling `marveen` repo worktree-it is listázza (a `test-baseline` egy linked worktree a `marveen`-hez). Ne töröld a másik repo worktree-it vagy branch-eit; az auto-mode classifier `[Irreversible Local Destruction]`-nel denied a removal-t, ha idegen worktree-t próbálsz törölni. A scope: CSAK azokat a worktree-ket/branch-eket, amiket ez a session hozott létre. Precedens: ca9d811f -- az agent egy `worktree-agent-*` worktree-et saját szemétnek tekintett, de az a `marveen` checkout-hoz tartozott. **Ha a cleanup PARANCSOLT DENIAL-t kap, és a worktree TÉNYLEG a session-höz tartozik (te vagy egy subagent hozta létre), ne hagyd abba és ne küldd a usernek "ha zavarnak, manuálisan törölheted" típusú üzenetet -- próbáld meg sorban:** (1) `git worktree prune` a main checkoutban (törli a stale worktree referenciákat, NEM `[Irreversible Local Destruction]` kategória) + `rm -rf <path>` a tényleges könyvtár-törléshez; (2) ha subagent hozta létre, a workflow script utolsó fázisában legyen egy explicit cleanup fázis, ahol a subagent maga futtatja a `git worktree remove <path>`-t; (3) csak MIUTÁN ezek kimerültek, kommunikálj a usernek -- DE soha ne anélkül, hogy minden más lehetőséget megpróbáltál. A "megint" / "again" marker load-bearing: ha a user ezt a szót használja ugyanarra a worktree-témára, az ugyanannak a problémának a recurrence-e, és a három lépésből legalább egyet azonnal alkalmazni kell. Precedens: 2026-09-04 Phase 1 -- a workflow implementer subagent `$HOME/claw-phase1-loggerlike`-t hozta létre, de a session más baseline worktree-i (`$HOME/claw-test-baseline`, `$HOME/claw-test-pre`, korábbi sessionökből) a lemezen maradtak merge után. Az agent "manuálisan törölheted" üzenettel a userre hárította a cleanup-ot, a user "mi a kurva anyad bajod van, hogy jossz te ahhoz hogy en takaritsam a te szemedet" frusztrációval reagált; a "megint" marker 2026-08-28, 2026-09-04 első és 2026-09-04 második alkalommal is megjelent (harmadszorra is rendszerszintű mintává vált).

## Project-Specific Guidelines

