# config.ts: an empty `.env` line blanks the whole install identity

**Status:** RESOLVED (envOr empty-string guard routes identity constants, see commit `0df13db` on `test/baseline`). The narrative below is kept as a historical record of the bug, not as an open task.

## Location

`src/config.ts`, the `??`-defaulted identity constants:

- line 129 `export const OWNER_NAME = env['OWNER_NAME'] ?? OWNER_NAME_PLACEHOLDER`
- line 135 `export const BOT_NAME = env['BOT_NAME'] ?? 'Marveen'`
- line 143 `export const BRAND_NAME = env['BRAND_NAME'] ?? BOT_NAME`
- line 200 `export const MAIN_AGENT_ID = env['MAIN_AGENT_ID'] ?? 'marveen'`
- line 209 `export const SERVICE_ID = env['SERVICE_ID'] ?? MAIN_AGENT_ID`

(the same shape applies to every other `env['X'] ?? default` in the file, e.g.
`WEB_HOST` line 255; the identity keys are the ones with real blast radius)

## Excerpt

`src/env.ts:37` stores an empty value verbatim -- there is no empty-string
filter:

```ts
const key = trimmed.slice(0, eqIdx).trim()
let value = trimmed.slice(eqIdx + 1).trim()   // "BRAND_NAME=" -> ""
...
result[key] = value                            // { BRAND_NAME: '' }
```

`??` is nullish-coalescing: `'' ?? 'Marveen'` is `''`, not `'Marveen'`. So a
present-but-empty line skips the default entirely.

The file itself documents the OPPOSITE intent, at `src/config.ts:146-149`:

```ts
// Pure resolution rule for BRAND_NAME, so the default (brandEnv unset =>
// botName) is provable without a live .env. ... Mirrors the
// `env['BRAND_NAME'] ?? BOT_NAME` above plus an empty-string guard (an empty
// .env line should not blank the brand).
export function resolveBrandName(brandEnv: string | undefined, botName: string): string {
  const b = (brandEnv ?? '').trim()
  return b || botName          // <- the guard the constant above lacks
}
```

`resolveBrandName` carries the guard. The constant it claims to mirror does
not. The two disagree on exactly the input the comment calls out.

## Failure scenario

Hand-edit `.env` (the documented way to configure this install) and leave a
key with no value -- e.g. commenting out a value, or a wizard/installer that
writes `BRAND_NAME=` when the operator presses Enter on an empty prompt:

```
BOT_NAME=
BRAND_NAME=
OWNER_NAME=
MAIN_AGENT_ID=
```

Observed (verified against `src/config.ts` at HEAD via
`CLAUDECLAW_ENV_DIR` sandbox):

| export | expected | actual |
|---|---|---|
| `BOT_NAME` | `'Marveen'` | `''` |
| `BRAND_NAME` | `'Marveen'` | `''` |
| `OWNER_NAME` | `'Owner'` | `''` |
| `MAIN_AGENT_ID` | `'marveen'` | `''` |
| `SERVICE_ID` | `'marveen'` | `''` |

Downstream consequences:

1. **Dashboard chrome renders blank.** `BRAND_NAME` drives the browser tab
   title, mobile topbar, sidebar and updates page. All become empty strings.

2. **Service unit names collapse.** `appServiceLabel('')` returns `'com..app'`
   and `systemdStatusUnits('')` returns `['-dashboard', '', 'claudeclaw']`.
   The launchd/systemd probe then targets a unit that cannot exist, so the
   status command reports a running dashboard as stopped, and the recovery
   path (`launchctl kickstart`) targets nothing.

3. **`MAIN_AGENT_ID` empty breaks DB/tmux routing.** It keys DB rows, tmux
   session names and API routing. An empty id is not a valid tmux session
   name.

4. **The `current*Name()` runtime guards cannot save it.** `currentBotName()`
   is `b || BOT_NAME` -- when `BOT_NAME` is itself `''`, the fallback is `''`
   too. The guard is a no-op precisely when it is needed.

5. **Federation scrub loses its discriminator.** `OWNER_NAME_PLACEHOLDER`
   exists so consumers can tell "a real configured name" from the generic
   word `'Owner'`. With `OWNER_NAME === ''` neither branch is meaningful.

Note this is NOT the same as an ABSENT key: an absent key is nullish and the
default fires correctly. Only the present-but-empty line is affected, which
is why it survived review -- every existing test sets either a real value or
no line at all.

## Pinning test

`src/__tests__/config.test.ts`:

- `.env-backed exports > BUG: an empty .env line blanks the identity instead of using the default`
  pins the current (defective) values, including `appServiceLabel('') === 'com..app'`,
  and asserts in the same test that `resolveBrandName('', 'Marveen') === 'Marveen'`
  -- so the divergence between the helper and the constant is locked in one place.

The test is written to FAIL the moment the bug is fixed, which is intended:
whoever applies the fix updates that one test and deletes this file.

## Suggested direction

Replace nullish-coalescing with an empty-string-tolerant read for the
identity keys. The rule already exists in the file (`resolveBrandName`), so
the cheapest fix is to generalise it into one helper and route the constants
through it:

```ts
// .env semantics: a present-but-empty line means "unset", not "blank".
function envOr(key: string, fallback: string): string {
  return (env[key] ?? '').trim() || fallback
}

export const OWNER_NAME = envOr('OWNER_NAME', OWNER_NAME_PLACEHOLDER)
export const BOT_NAME = envOr('BOT_NAME', 'Marveen')
export const BRAND_NAME = envOr('BRAND_NAME', BOT_NAME)
export const MAIN_AGENT_ID = envOr('MAIN_AGENT_ID', 'marveen')
export const SERVICE_ID = envOr('SERVICE_ID', MAIN_AGENT_ID)
```

Open decision for the fixer (do NOT guess -- confirm with the maintainer):

- **Scope.** Apply `envOr` to the identity keys only, or to every `env['X'] ??`
  in the file? The numeric ones (`WEB_PORT`, `KANBAN_*`) currently turn an
  empty line into `parseInt('', 10) === NaN`, which is a related but distinct
  defect with its own blast radius. Recommend fixing identity keys in this
  change and filing the numeric ones separately.
- **Alternative placement.** Filtering empty values inside `readEnvFile`
  (`src/env.ts:37`) fixes every consumer at once, but silently changes the
  contract for every other caller of `readEnvFile` -- including
  `updateEnvFile` round-trips. Riskier; not recommended without an audit of
  all call sites.

Per task rule "NEVER modify src/config.ts", this file records the defect
only. No fix applied.
