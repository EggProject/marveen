# notify: a fallback a Telegram 4096-os limitjet hasznalja minden providernel

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedest rogziti)

## Location

`src/notify.ts:25` -- `notifyChannel()` fallback aga

## Excerpt

```ts
} catch {
  try {
    await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, outbound.slice(0, 4096))
  } catch { /* last resort, give up */ }
}
```

A `4096` be van drotozva, holott a provider-limitek a
`src/channel-provider.ts`-ben providerenkent elternek:

| provider   | limit  | forras                                    |
|------------|--------|-------------------------------------------|
| telegram   | 4096   | `src/format.ts:1` `MAX_MESSAGE_LENGTH`    |
| slack      | 4000   | `src/channel-provider.ts:112`             |
| discord    | 2000   | `src/channel-provider.ts:232`             |
| googlechat | 4096   | `src/channel-provider.ts:322`             |
| teams      | 28000  | `src/channel-provider.ts:362`             |

## Failure scenario

`CHANNEL_PROVIDER=discord` (limit 2000), az ertesites 3000 karakter:

1. Az elsodleges kuldes valamiert bukik (rate limit, atmeneti 5xx, formazasi
   hiba).
2. A fallback `outbound.slice(0, 4096)` = a teljes 3000 karakter.
3. A Discord API 400-zal elutasitja (`Must be 2000 or fewer in length`).
4. A kulso `catch` lenyeli. A tulajdonos SEMMIT nem kap, es a logban sincs nyom
   -- a fallback garantaltan bukik minden 2000-4096 karakter kozotti discord
   uzenetnel.

Slacknel ugyanez a sav 4000-4096 kozott, szukebb, de letezik. Teamsnel a
fordulopont: a fallback 28000 helyett 4096-nal vag, tehat feleslegesen csonkol.

A defekt csak akkor lathato, ha az elsodleges kuldes mar bukott -- vagyis pont
akkor, amikor a fallbacknek dolgoznia kellene.

## Pinning test

`src/__tests__/notify.test.ts` -> `notifyChannel`:

- `truncates the fallback at the telegram limit even on discord (pinned defect)`
  -- `CHANNEL_PROVIDER=discord`, 3000 karakteres uzenet, elsodleges kuldes
  bukik; a teszt allitja, hogy a fallback hivas 3000 karaktert kap (nem 2000-re
  vagva).

Fix utan a tesztnek azt kell allitania, hogy a fallback szoveg hossza a
provider sajat limitjet nem lepi tul.

## Suggested direction

A hardcode-olt `slice(0, 4096)` helyett a provider sajat `splitMessage`-e adja a
darabolast -- az mar ismeri a helyes limitet:

```ts
const fallbackChunks = provider.splitMessage(outbound)
await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, fallbackChunks[0])
```

Ez egyben megoldja a `notify-fallback-repeats-head.md`-ben leirt problemat is,
ha a fallback chunkok es a formazott chunkok parban iteralodnak.

Minimalis alternativa: a `ChannelProvider` interfeszre kerulon egy
`maxMessageLength: number` mezo, es `outbound.slice(0, provider.maxMessageLength)`.
Ez kevesebb valtozas, de uj mezot ad az interfeszhez, amit mind az 5 provider
implementalni kenyszerul.

Nyitott dontes a tulajdonosnak: a `splitMessage`-es verziot javaslom, mert nem
bovit interfeszt es a masik defektet is kezeli.
