# routes/ideas: a komment-endpoint nem ellenőrzi, hogy létezik-e az ötlet

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/web/routes/ideas.ts:135-144` -- `POST /api/ideas/:id/comments`

## Excerpt

```ts
if (commentsMatch && method === 'POST') {
  const ideaId = decodeURIComponent(commentsMatch[1])
  const body = await readBody(req)
  const { author, content } = JSON.parse(body.toString()) as { author?: string; content?: string }
  if (!content || typeof content !== 'string' || !content.trim()) {
    json(res, { error: 'content required' }, 400); return true
  }
  const comment = addIdeaComment(ideaId, author?.trim() || MAIN_AGENT_ID, content.trim())
  json(res, { ok: true, comment })
  return true
}
```

Nincs `getIdea(ideaId)` hívás. A modul minden más `:id`-s alútvonala előbb kikeresi az
ötletet és 404-gyel elszáll, ha nincs meg:

| Endpoint | Létezés-ellenőrzés | Hivatkozás |
| --- | --- | --- |
| `PUT /api/ideas/:id` | igen, 404 | `ideas.ts:105` |
| `POST /api/ideas/:id/promote` | igen, 404 | `ideas.ts:156` |
| `POST /api/ideas/:id/breakdown` | igen, 404 | `ideas.ts:181` |
| `POST /api/ideas/:id/promote-breakdown` | igen, 404 | `ideas.ts:197` |
| `POST /api/ideas/:id/revert` | igen, 404 | `ideas.ts:245` |
| `POST /api/ideas/:id/comments` | **nincs** | `ideas.ts:135` |

## Failure scenario

`addIdeaComment` (`src/db.ts:2664-2671`) két utasítást futtat:

```ts
db.prepare('INSERT INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?)')
  .run(ideaId, author, content, now)
db.prepare('UPDATE idea_box SET updated_at = ? WHERE id = ?').run(now, ideaId)
```

Az `INSERT` mindenképp lefut, az `UPDATE` nulla sort érint. Az `idea_comments` táblán
nincs FK-kényszer, tehát a sor bekerül egy nem létező `idea_id` alá és onnantól
elérhetetlen: a `GET /api/ideas` listában nincs szülő ötlet, amin megjelenhetne.

Konkrétan:

1. A felhasználó megnyitja az ötlet részleteit a dashboardon.
2. Egy másik kliens (vagy a saját másik füle) törli az ötletet -- `DELETE /api/ideas/:id`
   nem törli a hozzá tartozó kommenteket sem, ez ugyanennek a hiánynak a másik fele.
3. Az első fül elküldi a kommentet: **200 OK**, a UI kiteszi a buborékot, a sor
   viszont árván marad az adatbázisban.

Elgépelt vagy kézzel összerakott id-vel (`curl -d ... /api/ideas/typo/comments`) ugyanez
történik, csak nem is kell versenyhelyzet hozzá: a hívó azt hiszi, mentett, holott
semmi sem köti az adatot ötlethez.

**Súlyosság:** közepes. Nem korrumpál meglévő adatot, de csendes adatvesztés a
felhasználó szempontjából (a leírt komment eltűnik), és az `idea_comments` tábla
korlátlanul hízik olyan sorokkal, amiket semmi nem takarít.

## Pinning test

`src/__tests__/ideas-routes.test.ts`, `describe('pinned defects')`:

- `accepts a comment for an idea that does not exist`

A teszt a mai 200-as választ állítja. Fix után 404-re kell fordítani.

## Suggested direction

Ugyanaz a guard, mint a többi alútvonalon, közvetlenül a `content` validálás után
(hogy a rossz body továbbra is 400 legyen, ne 404):

```ts
if (!getIdea(ideaId)) { json(res, { error: 'Ötlet nem található' }, 404); return true }
```

Nyitott döntés a tulajdonosnak: a `GET .../comments` ág (`ideas.ts:130`) ugyanígy
ellenőrizetlen, de az ártalmatlan (üres tömböt ad vissza). Ha a 404 ott is kell,
az külön UI-változást igényel. A már bent lévő árva sorok takarítása és a
`DELETE /api/ideas/:id` kaszkádja (`src/db.ts:2642`) szintén külön feladat.
