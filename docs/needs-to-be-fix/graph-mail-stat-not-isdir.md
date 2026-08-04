# graph-mail: a stat-successful / read-failing CREDS_PATH produces an opaque error

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/graph-mail.ts:105-119` -- `loadCredentials()`

## Excerpt

```ts
function loadCredentials(): MailCredentials {
  let currentMtime = 0
  try {
    currentMtime = statSync(CREDS_PATH).mtimeMs
  } catch {
    throw new Error(
      `graph-mail: credentials file not found at ${CREDS_PATH}. ` +
        `Set MARVEEN_MAIL_CREDS or create the file with TENANT_ID / CLIENT_ID / CLIENT_SECRET / MAILBOX.`,
    )
  }
  if (!cachedCreds || cachedCreds.mtimeMs !== currentMtime) {
    cachedCreds = { value: parseCredentials(readFileSync(CREDS_PATH, 'utf-8')), mtimeMs: currentMtime }
  }
  return cachedCreds.value
}
```

A `try/catch` csak a `statSync`-re van; a `readFileSync` nyersen hívódik.

## Failure scenario

A `MARVEEN_MAIL_CREDS` env var két élő úton is rá tud mutatni egy **létező, de nem
olvasható** útvonalra:

1. Az operátor elgépelte a path-t, és pont egy könyvtárra mutat. `statSync` sikerül
   (a könyvtár mtime-ját adja), de `readFileSync` `EISDIR` hibát dob. Az operátor
   ezt látja:
   ```
   Error: EISDIR: illegal operation on a directory, read '/srv/marveen/secrets'
   ```
   A modul kitalálta, hogy "credentials file not found" -- pedig nem. A hibaüzenet
   a javítás irányába sem mutat.
2. A fájl jogosultsága `mode 000` vagy `mode 600` egy másik user alatt. `statSync`
   sikerül (a stat-olás csak `x` a könyvtárra), `readFileSync` `EACCES`-t dob.
   Ugyanaz a hibaosztály, másik konkrét hibakód.

Mindkét esetben a rejtett kulcs (AADSTS client secret) nem szivárog ki -- a
modul nem logolja a body-t -- de az operátornak fogalma sincs, hogy
`MARVEEN_MAIL_CREDS` rossz útvonalra mutat-e, vagy a fájlformátum romlott-e el.

## Pinning test

`src/__tests__/graph-mail.test.ts` `loadCredentials + getToken (cache, mtime, errors)`:

- `throws an opaque EISDIR when CREDS_PATH points at a directory (pinned defect)`
  -- a teszt azt állítja, hogy a `statSync` sikerül, és a `readFileSync` `EISDIR`
  hibája **buborékolik fel** a credentials-hiány hibaüzenete nélkül.

Jelenlegi szándék szerint a teszt zöld; fix után a hibaüzenetnek tartalmaznia
kell a "credentials file" szöveget és a `CREDS_PATH` útvonalat, hogy az operátor
tudja, hol keresse a problémát.

## Suggested direction

A `readFileSync` hívást is try/catch-be venni, és a `statSync` catch-ével azonos
formátumú hibát dobni -- így az EISDIR / EACCES / ENOENT egyaránt a "credentials
file not readable at $path" üzenetet adja, és a logban azonnal látszik, hogy a
CREDS_PATH a ludas.

Alternatíva: a `statSync` után egy `accessSync(CREDS_PATH, R_OK)` ellenőrzés,
amely szintén `ENOENT` / `EACCES` hibát ad -- így a hibaüzenet konzisztens
marad, és a `readFileSync` try/catch-be csomagolása opcionálissá válik.

Nyitott döntés a tulajdonosnak: az env-var-os override (`MARVEEN_MAIL_CREDS`)
megléte mellett ez az edge case valószínűleg ritka, de a hibaüzenet most
félrevezető, és a secrets-rotáció során az operátor perceket veszíthet a
debugolásra. Javaslom a fixet.
