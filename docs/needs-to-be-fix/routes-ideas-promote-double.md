# routes/ideas: az újra-promotálás árván hagyja az első kanban kártyát

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/web/routes/ideas.ts:149-172` -- `POST /api/ideas/:id/promote`

## Excerpt

```ts
const idea = (getDb().prepare('SELECT * FROM idea_box WHERE id = ?').get(ideaId) as IdeaBoxRow | undefined)
if (!idea) { json(res, { error: 'Ötlet nem található' }, 404); return true }

const cardId = randomUUID().slice(0, 8)
// ... nincs semmilyen idea.status ellenőrzés ...
createKanbanCard({ id: cardId, /* ... */ })
logIdeaStatusChange(ideaId, idea.status, 'kanban', MAIN_AGENT_ID, `promote:${phase}`)
updateIdea(ideaId, { status: 'kanban', kanban_id: cardId })
```

Az egyetlen guard a létezés-ellenőrzés. Az ötlet aktuális státusza nem számít, pedig
a `revert` ág ugyanebben a fájlban (`ideas.ts:247`) pont ezt teszi meg:

```ts
if (idea.status !== 'kanban') { json(res, { error: 'Csak kanban státuszú ötlet vonható vissza' }, 400); return true }
```

A `promote-breakdown` ág (`ideas.ts:195`) ugyanígy védtelen.

## Failure scenario

Kiindulás: `idea-1` már promotálva van, `status='kanban'`, `kanban_id='kartya-A'`.

Egy második `POST /api/ideas/idea-1/promote` hívás -- dupla kattintás a dashboardon,
egy visszalépés utáni újraküldés, vagy két ágens ugyanarra az ötletre:

1. `createKanbanCard` létrehozza `kartya-B`-t.
2. `updateIdea` felülírja: `kanban_id='kartya-B'`.
3. `kartya-A` a boardon marad, de már semmi nem hivatkozik rá.

A `kanban_id` az egyetlen visszamutató kapocs. Ha elveszik, két dolog törik el:

* `revertIdeaFromKanban` (`src/db.ts:2704-2711`) a `kanban_id`-ra keres
  (`WHERE kanban_id = ? AND status = 'kanban'`). `kartya-A` törlésekor/archiválásakor
  már nem talál semmit, tehát az ötlet nem áll vissza `reviewed`-re.
* A `POST .../revert` ág csak `kanban_id`-t null-ozza, `kartya-B`-t hagyja állni.
  `kartya-A`-ról végképp nem tud.

Az audit napló is félrevezetőt ír: `logIdeaStatusChange(ideaId, 'kanban', 'kanban', ...)`,
azaz egy `kanban -> kanban` átmenet kerül a `idea_status_log`-ba, ami a UI
státusz-idővonalán értelmezhetetlen sor.

**Súlyosság:** közepes. Nem veszik el adat (mindkét kártya megvan), de a board
duplikált kártyákkal telik meg, és a kanban -> ötlet visszacsatolás némán elromlik
az érintett ötletre.

## Pinning test

`src/__tests__/ideas-routes.test.ts`, `describe('POST /api/ideas/:id/promote')`:

- `re-promotes an already-promoted idea and orphans the first card`

A teszt a mai 200-as választ és a `kanban -> kanban` naplósort állítja.

## Suggested direction

A `revert` guard tükörképe, közvetlenül a létezés-ellenőrzés után:

```ts
if (idea.status === 'kanban') {
  json(res, { error: 'Az ötlet már kanbanra került', kanban_id: idea.kanban_id }, 409)
  return true
}
```

Ugyanez kell a `promote-breakdown` ágra is (`ideas.ts:197` után).

Nyitott döntés a tulajdonosnak: a 409 helyett lehet idempotens válasz is
(`{ ok: true, kanban_id: idea.kanban_id }` új kártya nélkül) -- ez a dupla kattintást
jobban kezeli, viszont elrejti a szándékos újra-promotálást. Nem döntöttem el helyetted.
