# env: az updateEnvFile 0644-re rontja a .env jogosultsagat (secret-szivargas)

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

`src/env.ts:87` -- `updateEnvFile()` zaro sora, es a hivott
`src/web/atomic-write.ts:8-19` -- `atomicWriteFileSync()`

## Excerpt

`src/env.ts`:

```ts
  atomicWriteFileSync(envPath, out.join('\n'))   // <-- nincs { mode } opcio
```

`src/web/atomic-write.ts`:

```ts
export function atomicWriteFileSync(
  path: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, data)                       // uj inode, default umask -> 0644
  if (opts.mode !== undefined) {
    try { chmodSync(tmp, opts.mode) } catch { /* best-effort */ }
  }
  renameSync(tmp, path)                          // a regi inode (0600) eldobva
}
```

Az atomic write **uj inode-ot** hoz letre es azt nevezi at a helyere. Az eredeti
fajl jogosultsaga nem oroklodik: a tmp fajl a process umask-javal jon letre
(tipikusan 0644), es `mode` opcio hianyaban semmi nem allitja vissza a 0600-at.

Az `atomic-write.ts` fejleckommentje kifejezetten a titkokat tartalmazo
fajlokra ajanlja magat ("dashboard-token, agent CLAUDE.md / SOUL.md, telegram
env + access.json") -- a `mode` parameter pont ezert letezik. Az `env.ts` az
egyetlen hivo, amely titkot ir es NEM adja at.

## Failure scenario

A `.env` a telepito altal 0600-zal jon letre (ez a helyes allapot: a fajl
tartalmazza a `TELEGRAM_BOT_TOKEN`-t, az `ANTHROPIC_API_KEY`-t es a tobbi
channel-titkot).

1. Barmely fleet-import / identity takeover lefut, ami `updateEnvFile`-t hiv
   (`MAIN_AGENT_ID` + `CHANNEL_PROVIDER` mirror -- lasd `src/env.ts:42-49`).
2. A muvelet utan a `.env` modja **0644**.
3. Ettol kezdve a gepen minden lokalis felhasznalo -- minden nem-root service
   account, minden CI runner user, minden megosztott shell-hozzaferes --
   olvashatja a teljes titok-keszletet.

Semmi nem jelzi a valtozast: az `updateEnvFile` sikerrel ter vissza, a fajl
tartalma helyes, csak a jogosultsag romlott el. A kovetkezo `ls -l` -ig
eszrevetlen marad.

Ez **pontosan a 2026-07-27-i incidens hibaosztalya**, amit a
`src/__tests__/setup/assert-not-live-install.ts:5-6` fejlec dokumental:
"env.test.ts unlink+rewrote the live .env (mode 600 -> 644)". Akkor a teszt
okozta; itt maga a PRODUKCIOS kodut csinalja ugyanazt.

## Pinning test

`src/__tests__/env.test.ts` `updateEnvFile`:

- `PINNED BUG env-update-mode-downgrade: a 0600 .env 0644-re romlik`
  -- a teszt 0600-ra allitja a sandbox `.env`-et, meghivja az `updateEnvFile`-t,
  es allitja, hogy a mod utana `0644`.

A teszt jelenleg zold. Fix utan ELBUKIK -- ez a szandek: az uj elvaras az, hogy
a mod `0600` maradjon.

## Suggested direction

A minimalis fix az `src/env.ts:87`-en:

```ts
atomicWriteFileSync(envPath, out.join('\n'), { mode: 0o600 })
```

Ez viszont FELFELE is normalizal: egy szandekosan 0644-es `.env` (pl. konteneres
setup, ahol egy masik uid olvassa) hirtelen 0600 lesz. Ha ez gond, a helyes
megoldas a MEGLEVO mod megorzese: `statSync(envPath).mode & 0o777` kiolvasasa az
iras ELOTT, es azt atadni `mode`-kent; ha a fajl nem letezik, essen vissza
0600-ra (uj titkos fajlnak ez a helyes alapertek).

Erdemes megfontolni, hogy a mod-megorzes magaba az `atomicWriteFileSync`-be
kerüljon (pl. `preserveMode: true` opcio), mert ugyanez a csapda var minden
tovabbi hivora, aki titkot ir -- a fuggveny jelenlegi alapertelmezese
csendben biztonsagot ront.

Nyitott dontes a tulajdonosnak: a mod-megorzes vs. fix 0600 kozotti valasztas
telepitesi kornyezettol fugg. Javaslom a mod-megorzest 0600-as fallbackkel.
