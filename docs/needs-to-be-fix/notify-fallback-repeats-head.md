# notify: a chunk-onkenti fallback ugyanazt az elso 4096 karaktert kuldi ujra

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedest rogziti)

## Location

`src/notify.ts:19-28` -- `notifyChannel()` kuldo ciklusa

## Excerpt

```ts
for (const chunk of chunks) {
  try {
    const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
    await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, chunk, parseMode)
  } catch {
    try {
      await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, outbound.slice(0, 4096))
    } catch { /* last resort, give up */ }
  }
}
```

A fallback nem a bukott `chunk`-ot kuldi ujra formazas nelkul, hanem a TELJES
`outbound` uzenet elso 4096 karakteret -- es ezt a ciklus minden iteracioja
ujra megteszi.

## Failure scenario

Egy hosszu, tobb chunkra bomlo ertesites (pl. agent hibariport, HTML entitasokat
tartalmazo stack trace), ahol a formazott valtozat Telegram-oldali `parse_mode`
hibat kap (a `formatForTelegram` altal generalt tag valamelyik chunk hataran
kettevagodik -- ez a splitMessage klasszikus edge case-e):

1. `splitMessage` 3 chunkot ad: `chunk-1`, `chunk-2`, `chunk-3`.
2. Mindharom HTML-es kuldes 400 Bad Request-tel bukik.
3. A tulajdonos HAROM uzenetet kap, mindharom BETU SZERINT UGYANAZ: az
   `outbound` elso 4096 karaktere.
4. A 4096. karakter utani tartalom -- vagyis a `chunk-2` es `chunk-3` teljes
   szovege -- SOHA nem megy ki. Egy hibariportnal pont a vege (a valodi
   exception) veszik el.

Egy chunk bukasa eseten a viselkedes helyes; a defekt akkor jelentkezik, amikor
az uzenet tobb chunkra bomlik, ami pont a nagy riportoknal tortenik.

## Pinning test

`src/__tests__/notify.test.ts` -> `notifyChannel`:

- `re-sends the same first 4096 chars for every failing chunk, dropping the tail (pinned defect)`
  -- alairja, hogy 3 bukott chunkra 3 fallback kuldes tortenik, mindharom
  azonos szoveggel, es a `TAIL` marker (a 4096. karakter utan) egyikben sincs
  benne.

Fix utan a tesztnek azt kell allitania, hogy minden chunk a SAJAT nyers
tartalmat kapja vissza fallbackkent, es a tail is kimegy.

## Suggested direction

A fallback a bukott chunkra vonatkozzon, ne a teljes uzenetre:

```ts
} catch {
  try {
    await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, chunk)
  } catch { /* last resort, give up */ }
}
```

A `chunk` mar atment a `splitMessage`-en, tehat hosszra biztosan jo -- a
`slice(0, 4096)` ezzel feleslegesse valik (lasd meg
`notify-fallback-hardcodes-telegram-limit.md`). Az egyetlen kulonbseg, hogy a
chunk a formazott szoveget tartalmazza; ha a cel a formazas MEGKERULESE (ez a
fallback eredeti szandeka), akkor a nyers `outbound`-ot kell chunkolni
`provider.splitMessage(outbound)`-dal, es a formazott/nyers chunkokat parban
iteralni.

Nyitott dontes a tulajdonosnak: az egyszerubb `chunk`-fallback nem oldja meg a
"formazas a hibas" esetet (ugyanaz a HTML megy ki ujra), a parba allitott
verzio viszont osszetettebb. Javaslom a parba allitottat, mert a fallback
letezesenek egyetlen ertelme a formazas kikerulese.
