# Cycle 24: `routes-background-tasks-delete-clobber`

## Context

A `DELETE /api/background-tasks/:id` végpont a `src/web/routes/background-tasks.ts:200-210` blokkban minden futó és már terminális állapotú taskot egyaránt `finishBackgroundTask(id, 'failed', '(cancelled)')` hívással ír felül. A `status === 'running'` guard csak a `killSession` hívást védi, az `UPDATE`-et nem — így egy `done`/`failed` státuszú, kimenettel rendelkező taskot a felhasználó (vagy egy elavárt tab auto-retry-ja) a Cancel gombra kattintva "failed, '(cancelled)'" állapotba klobberolhatja, és az eredmény visszafordíthatatlanul elveszik.

A `docs/needs-to-be-fix/routes-background-tasks-delete-clobber.md` rögzíti a mintát, és van egy dedikált pinning teszt (`'does not kill a session for an already finished task'`, `src/__tests__/background-tasks-routes.test.ts:815-825`), ami ma a hibás viselkedést rögzíti (a `finishBackgroundTask` hívás megtörténtét állítja). A fix után ez a teszt a helyes viselkedést fogja állítani.

A cél: a DELETE handler rövidre zárása terminális státuszokon, így a kész output sértetlen marad, a Cancel gomb pedig idempotenssé válik.

## Approach

Egyetlen, feltételes korai visszatérés beszúrása a `taskMatch && method === 'DELETE'` ágba a `finishBackgroundTask` hívás elé. Ha a task már nem `running`, a handler a `killSession`-t sem hívja (az már guarded), és a `finishBackgroundTask`-ot sem. A 200-as válasz `ok: true` marad, opcionálisan `already: <status>` mezővel, ami jelzi a kliensnek, hogy a törlés no-op volt.

A MD javasolt fixét követjük minimális formában:

```ts
if (taskMatch && method === 'DELETE') {
  const task = getBackgroundTask(taskMatch[1])
  if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }
  if (task.status !== 'running') { json(res, { ok: true, already: task.status }); return true }
  const output = task.tmux_session ? captureSession(task.tmux_session) : null
  if (task.tmux_session) {
    killSession(task.tmux_session)
  }
  finishBackgroundTask(task.id, 'failed', output?.trim() || '(cancelled)')
  json(res, { ok: true })
  return true
}
```

A `status === 'running && task.tmux_session` guard a `killSession` előtt redundáns `task.status !== 'running'` korai visszatérés után, tehát egyszerűsödik `task.tmux_session`-re.

## Critical files

- `src/web/routes/background-tasks.ts` (1 sor beszúrás a 203. sor után, +1 egyszerűsítés a 204. soron → `+2/-2` nettó)
- `src/__tests__/background-tasks-routes.test.ts` (`'does not kill a session for an already finished task'` teszt frissítése a 822-824. sorokon: a `finishBackgroundTask` hívásról szóló assertion átfordítása → `+1/-2`; opcionális `already` assertion a `json()` payload-ra)
- `docs/needs-to-be-fix/INDEX.md` (a `routes-background-tasks-delete-clobber` sor "Resolved" státuszra frissítése `2026-08-17 <SHA>` formátumban)

## Reuse

- A `json(res, ...)` segéd és a meglévő 404/200 szerkezet változatlan marad.
- A `getBackgroundTask` és `finishBackgroundTask` mock-ok (`src/__tests__/background-tasks-routes.test.ts`) és a `mkTask` helper újrafelhasználva.
- A `task.status` típus szinten már szűkített (`'running' | 'done' | 'failed' | 'timeout'` a `BackgroundTask` rekordban), nincs szükség typeguard bevezetésére.

## Verification

1. `bun --bun vitest run src/__tests__/background-tasks-routes.test.ts` — a korábbi 4 DELETE teszt + az átírt `'does not kill a session for an already finished task'` + egy új `'returns already=<status> for a done task'` mind zöld.
2. `bun --bun vitest run` — teljes suite (`11114+` teszt, 0 új failure).
3. `bunx tsc --noEmit | wc -l` — a baseline-tal azonos (2255), 0 új TS hiba.
4. Working tree clean marad a két commit után (`fix` + `docs` SHA update).
5. A `git status` és `git rev-list --left-right --count origin/test/baseline...test/baseline` a kiindulási 3 ahead / 0 behind állapothoz képest 5 ahead / 0 behind-re nő (két új commit). Push a useré.

## Workflow & review

A végrehajtás a `Workflow` tool-lal történik, 3 fázisban:

1. **Implement** — fix commit (`fix(routes-background-tasks): skip DELETE on terminal states (closes routes-background-tasks-delete-clobber)`)
2. **Verify** — tesztek futtatása, lefedettség ellenőrzése
3. **Docs** — `docs/needs-to-be-fix/INDEX.md` frissítése a `Resolved: 2026-08-17 <SHA>` bejegyzéssel

A workflow a jelenlegi `test/baseline` branchből indul és oda tér vissza. Minden commit lokál marad (push a useré). A workflow után kötelező a `/code-review xhigh --fix` skill hívása, ami a `0defacb` mintára hozhat további follow-up commitokat (pl. `status === 'timeout'` leftarm guard, vagy `already` mező dokumentálása).
