# model-fallback-runner.ts: `writeMainModel` assumes `JSON.parse` returned an object

## Location

`src/web/model-fallback-runner.ts:56-61` (`writeMainModel`)

## Excerpt

```ts
function writeMainModel(model: string): void {
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(MAIN_SETTINGS_PATH, 'utf-8')) } catch {}
  cfg.model = model
  atomicWriteFileSync(MAIN_SETTINGS_PATH, JSON.stringify(cfg, null, 2))
}
```

The `try/catch` only guards a *parse failure*. `JSON.parse` succeeds on any
valid JSON document, including `null`, `123`, `"text"` and `[]` -- all of which
are assigned straight into `cfg`, whose declared type (`Record<string, unknown>`)
is then a lie.

The reader in the same file *does* guard exactly this case:

```ts
// src/web/model-fallback-runner.ts:50
return resolveModelId((cfg && typeof cfg.model === 'string' && cfg.model) || DEFAULT_MODEL)
//                     ^^^ null-guarded here, but not in the writer
```

So `readMainModel` anticipates a non-object body and `writeMainModel` does not.
That asymmetry is the defect.

## Failure scenario

`.claude/settings.json` holds a valid-JSON non-object body. Two distinct
outcomes, both leaving the main agent stuck on the exhausted model:

**(a) `null` / number / string body -> throws, swap is silently abandoned**

1. `.claude/settings.json` contains `null`.
2. The main pane shows a usage-limit banner; `readMainModel()` correctly
   returns `DEFAULT_MODEL` (its `cfg &&` guard fires), and `decideModelAction`
   returns `{ kind: 'downgrade' }`.
3. `writeModelFor` -> `writeMainModel` -> `cfg.model = model` throws
   `TypeError: Cannot set properties of null (setting 'model')`.
4. `checkAgent`'s `catch` (line 133) swallows it as
   `logger.warn(..., 'model-fallback: switch failed')`.
5. `restartFor` is never reached and `downgradedAt` is never set. The main
   agent stays on the limited model; every subsequent 60s sweep repeats the
   same warn. The feature is permanently inert for main.

Verified:

```
$ node -e 'let c={};try{c=JSON.parse("null")}catch{};c.model="x"'
TypeError: Cannot set properties of null (setting 'model')
```

**(b) array body -> no throw, model silently discarded, logged as success**

1. `.claude/settings.json` contains `[]`.
2. `cfg` becomes an array. `cfg.model = 'fallback-model'` assigns a *non-index*
   property, which `JSON.stringify` does not serialize for arrays.
3. `atomicWriteFileSync` writes back `[]` -- the model is gone.
4. Nothing throws, so `restartFor` runs, `downgradedAt.set(name, nowMs)` runs,
   and the runner logs `'model-fallback: switched model'`.
5. Main restarts, re-reads `settings.json`, finds no `model`, and comes back up
   on the *same* limited model. The runner now believes it is downgraded, so it
   will not retry -- and after the revert window it will "revert" a switch that
   never happened.

Verified:

```
$ node -e 'let c={};try{c=JSON.parse("[]")}catch{};c.model="fallback";console.log(JSON.stringify(c))'
[]
```

Variant (b) is the more serious of the two: a false success record with no
error anywhere in the logs.

## Pinning test

`src/__tests__/model-fallback-runner.test.ts`, describe block
`'main agent: non-object settings.json (see docs/needs-to-be-fix/model-fallback-runner-writemainmodel-nonobject.md)'`:

- `'aborts the switch when settings.json holds a JSON null body'` -- asserts the
  current behaviour: `logger.warn('model-fallback: switch failed')` with a
  `TypeError`, no `hardRestartMarveenChannels` call, file left as `null`.
- `'silently drops the model when settings.json holds an array body'` -- asserts
  the current behaviour: file rewritten as `[]`, yet a `'switched model'` info
  record was emitted and the restart ran.

Both tests pin what the code does *today*. When the bug is fixed they should be
inverted to assert the model actually lands.

## Suggested direction

Reuse the reader's guard in the writer -- one line, no new abstraction:

```ts
function writeMainModel(model: string): void {
  let cfg: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(MAIN_SETTINGS_PATH, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cfg = parsed satisfies object as Record<string, unknown>
    }
  } catch {}
  cfg.model = model
  atomicWriteFileSync(MAIN_SETTINGS_PATH, JSON.stringify(cfg, null, 2))
}
```

A malformed-but-parseable settings.json then gets replaced by a minimal
`{ "model": ... }`, matching what the existing `catch` already does for
unparseable content.

Not applied here: the task forbids modifying `src/web/model-fallback-runner.ts`.
