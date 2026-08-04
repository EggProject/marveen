# profiles unvalidated id → path traversal out of PROFILES_DIR

## Location

`src/web/profiles.ts:42-49` — `loadProfileTemplate(id)`

## Excerpt

```ts
export function loadProfileTemplate(id: string): ProfileTemplate {
  const path = join(PROFILES_DIR, `${id}.json`)
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf-8')) as ProfileTemplate } catch { /* fall through */ }
  }
  if (id !== 'default') return loadProfileTemplate('default')
  return HARDCODED_DEFAULT_PROFILE
}
```

`id` is interpolated straight into `join(PROFILES_DIR, ...)` with no
validation — no basename reduction, no `..` rejection, no allowlist check
against the actual directory listing. `path.join` **normalizes** `..`
segments rather than rejecting them, so any `id` containing `../` resolves
outside `templates/profiles/`.

The sibling `listProfileTemplates()` enumerates the directory and is
therefore inherently confined; `loadProfileTemplate` is the only entry
point that accepts a caller-supplied name, and it is the unconfined one.

## Failure scenario

`loadProfileTemplate('../../outside')` resolves to
`<PROJECT_ROOT>/outside.json` — two levels above the profiles directory —
and returns its parsed contents as if it were a security profile.

Verified in this suite: with `{"id":"outside","label":"ESCAPED",...}`
planted at `<PROJECT_ROOT>/outside.json`, the call returns that object
(`.label === 'ESCAPED'`) instead of falling back to the default profile.

Reachability — `id` is attacker-controlled from the dashboard HTTP API in
two places, and the two differ in whether they are guarded:

1. **`POST /api/agents` (`src/web/routes/agents.ts:810-828`) — UNGUARDED:**

   ```ts
   const { ..., profile: rawProfile } = data as { ...; profile?: string }
   const profileId = (rawProfile || 'default').trim() || 'default'
   ...
   writeAgentSecurityProfile(name, profileId)
   writeAgentSettingsFromProfile(name, loadProfileTemplate(profileId))
   ```

   `rawProfile` is a raw JSON body field, only `.trim()`ed. There is no
   check that the resolved profile's `id` matches what was requested. The
   traversed file's contents flow directly into
   `writeAgentSettingsFromProfile`, which writes
   `profile.filesystem.allow` / `.deny` into the new agent's
   `.claude/settings.json` permissions block
   (`src/web/agent-scaffold.ts:342-352`).

2. **`PUT /api/agents/:name/security` (`agents.ts:1229-1236`) — partially
   guarded:**

   ```ts
   const profile = loadProfileTemplate(requested)
   if (profile.id !== requested) { json(res, { error: `Unknown profile: ${requested}` }, 400); return true }
   ```

   The post-hoc `profile.id !== requested` check rejects most traversals,
   but only *after* the out-of-directory read has already happened, and it
   still passes for a file whose `id` field literally equals the traversal
   string.

Two distinct impacts on path 1:

- **Arbitrary JSON read within reach of the process**, limited to files
  that parse as JSON. `../../store/config-overrides`, `../../package`, or
  any operator JSON under the checkout are reachable.
- **Security-profile bypass.** `permissionMode` and the `filesystem.deny`
  list are the sandbox definition for a scaffolded agent. Pointing the
  profile at an unrelated JSON file that happens to carry a `filesystem`
  object yields an agent provisioned with a deny list nobody authored. A
  file lacking `filesystem` instead throws a `TypeError` at
  `agent-scaffold.ts:342` mid-scaffold, after `scaffoldAgentDir` and
  `writeAgentSecurityProfile` have already run — leaving a half-created
  agent whose recorded profile id is the traversal string.

Note the dashboard API sits behind `src/web/auth-gate.ts`, so this is a
post-authentication defect, not an unauthenticated one. It still matters:
the security-profile mechanism exists specifically to constrain what an
agent may do, and this lets the constraint be sourced from an arbitrary
file.

## Pinning test

`src/__tests__/profiles.test.ts` → `describe('loadProfileTemplate')` →
`'PINS BUG: a traversing id reads a JSON file outside PROFILES_DIR'`

The test asserts the **actual** (buggy) behaviour so the suite stays
green. When the fix lands, flip it to expect the default-profile fallback.

## Suggested direction

Reject any `id` that is not a bare profile name before touching the
filesystem:

```ts
export function loadProfileTemplate(id: string): ProfileTemplate {
  if (!/^[a-z0-9-]+$/i.test(id)) {
    return id !== 'default' ? loadProfileTemplate('default') : HARDCODED_DEFAULT_PROFILE
  }
  const path = join(PROFILES_DIR, `${id}.json`)
  ...
}
```

The charset matches every shipped profile id (`default`, `applier`,
`developer-junior`, `developer-senior`, `marketer`, `researcher`,
`sub-dev`). An equivalent fix is to resolve the path and assert it still
starts with `PROFILES_DIR + sep`, but the allowlist regex is cheaper and
has no symlink edge cases.

Independently, `POST /api/agents` should adopt the same
`profile.id !== requested → 400` guard that
`PUT /api/agents/:name/security` already applies, so an unknown profile is
a request error rather than a silent fallback.
