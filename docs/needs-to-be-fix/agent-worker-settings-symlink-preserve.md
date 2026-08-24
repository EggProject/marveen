# agent-worker.ts: ensureWorkerCwd drops the shared settings.json content when the link is replaced

**Status:** RESOLVED (commits `e40c7f0` + `b70a1f7` on `test/baseline`). The initial commit `e40c7f0` applied the MD's option (a) verbatim with `readlinkSync` + `readFileSync`; `b70a1f7` then replaced `readlinkSync` with `realpathSync` after the relative-symlink failure (`../.claude/settings.json`) was observed. The regression test in `agent-worker-full.test.ts` was renamed and assertion-inverted in `e40c7f0`, a new relative-symlink case was added in `b70a1f7`, and the relative path was corrected to `../../.claude/settings.json` in `24bea87`. The fix reads the symlinked target via `realpathSync` BEFORE `rmSync`, so the shared `~/.claude/settings.json` content (Stop hooks, custom permissions, model field) is preserved. The narrative below is kept as a historical record.)

## Location

`src/web/agent-worker.ts`, lines 377-393 (the `settings.json` block in
`ensureWorkerCwd`).

```ts
const settingsPath = join(ctx.configDir, 'settings.json')
let current: WorkerSettings = {}
const sst = lstatSyncSafe(settingsPath)
if (sst?.isSymbolicLink()) {
  rmSync(settingsPath, { force: true })
} else if (existsSync(settingsPath)) {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as WorkerSettings
  } catch { /* rewrite */ }
}
...
writeFileSync(settingsPath, JSON.stringify({ ...current, enabledPlugins, skipDangerousModePermissionPrompt: true }, null, 2) + '\n')
```

## Excerpt

When the worker's `settings.json` was symlinked from the shared
`~/.claude/settings.json` (the per-entry symlink loop above puts it
there), the replacement branch:

1. Detects `sst.isSymbolicLink() === true`.
2. `rmSync(settingsPath, { force: true })` deletes the symlink **without
   reading its target's content**.
3. The `else if (existsSync(settingsPath))` branch is skipped because
   the file no longer exists.
4. `current` stays as `{}`.
5. The final `writeFileSync` writes an empty `current` spread, losing
   every hook / permission / model field the shared `settings.json`
   carried (e.g. `Stop: []`, custom `permissions`, etc.).

Consequence: a worker that needs a custom `Stop` hook (e.g. to wire
audit logging, send a heartbeat, etc.) loses it on every boot. The fix
is the obvious one -- read the linked file's content via `readlinkSync`
+ `readFileSync` before deleting, or `readFileSync` the path which
follows symlinks.

## Failure scenario

1. The shared `~/.claude/settings.json` has `{ "hooks": { "Stop": [] } }`
   (or any non-empty content).
2. `ensureWorkerCwd` runs for the first time on a fresh install.
3. The symlink loop points the worker's `settings.json` at the shared
   copy.
4. The settings.json block runs: it detects the symlink, deletes it,
   writes an owned file with no `hooks` key.

A test can reproduce it deterministically: write a non-empty
`settings.json` to the shared `~/.claude`, call `ensureWorkerCwd`, and
read back the worker's `settings.json` -- the `hooks` key is absent.

## Pinning test

`src/__tests__/agent-worker-full.test.ts`. The reachable siblings are
covered so the gap is exactly the symlink-preserve arm:

- `describe('ensureWorkerCwd')` -- "replaces a symlinked settings.json
  (the shared copy) with an owned file" asserts the CURRENT (buggy)
  behaviour: the symlink is replaced but the `hooks` content is dropped.
- "writes settings.json from scratch when none exists" covers the
  empty-input branch (success path).
- "removes a symlinked settings.json then writes an owned file" covers
  the `rmSync(settingsPath, { force: true })` arm on line 381 (covered
  by planting a symlink on the SECOND call to `ensureWorkerCwd`).

## Suggested direction

Two independent fixes; either is sufficient.

(a) Read the linked target's content BEFORE deleting the symlink:

    ```ts
    if (sst?.isSymbolicLink()) {
      try {
        const target = readlinkSync(settingsPath)
        const parsed = JSON.parse(readFileSync(target, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as WorkerSettings
      } catch { /* rewrite */ }
      rmSync(settingsPath, { force: true })
    } else if (existsSync(settingsPath)) { ... }
    ```

(b) Use `readFileSync` (which follows symlinks) before deciding the
    branch:

    ```ts
    if (existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as WorkerSettings
      } catch { /* rewrite */ }
      if (sst?.isSymbolicLink()) rmSync(settingsPath, { force: true })
    }
    ```

Option (a) is the more surgical change and matches the existing pattern
in the symlink loop.

Per task rule "NEVER modify src/web/agent-worker.ts" the source edits
are blocked until the user overrides; the test suite pins the current
behaviour and documents the direction.
