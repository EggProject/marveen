# google-api: refreshAccessToken nincs in-flight de-duplikálva

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/google-api.ts:108-142` -- `refreshAccessToken()`

## Excerpt

```ts
async function refreshAccessToken(): Promise<string> {
  const tokens = loadTokens()
  const client = loadClientCredentials()

  const params = new URLSearchParams({...})

  const { status, data } = await httpsRequest(
    'https://oauth2.googleapis.com/token',
    {...},
    params.toString()
  )
  // ... parse + saveTokens(updated)
}
```

Nincs shared promise cache, nincs mutex, nincs in-flight tracker. Minden
hívó `await refreshAccessToken()` saját maga futtatja a teljes POST-ot +
JSON.parse-ot + saveTokens()-t.

## Failure scenario

Két konkurens `getCalendarEvents()` hívás, amikor a cached access token
már a lejárati ablakban van (vagy már lejárt):

1. Caller A: `getValidAccessToken()` -> `refreshAccessToken()` -> POST
   `oauth2.googleapis.com/token` (in-flight, ~200ms).
2. Caller B: ugyanott tart, közben elindítja a SAJÁT refresh kérését.
3. A szerver válaszol A-nak egy `access_token: X` tokennel.
4. saveTokens(A) kiírja a lemezre `access_token: X`-szel.
5. A szerver válaszol B-nek egy `access_token: Y` tokennel.
6. saveTokens(B) felülírja `access_token: Y`-nal. Az A által éppen
   használt bearer mostantól a Google szemében "ismeretlen korú",
   bármelyik events lekérés 401-et adhat vissza.

Két megjelenési forma:

- **Lemez-szintű lost-update:** a második save felülírja az elsőt.
  Következő `loadTokens()` a második refresh eredményét látja, de ha
  a kettő közti időben egy KÜLSŐ process (pl. a heartbeat worker) is
  hív `getCalendarEvents`-t, akár egy harmadik refresh is indulhat.
- **CPU-s burst terhelés:** minden egyes 5-perces ablakban, amikor a
  dashboard több komponense egyszerre fut le, N párhuzamos refresh
  request megy ki, noha egy is elég lenne. A Google rate-limitje
  (https://developers.google.com/identity/oauth2/web/devguides quota)
  gyorsabban elvérzik ezzel a mintával.

A teszt a JELENLEGI viselkedést rögzíti: `two independent refresh
requests fire when two callers hit the 5-min window concurrently` --
két refresh request, két save, felülírás.

## Pinning test

`src/__tests__/google-api.test.ts`, `describe('refreshAccessToken race
(pinned defect: no in-flight de-duplication)')`:

- `fires two independent refresh requests when two callers hit the 5-min window concurrently`

A teszt `Promise.all([getCalendarEvents('cal-1', ...), getCalendarEvents('cal-2', ...)])`
két, lejárt access_token állapotú hívással, és azt állítja, hogy pontosan
2 refresh request + 2 save hívás történik. Fix után a várható érték
1 refresh request + 1 save kell hogy legyen (a második caller a shared
promise-ről kapja az eredményt).

## Suggested direction

Egy egyszerű single-flight wrapper a `refreshAccessToken` köré, ami a
futás alatt lévő Promise-öt eltárolja egy module-scoped változóban:

```ts
let refreshInFlight: Promise<string> | null = null

async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = doRefresh().finally(() => { refreshInFlight = null })
  return refreshInFlight
}
```

Ez a Node.js event-loop modellben teljesen korrekt (a `let` assignment
a microtask előtt szinkronban fut, a többi awaiter ugyanazt a Promise-öt
kapja meg). A második és további hívók nem nyújtanak be plusz refresh
kérést a Google-nak.

További mérlegelendő: a `cachedTokens.mtimeMs !== currentMtime` check a
refresh közben is kioldhat, ha közben egy külső process átírja a fájlt.
Ez jelenleg is hatástalan (a write a mi saveTokens-ünk, nem a külső
auth subcommandé), de a shared-promise wrapper hozzáadása után érdemes
ellenőrizni, hogy a refresh promise visszatérési értéke (`access_token`)
nem inaktív a `Date.now() > tokens.expiry_date - 5 * 60 * 1000` check
szerint mire a második caller megkapja -- ha igen, ne használja fel,
hanem indítson saját refresh-et.
