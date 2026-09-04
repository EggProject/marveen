# Plan: 5 legkisebb needs-fix (#1–#5) a `test/baseline` branchen

## Context

A `docs/needs-to-be-fix/INDEX.md` 176 bejegyzéséből a felhasználó a **legkisebb módosítással és legkisebb bukási kockázattal** járó 5 itemet választotta, amelyek mind a `test/baseline` branchen (`HEAD = 0e1176d`) belül, önálló commitokként, pinning teszttel együtt kerülnek lezárásra.

A commit konvenció a repo-ból (`git log` alapján):
- **Fix commit**: `fix(<area>): <imperative change> (closes <symptom>)` — 3 file együtt: `src/...`, `src/__tests__/...test.ts`, `docs/needs-to-be-fix/INDEX.md`.
- **Doksi commit**: `docs(needs-to-be-fix): mark <id> resolved` — csak `INDEX.md` + a kapcsolódó `*.md` részletfájl.

Push tilos — minden commit lokálisan marad.

---

## Fix #1: `prompt-safety-origin-note-tab-strip`

**Súlyosság:** Low | **Módosítás:** 1 karakter + 2 teszt frissítés

### SUT
`src/prompt-safety.ts:98`
```diff
-    .replace(/[^a-zA-Z0-9 _.\-/]/g, '')
+    .replace(/[^a-zA-Z0-9\s_.\-/]/g, '')
```
A `\s` hozzáadása a karakterosztályhoz engedi, hogy tab, sortörés, NBSP stb. túljusson az első cserén, és a `/\s+/g → ' '` lépés collapsolja — a függvény docstringje ("collapse whitespace") szerint.

### Pinning teszt frissítés
`src/__tests__/prompt-safety.test.ts`
- **Sor 369**: `expect(sanitizeOriginNote('a    b\tc')).toBe('a bc')` → `'a b c'`
- **Sor 362**: `'a"b[c]d:e\nf'` → `'abcdef'` → `'ab d ef'` (a `\n` is collapse-olódik most). A `\"`, `[`, `]`, `:` továbbra is strippelődik, így a helyes új érték: `replace` egyesével ellenőrizve: `\"b[d]:f` → `bdf`, közben a `\n` helyén space lesz, és a `:` megy utána → a teljes input `a"b[c]d:e\nf` → első replace kiveszi `\"[]:\n` → `abcdef`, **utána** nincs mit összevonni → `'abcdef'`. Helyes: `'abcdef'` marad, mert a `\"`, `[`, `]`, `:` mind strippelődik, a maradék `abcdef` nem tartalmaz whitespace run-t.

  ⚠️ **Újracsomagolandó teszt**: a `\n` tesztet érdemes külön `it(...)` blokkra bontani, hogy az új viselkedést (`'a\nb' → 'a b'`) önmagában dokumentálja. A meglévő sort nem kell átírni — ugyanazt az eredményt adja.

- **Új tesztek** hozzáadása a `describe('sanitizeOriginNote')` blokkhoz:
  - `'a\nb' → 'a b'` (sortörés)
  - `'a\rb' → 'a b'` (kocsi vissza)
  - `'a b' → 'a b'` (NBSP)

### Commit
- 1 db `fix(prompt-safety): collapse whitespace runs incl. \t/\n/NBSP (closes origin-note-tab-strip)`
- 3 file: `src/prompt-safety.ts`, `src/__tests__/prompt-safety.test.ts`, `docs/needs-to-be-fix/INDEX.md`

### Verification
- `bun test src/__tests__/prompt-safety.test.ts` zöld
- `bun run lint` (ha van) nem romlik el

---

## Fix #2: `overview-routes-yesterday-timestamp-flake` (DOKSI-ONLY)

**Súlyosság:** Low | **Módosítás:** 0 sor kód, 2 sor INDEX.md

### Felfedezés
A teszt **már javítva van**:
- `src/__tests__/overview-routes.test.ts:541` már a `startTs - 1 * 60 * 60 * 1000` értéket használja.
- A `393b3b6` és a rákövetkező commitok már lezárták a flaket.

Az `INDEX.md` 83. sora (`overview-routes-yesterday-timestamp-flake` | `src/__tests__/overview-routes.test.ts:534` | ...) `Resolved` oszlopa még `—`. Ez az egyetlen, ami maradt.

### Commit
- 1 db `docs(needs-to-be-fix): mark overview-routes-yesterday-timestamp-flake resolved`
- 2 file: `docs/needs-to-be-fix/INDEX.md` (sor 83 `Resolved:` kitöltése a fix-commit SHA-val — a `393b3b6` SHA-t a `git log --all --oneline | grep overview` adja), `docs/needs-to-be-fix/overview-routes-yesterday-timestamp-flake.md` (a "Suggested direction" szekciót `Applied: <SHA>`-ra cserélni).

### Verification
- `git log --all --oneline | grep -i 'overview-routes-timestamp\|393b3b6'` megerősíti a javító commit SHA-t.
- A `git show <sha> --stat` mutatja, hogy a teszt valóban frissítve lett.

---

## Fix #3: `graph-mail-stat-not-isdir`

**Súlyosság:** Low | **Módosítás:** ~4 sor kód + 1 teszt frissítés

### SUT
`src/graph-mail.ts:115-117`
```diff
-  if (!cachedCreds || cachedCreds.mtimeMs !== currentMtime) {
-    cachedCreds = { value: parseCredentials(readFileSync(CREDS_PATH, 'utf-8')), mtimeMs: currentMtime }
-  }
+  if (!cachedCreds || cachedCreds.mtimeMs !== currentMtime) {
+    let raw: string
+    try {
+      raw = readFileSync(CREDS_PATH, 'utf-8')
+    } catch (err) {
+      throw new Error(
+        `graph-mail: credentials file not readable at ${CREDS_PATH} (${(err as NodeJS.ErrnoException).code ?? 'unknown'}). ` +
+          `Set MARVEEN_MAIL_CREDS or fix the file at that path.`,
+      )
+    }
+    cachedCreds = { value: parseCredentials(raw), mtimeMs: currentMtime }
+  }
```

A `statSync` catch-ével azonos formátumú hibaüzenet, plusz az eredeti `code` (EISDIR / EACCES / ENOENT) benne marad, hogy az operátor lássa a kiváltó okot is.

### Pinning teszt frissítés
`src/__tests__/graph-mail.test.ts:143`
```diff
-    await expect(listMessages()).rejects.toThrowError(/EISDIR/)
+    await expect(listMessages()).rejects.toThrowError(/credentials file not readable at .*EISDIR/)
```

### Commit
- 1 db `fix(graph-mail): surface EISDIR/EACCES as actionable credentials error (closes stat-not-isdir)`
- 3 file: `src/graph-mail.ts`, `src/__tests__/graph-mail.test.ts`, `docs/needs-to-be-fix/INDEX.md`

### Verification
- `bun test src/__tests__/graph-mail.test.ts` zöld
- A többi graph-mail teszt (cache + mtime + happy path) nem törik el, mert csak az új throw-ágat érinti a változás, a sikeres ágat nem.

---

## Fix #4: `routes-memories-nan-limit`

**Súlyosság:** Low/Medium | **Módosítás:** 3 sor kód + 2 új teszt

### SUT
`src/web/routes/memories.ts:72`
```diff
-    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
+    const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10)
+    const limit = Number.isFinite(rawLimit) && rawLimit >= 1
+      ? Math.min(rawLimit, 200)
+      : 50
```

Ez:
- `?limit=abc` → `NaN` → `Number.isFinite` false → default `50`
- `?limit=-1` → `-1` → `>= 1` false → default `50`
- `?limit=9999` → `9999` → `Math.min(9999, 200) = 200` ✓
- `?limit=7` → `7` → `Math.min(7, 200) = 7` ✓

### Új regressziós tesztek
`src/__tests__/memories-routes.test.ts`, a `describe('GET /api/memories')` blokkba (sor 412-től):
```ts
it('falls back to the default limit when the query value is not a positive integer', async () => {
  await call('GET', '/api/memories?limit=abc')
  expect(H.getMemoriesForChat).toHaveBeenCalledWith(H.ALLOWED_CHAT_ID, 50)
})

it('falls back to the default limit when the query value is negative', async () => {
  await call('GET', '/api/memories?limit=-1')
  expect(H.getMemoriesForChat).toHaveBeenCalledWith(H.ALLOWED_CHAT_ID, 50)
})
```

### Commit
- 1 db `fix(memories-route): clamp ?limit from both ends, NaN -> default (closes nan-limit)`
- 3 file: `src/web/routes/memories.ts`, `src/__tests__/memories-routes.test.ts`, `docs/needs-to-be-fix/INDEX.md`

### Verification
- `bun test src/__tests__/memories-routes.test.ts` zöld
- A meglévő `?limit=7` és `?limit=9999` tesztek továbbra is `7` / `200` értéket kapnak
- Nincs `Number.isFinite` / `>= 1` regression a többi call site-ban (a `limit` típusa `number` marad)

---

## Fix #5: `routes-ideas-title-validation`

**Súlyosság:** Low | **Módosítás:** ~5 sor kód (POST + PUT) + 2 teszt frissítés

### SUT
`src/web/routes/ideas.ts`

**POST handler (sor 51):**
```diff
-    if (!data.title) { json(res, { error: 'title required' }, 400); return true }
+    const title = typeof data.title === 'string' ? data.title.trim() : ''
+    if (!title) { json(res, { error: 'title required' }, 400); return true }
```
A sor 65-ös `createIdea({ id, title: data.title, ... })` hívásban a `data.title` → `title` (a trimmelt érték).

**PUT handler (sor 83-94 után, közvetlenül a `JSON.parse` típus-assert után):**
```diff
     const data = JSON.parse(body.toString()) as {
       title?: string
       ...
     }
+    if (data.title !== undefined) {
+      const trimmed = typeof data.title === 'string' ? data.title.trim() : ''
+      if (!trimmed) { json(res, { error: 'title required' }, 400); return true }
+      data.title = trimmed
+    }
```
A PUT-ban a `data` objektumot módosítjuk, mert `updateIdea(id, data)` később a `data.title`-t használja — így a tárolt érték is trimmelt lesz.

### Pinning teszt frissítés
`src/__tests__/ideas-routes.test.ts:1006-1016`
```diff
     it('creates an idea whose title is only whitespace', async () => {
       const r = await call('POST', '/api/ideas', JSON.stringify({ title: '   ' }))
-      expect(r.status).toBe(200)
-      expect(db.createIdea).toHaveBeenCalledWith(expect.objectContaining({ title: '   ' }))
+      expect(r.status).toBe(400)
+      expect(db.createIdea).not.toHaveBeenCalled()
     })

     it('creates an idea whose title is not a string', async () => {
       const r = await call('POST', '/api/ideas', JSON.stringify({ title: { hu: 'objektum' } }))
-      expect(r.status).toBe(200)
-      expect(db.createIdea).toHaveBeenCalledWith(expect.objectContaining({ title: { hu: 'objektum' } }))
+      expect(r.status).toBe(400)
+      expect(db.createIdea).not.toHaveBeenCalled()
     })
```

### Commit
- 1 db `fix(ideas-route): trim+typecheck title in POST and PUT (closes title-validation)`
- 3 file: `src/web/routes/ideas.ts`, `src/__tests__/ideas-routes.test.ts`, `docs/needs-to-be-fix/INDEX.md`

### Verification
- `bun test src/__tests__/ideas-routes.test.ts` zöld
- A többi POST / PUT ötlet-teszt (`pinned defects`-en kívül) nem törik el, mert a title-t trim-melés visszafelé kompatibilis (a nem-whitespace címek érintetlenül haladnak át)
- A comment endpoint (`ideas.ts:135-144`) mintája szó szerint követve van

---

## Végrehajtási sorrend és kritikus fájlok

A 5 commit sorrendje (legkisebb → legnagyobb kockázat):

1. **#2** (doksi-only, kód már javítva) — legkisebb, nincs kódváltozás
2. **#1** (1 karakter a regex-ben) — minimális felület
3. **#3** (4 sor új try/catch) — tiszta hozzáadás, meglévő ág nem érintett
4. **#4** (3 sor parse fix) — több call site-ot érint, de csak a query parse-t
5. **#5** (POST+PUT title guard) — típusellenőrzés + trim, több ág

### Kritikus fájlok (összesen)
| Fájl | Érintett fix |
|---|---|
| `src/prompt-safety.ts` | #1 |
| `src/__tests__/prompt-safety.test.ts` | #1 |
| `src/graph-mail.ts` | #3 |
| `src/__tests__/graph-mail.test.ts` | #3 |
| `src/web/routes/memories.ts` | #4 |
| `src/__tests__/memories-routes.test.ts` | #4 |
| `src/web/routes/ideas.ts` | #5 |
| `src/__tests__/ideas-routes.test.ts` | #5 |
| `docs/needs-to-be-fix/INDEX.md` | mind az 5 |
| `docs/needs-to-be-fix/overview-routes-yesterday-timestamp-flake.md` | #2 |

### Push politika
Nincs push. Mind az 5 commit lokálisan a `test/baseline` branchen marad. Push kizárólag a user kérésére.

## Végső verifikáció (a workflow utolsó lépése)

1. `git log --oneline test/baseline -7` — az 5 új commit megjelenik
2. `bun test src/__tests__/prompt-safety.test.ts src/__tests__/graph-mail.test.ts src/__tests__/memories-routes.test.ts src/__tests__/ideas-routes.test.ts src/__tests__/overview-routes.test.ts` — minden zöld
3. `grep -c 'Resolved: 2026-08-17\|Resolved: 2026-08-18' docs/needs-to-be-fix/INDEX.md` — 5 új `Resolved:` sor
4. `git status` — nincs nem-commit-olt módosítás
5. Push NEM történik
