# kanban-dispatch: az owner-guard az egyetlen case-sensitive összehasonlítás

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/kanban-dispatch.ts:34` -- `resolveKanbanDispatchTarget()`

## Excerpt

```ts
const a = (assignee ?? '').trim()
if (!a) return null
const lower = a.toLowerCase()

// Human owner never triggers an agent.
if (a === opts.ownerName) return null          // <-- case-SENSITIVE

// Bot / main agent (matched by display name or canonical id) -> main session.
if (lower === opts.botName.toLowerCase() || lower === opts.mainAgentId.toLowerCase()) {
  return opts.mainAgentId                      // <-- case-insensitive
}

// Sub-agent: case-insensitive name match, dispatched only if it is running.
const match = opts.agentNames.find((n) => n.toLowerCase() === lower)   // <-- case-insensitive
```

A függvényben négy név-összehasonlítás van. Három lowercase-eli mindkét oldalt, az
owner-guard viszont nyers `===`. A modul fejléce ezzel szemben abszolút szabályként
fogalmaz: `the human owner (OWNER_NAME) -> null (humans never get a prompt)`.

## Failure scenario

Két előfeltétel kell, és mindkettő reális ebben a flottában:

1. Az assignee más casinggel érkezik, mint a konfigurált `OWNER_NAME`. A kártyát nem
   csak a dashboard írja: `src/web/routes/kanban.ts:70` maga instruálja az ágenseket,
   hogy `curl -d '{"assignee":"<név>"}'` hívással adják át a kártyát. Egy LLM által
   generált név casingje nem garantált. A web UI szintén végig case-insensitive-en
   kezeli az assignee-t (`web/app.js:814`, `web/app.js:1060`).
2. `OWNER_NAME` case-insensitive módon ütközik egy ágens-névvel vagy a `BOT_NAME`-mel.
   Az ágensnevek a `agents/` könyvtárnevek (`src/web/agent-config.ts:485`), tehát az
   operátor simán csinálhat magáról elnevezett személyes ágenst.

Ekkor a mis-cased owner-név **átcsúszik** a human-guardon, és lejjebb beletalál a
bot- vagy a sub-agent ágba:

| konfiguráció | assignee | eredmény |
|---|---|---|
| `OWNER_NAME=Gábor`, agent dir `gábor` (fut) | `Gábor` | `null` (helyes) |
| `OWNER_NAME=Gábor`, agent dir `gábor` (fut) | `gábor` | `'gábor'` -- **dispatch** |
| `OWNER_NAME=GorcsevIvan`, `BOT_NAME=GorcsevIvan` | `GorcsevIvan` | `null` (helyes) |
| `OWNER_NAME=GorcsevIvan`, `BOT_NAME=GorcsevIvan` | `gorcsevivan` | `MAIN_AGENT_ID` -- **dispatch** |

Ugyanaz az ember, két casing, két különböző kimenet. A hívó (`fireKanbanDispatch`,
`src/web/routes/kanban.ts:81`) ilyenkor `createAgentMessage`-dzsel felébreszt egy
ágenst egy olyan kártyára, ami emberi döntésre vár, és `markKanbanCardDispatched`
miatt ez csendben, egyszer, visszavonhatatlanul történik meg.

**Súlyosság:** közepes. Ütközés nélkül a hibás ág is `null`-t ad vissza (ismeretlen
névként esik ki), tehát a hétköznapi konfigurációkban nem látszik. Ütközés esetén
viszont pont az a garancia sérül, amit a modul a fejlécében ígér.

## Kapcsolódó, ugyanitt: a konfigurált nevek nincsenek trimmelve

Az `assignee` trimmelve van, `opts.botName` / `opts.mainAgentId` / `opts.ownerName`
viszont nem. A `readEnvFile` (`src/env.ts:28`) trimmeli az értéket, de az idézőjeles
formát (`BOT_NAME="Marveen "`) a quote-stripping után paddinggel hagyja. Ilyenkor a
`GorcsevIvan` assignee **nem** találja el a main agentet, azaz a fő session soha nem
ébred fel a kártyára. Pinelve, de külön fix-et igényel.

## Pinning test

`src/__tests__/kanban-dispatch.test.ts`, `describe('resolveKanbanDispatchTarget -- owner guard casing (pinned defect)')`:

- `does not recognise the owner when the casing differs`
- `dispatches a HUMAN card to an agent when the owner name collides case-insensitively`
- `routes a mis-cased owner to the main session when OWNER_NAME equals BOT_NAME`

A trim-aszimmetriát a `does NOT trim the configured names -- a padded BOT_NAME stops matching`
teszt rögzíti.

Mindhárom teszt a JELENLEGI viselkedést állítja. Fix után ezeket meg kell fordítani
(`toBeNull()` lesz a várt érték minden owner-variánsra).

## Suggested direction

A guardot ugyanarra a normalizálásra kell hozni, mint a másik hármat, és a
konfigurált neveket is trimmelni:

```ts
const norm = (s: string): string => s.trim().toLowerCase()
const lower = norm(a)
if (lower === norm(opts.ownerName)) return null
if (lower === norm(opts.botName) || lower === norm(opts.mainAgentId)) return opts.mainAgentId
```

Figyelendő: az `ownerName` üres string is lehet (`OWNER_NAME_PLACEHOLDER` hiányában),
de az `if (!a) return null` korai kilépés miatt az üres owner nem tud minden kártyát
elnyelni -- ezt a `an empty ownerName cannot swallow an assignee` teszt őrzi, és fix
után is zöldnek kell maradnia.

Nyitott döntés a tulajdonosnak: ha `OWNER_NAME` ütközik egy ágensnévvel, az owner-guard
nyerjen (jelenlegi szándék, exact casingnél így is működik), vagy inkább induljon
figyelmeztetés a konfig-betöltéskor az ütközésről. Ezt nem döntöttem el helyetted.
