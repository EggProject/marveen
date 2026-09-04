# Nem-Claude LLM providerek eltávolítása (DeepSeek + OpenRouter)

## Context

A kódbázis ma négy irányba tud agent-modellt indítani: Claude, DeepSeek, OpenRouter és Ollama. A nem-Claude ágak úgy működnek, hogy a launcher átírja az `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` env változókat a `claude` CLI előtt, és a bináris a harmadik fél Anthropic-kompatibilis endpointjával beszél.

A cél, hogy a projekt kizárólag Claude Code / Claude modellekre támaszkodjon. Két teljes provider-integráció megy ki (DeepSeek, OpenRouter), plusz egy holt script, ami OpenAI-nak és Gemininek küldi ki a teljes git diffet.

**Kutatás eredménye — mit találtunk és mi marad:**

| Provider | Státusz | Indoklás |
|---|---|---|
| Anthropic / Claude | **MARAD** | A teljes runtime magja |
| Ollama | **MARAD, érintetlenül** | Az agent-dispatch ág is; emellett a `src/db.ts:2431` embedding hívás a memória vektorkeresés motorja |
| DeepSeek | **MEGY** | Dispatch ág, vault kulcs, model picker, setup prompt, UI, tesztek |
| OpenRouter | **MEGY** | Teljes `openrouter-models.ts` modul, 3 HTTP route, dispatch ág, UI modal, 661 soros tesztfájl |
| OpenAI + Gemini | **MEGY** (csak `scripts/pre-pr-review.sh`) | Holt script, semmi nem hívja; `src/`-ben nulla előfordulás |
| Azure/Teams, Graph mail | marad | Üzenetküldés és levelezés, nem LLM |
| CostOps ChatGPT sor, MCP ElevenLabs/Fal.ai | marad | Kézi költségkövetés, illetve TTS/képgenerálás, nem LLM provider |
| openai-whisper, Piper/HuggingFace hangok, Perplexity Bumblebee | marad | Helyi STT/TTS csomagok és supply-chain scanner, nem API integráció |
| Bedrock, Vertex, Groq, Together, Cohere, xAI, Mistral, Fireworks, Replicate, LiteLLM, LMStudio, vLLM, Kimi, Zhipu | nincs teendő | Nulla találat a kódbázisban |

**Elavult konfig kezelése:** ha egy meglévő `agent-config.json` még `deepseek-*`, `provider/model` vagy `openrouter-auto:*` értéket tart, a launcher **megtagadja az indítást** érthető hibaüzenettel. Nem írja felül a felhasználó konfigját, és nem is engedi bele az Ollama ágba, ahol félrevezető 404 lenne a vég.

---

## Implementáció

Commitonként egy logikai lépés, mindegyik után a megadott verifikációval. A commitok lokálisak, push nincs.

### 1. `chore(setup): remove DeepSeek API key prompt`
- `scripts/setup.ts` L149-164: a DeepSeek kulcs prompt blokk törlése.
- **Verify:** `bun tsc --noEmit` hibaszám változatlan.

### 2. `chore(scripts): delete dead pre-pr-review.sh cross-reviewer`
- `scripts/pre-pr-review.sh` törlése (OpenAI gpt-4o + Gemini 2.0 Flash curl hívások).
- `src/__tests__/port-chain-no-hardcode.test.ts` L63, L76: a két `'scripts/pre-pr-review.sh'` bejegyzés kivétele a listákból.
- **Verify:** `bun --bun vitest run src/__tests__/port-chain-no-hardcode.test.ts`

### 3. `refactor(agent-process): collapse dispatch to Claude/Ollama, reject stale provider ids`
`src/web/agent-process.ts`:
- L48: `resolveOpenRouterModel` import törlése.
- L1009: `const model = readAgentModel(name)` (nincs OpenRouter feloldás).
- L1010-1016: diszkriminátor összevonása `isClaude` / `isOllama = !isClaude`-ra; `isDeepseek` és `isOpenRouter` törlése.
- Új guard közvetlenül a `model` beolvasása után: ha `model.startsWith('deepseek-')` vagy `model.includes('/')` vagy `model.startsWith('openrouter-auto:')`, akkor `logger.warn` plusz korai `return { ok: false, error: ... }`. A függvény szignatúrája (`agent-process.ts:910`) már ma is `{ ok: boolean; pid?: number; error?: string }`, tehát a dashboard hibaútja adott, nem kell új mechanizmus. A hibaüzenet nevezze meg a modellt és azt, hogy Claude vagy Ollama modellre kell átállítani.
- L1025-1030: `deepseekKey`, `deepseekEnv`, `openrouterKey`, `openrouterEnv` törlése. `ollamaEnv` (L1024) változatlan.
- L1186 komment: `(Ollama/DeepSeek/OpenRouter)` → `(Ollama)`.
- L1296 `cmd` template: `${deepseekEnv}` és `${openrouterEnv}` interpolációk kivétele. Template string marad, nincs `+` konkatenáció.
- **Verify:** `bun tsc --noEmit`. Az `agent-process.test.ts` DeepSeek/OpenRouter esetei itt még pirosak, a 6. commit rendezi.

### 4. `refactor(routes/agents): drop DeepSeek and OpenRouter from the model API`
`src/web/routes/agents.ts`:
- L14: `openrouter-models.js` import törlése.
- L546-600 `/api/models/available`: a payload `{ claude: [...] }`-re csökken. `hasDeepseek`, `hasOpenRouter`, `orCatalog` lokálisok és a `deepseek`, `deepseekConfigured`, `openrouter`, `openrouterManual`, `openrouterConfigured` mezők törlése. A Claude tömb változatlan. A L545-556 doc komment DeepSeek/OpenRouter bekezdése frissül.
- L604-643: a három `/api/openrouter/*` route (GET/POST manual, GET models) törlése.
- **Verify:** `bun tsc --noEmit`. Az `agents-routes.test.ts` itt pirosodik, a 7. commit rendezi.

### 5. `refactor(web): remove DeepSeek and OpenRouter UI`
- `web/app.js`: `loadDeepSeekModels()` (~L3873-3902), az OpenRouter optgroup feltöltés, a modal állapot és a `openOpenrouterModal` / `renderOpenrouterList` / close handler blokk (~L3956-4083) a négy event listenerrel, valamint a `deepseekConfigLink` listener (~L12167-12173). A `loadAvailableModels()` már csak a `claude` mezőt fogyasztja.
- `web/index.html`: `#openrouterModal` overlay blokk; a wizard `#agentModel` selectből `#agentModelDeepseekGroup` + a két OpenRouter optgroup; az edit `#editAgentModel` selectből `#deepseekModelGroup` + a két OpenRouter optgroup; `#openrouterBrowseBtn`; a `#deepseekHint` blokk (L2401-2403). **Az Ollama optgroup marad.**
- `web/lang/en.js` L1653-1655 és `web/lang/hu.js` L1655-1657: a három `agents.deepseek_hint_*` kulcs törlése.
- **Verify:** `bun run syntax-check` (`node --check web/app.js`).

### 6. `test(agent-process): cover the stale provider id refusal`
`src/__tests__/agent-process.test.ts`:
- L92, L186, L367, L1448: `resolveOpenRouterModel` harness bejegyzés, `vi.mock`, és a két mockImplementation törlése.
- L1527-1560: a DeepSeek és OpenRouter dispatch tesztek törlése.
- **Új tesztek** a 3. commit guardjára (projektszabály: minden javítás tesztet kap): `deepseek-v4-pro`, `deepseek/deepseek-chat-v3.1` és `openrouter-auto:tier1` esetén `startAgentProcess` `{ ok: false }`-t ad, a hibaüzenet tartalmazza a modell nevét, és tmux launch nem történik.
- Az Ollama teszt (`qwen3.6:27b`) változatlan marad, ez pinneli hogy az Ollama ág sértetlen.
- **Verify:** `bun --bun vitest run src/__tests__/agent-process.test.ts`

### 7. `test(agents-routes): drop OpenRouter route coverage`
`src/__tests__/agents-routes.test.ts`: a harness openrouter blokkja (~L145-150), a `vi.mock('../web/openrouter-models.js')` (~L393-400), a mockReset sorok (~L753-757), a `/api/models/available` tesztek átírása Claude-only payloadra (~L870-895), és a három `/api/openrouter/*` describe blokk törlése (~L898-973).
- **Verify:** `bun --bun vitest run src/__tests__/agents-routes.test.ts`

### 8. `refactor(web): delete openrouter-models module`
- `src/web/openrouter-models.ts` (174 sor) és `src/__tests__/openrouter-models.test.ts` (661 sor) törlése. A `OpenRouterTier`, `OpenRouterCatalog`, `OpenRouterModelInfo`, `CuratedModel` interfészek minden fogyasztója már megszűnt a 3-4. commitban.
- **Verify:** `bun tsc --noEmit`, `bun --bun vitest run`

### 9. `chore(model-profiles): replace deepseek example values with Claude ids`
A `src/model-profiles.ts` maga provider-agnosztikus (string leképezés), nem változik. Csak a konkrét model-id értékek:
- `config-examples/model-profile-map.example.json` L16-17: `deepseek-v4-pro` → `claude-haiku-4-5-20251001`.
- Ugyanez a csere a tesztfixture-ökben: `model-profiles.test.ts`, `model-profiles-wiring.test.ts`, `context-guard.test.ts:106`, `channel-poller-reap.test.ts:708`.
- **Verify:** a négy érintett tesztfájl futtatása.

### 10. `docs: remove OpenRouter references and stale as-built claims`
- `docs/needs-to-be-fix/openrouter-models-tier1-auto-empty-fallback.md` törlése (a dokumentált bug kódja megszűnt), és a rá mutató sor kivétele a `docs/needs-to-be-fix/baseline-unreachable.md` addenda táblából.
- `scripts/pre-modify-backup.sh` L11, L34: az `openrouter-ui` példa címke és az `openrouter-models.json` (plusz `openrouter-manual.json`, ha ott van) snapshot bejegyzés törlése.
- `docs/optimization/lean-optimization-phase-1-as-built.md` L181-203: a profil-térkép tábla átírása az új Claude id-kra.
- `.claude/plans/apply-openrouter-models-fix.js` törlése (a megszűnt modulhoz írt helper).
- **Verify:** a lenti záró gate.

---

## Verifikáció (a 10. commit után, ebben a sorrendben)

1. `git grep -nEi 'deepseek|openrouter' -- ':!node_modules' ':!coverage'` → üres.
2. `bun tsc --noEmit` → hibaszám a kiindulási állapothoz képest változatlan.
3. `bun run lint` → nincs új szabálysértés.
4. `bun run syntax-check` → exit 0.
5. Teszt suite. **Fontos, a projektszabály szerint:** futtatás előtt `ls store/` ellenőrzés; ha nem üres, tiszta worktree kell `$HOME` alatt (`git worktree add --detach $HOME/claw-test test/baseline` + `node_modules` symlink), **nem `/tmp/` alatt**, különben 19 hamis fail jön a `_TMP_PREFIXES` guard miatt.
6. Kézi füstteszt: dashboard megnyitása, agent wizard és edit panel model dropdown csak Claude (és az edit panelen Ollama) csoportot mutat; OpenRouter browse gomb nincs.
7. Regressziós ellenőrzés az Ollama ágra: a `qwen3.6:27b` teszt zöld, `src/db.ts` embedding útvonal érintetlen.

## Nem kerül hozzányúlásra

`src/agent.ts`, `src/model-fallback.ts`, `src/config-registry.ts` Claude valueSet, `src/web/model-suggest.ts`, OAuth/keychain alrendszer, `OLLAMA_URL` config, `src/db.ts` vektorkeresés, `src/web/routes/{connectors,memories,migrate}.ts` Ollama felület, `src/costops/config.ts`, `mcp-catalog.json`, `src/graph-mail.ts`, `src/channel-provider.ts`.

A vault `DEEPSEEK_API_KEY` és `openrouter-fleet-key` bejegyzések a felhasználó adatai; kód nem törli őket, inertté válnak. Ugyanígy a `store/openrouter-models.json` és `store/openrouter-manual.json` a lemezen marad, kézzel törölhető.
