# env: duplikalt kulcs eseten az updateEnvFile frissitese csendben elveszik

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/env.ts:68-80` -- `updateEnvFile()`, es a parja `src/env.ts:37` -- `readEnvFile()`

## Excerpt

```ts
const remaining = new Map(entries)
const lines = content.length > 0 ? content.split('\n') : []
const out = lines.map((line) => {
  ...
  const key = trimmed.slice(0, eqIdx).trim()
  if (!remaining.has(key)) return line
  const val = remaining.get(key)!
  remaining.delete(key)          // <-- az ELSO talalat utan kikerul a Map-bol
  return `${key}=${val}`
})
```

Az iro oldal az ELSO elofordulasnal `delete`-el, tehat a tobbi azonos kulcsu sort
mar `!remaining.has(key)` agon engedi at valtozatlanul.

Az olvaso oldal viszont a MASIK iranyba dont:

```ts
result[key] = value   // minden iteracioban feluli -- az UTOLSO elofordulas nyer
```

A ket fuggveny ellentetes elofordulast tekint mervadonak.

## Failure scenario

Egy `.env`, amelyben ugyanaz a kulcs ketszer szerepel -- ez nem elmeleti eset:
az `updateEnvFile` maga is elo tudja allitani, mert a hianyzo kulcsot a fajl
vegere fuzi (`src/env.ts:83-85`), miközben egy korabbi, mas
indentacioval/kommentblokkban levo sor mar tartalmazhatja ugyanazt a kulcsot.
Manualis szerkesztes (operator kezzel hozzair egy `MAIN_AGENT_ID=` sort a fajl
aljara, a fenti sort nem torli) ugyanide vezet.

Konkret lefutas `TOKEN=regi\nEGYEB=x\nTOKEN=regi\n` tartalommal:

1. `updateEnvFile({ TOKEN: 'UJ' })` lefut, hibat nem dob.
2. A fajl igy nez ki: `TOKEN=UJ\nEGYEB=x\nTOKEN=regi\n` -- az elso sor frissult.
3. `readEnvFile().TOKEN` viszont **`'regi'`** -- az utolso elofordulas nyer.

Az iras "sikeres" volt, a visszaolvasas megis a REGI erteket adja. Semmi nem
jelez hibat.

A gyakorlati kar a fleet-import identity takeover utjan a legsulyosabb (ez az
`updateEnvFile` deklaralt hivasi helye, `src/env.ts:42-49`): a dashboard a
`cfg()` lancon mar az UJ `MAIN_AGENT_ID`-t latja, a `scripts/channels.sh`
viszont a `.env`-bol olvas kozvetlenul -- es ha a shell-oldali parse szinten az
utolso elofordulast veszi (`cut -d= -f2-` + utolso ertek), akkor a channels
process a REGI identitassal indul. Pontosan az a szethangoltsag, aminek a
megelozesere az `updateEnvFile` kommentje szerint a fuggveny letezik.

## Pinning test

`src/__tests__/env.test.ts` `updateEnvFile`:

- `PINNED BUG env-update-duplicate-key-lost: csak az ELSO duplikalt kulcsot irja at`
  -- a teszt allitja, hogy a fajlban a masodik `TOKEN=regi` sor ottmarad, ES hogy
  a `readEnvFile()` a `'regi'` erteket adja vissza az iras utan.

A teszt jelenleg zold. Fix utan ELBUKIK -- ez a szandek: az uj elvaras az, hogy
`readEnvFile()['TOKEN'] === 'UJ'` legyen.

## Suggested direction

A ket fuggveny elofordulas-szemantikajat egysegesiteni kell. Ket ut:

1. **Az iro deduplikal (javasolt).** Az `updateEnvFile` ne `delete`-eljen az elso
   talalatnal: irja at az OSSZES azonos kulcsu sort, vagy tartsa meg az utolsot
   es ejtse a korabbi duplikatumokat. Igy a fajl a muvelet utan garantaltan
   duplikatum-mentes, es barmelyik parse-iranyu olvaso (dashboard, channels.sh)
   ugyanazt latja.
2. Az olvaso valtson elso-elofordulas szemantikara. Ezt NEM javaslom: a
   `.env` de facto konvencio (dotenv, docker compose, systemd EnvironmentFile)
   nem egyseges ebben, es a shell-oldali olvasokat nem tudjuk mind atirni.

Barmelyik utat valasztjuk, erdemes az `updateEnvFile`-t ugy modositani, hogy
duplikatum eszlelesekor legalabb egy warn szintu logot adjon -- a csendes
ertekvesztes a legdragabb resze ennek a hibanak.

Nyitott dontes a tulajdonosnak: az 1-es ut megvaltoztatja a fajl tartalmat
(sorokat ejt), ami egy kezzel karbantartott `.env`-nel meglepetes lehet.
