# `writeAtomic` rename-failure cleanup is unreachable in the type system

## Location
`src/remote-enroll-fs.ts`, `writeAtomic()` at lines 200-206.

## Excerpt
```ts
try {
  renameSync(tmpPath, authPath)
} catch (err) {
  try {
    unlinkSync(tmpPath)
  } catch {
    /* ignore */
  }
  throw err
}
```

## Failure scenario
The cleanup path is meant to drop the tmp file when the rename fails (e.g. `authPath` is a non-empty directory, the destination filesystem is full, the user lacks permissions on the destination). The current code does this correctly -- but we cannot exercise the path through the public API alone because:

1. `authPath` is `<sshDir>/authorized_keys`. The `enrollAuthorizedKey` body reads `authPath` BEFORE calling `writeAtomic`. If `authPath` is a directory, `readFileSync(authPath, 'utf8')` throws EISDIR and the function rejects before `writeAtomic` runs.
2. Other OS-level conditions (read-only fs, ENOSPC) depend on the runtime environment and cannot be triggered deterministically.

The catch path is correct in isolation, but it has no integration test. A future change to the upstream code (e.g. moving the read back into `writeAtomic`, or skipping the read when the file is opaque) could break the invariant that the rename cleanup is the only path that leaves a tmp file behind.

## Pinning test
`src/__tests__/remote-enroll-fs-full.test.ts`, test `writeAtomic unlinks the tmp file and rethrows when renameSync fails`. The test mocks `node:fs`'s `renameSync` so the rename throws on the `.tmp -> authPath` pair, then asserts that:
- The call rejects with the underlying error.
- `authPath` is unchanged.
- No `.tmp` files remain in `sshDir`.
- The lockfile is released.

The mock is at the test-file level (vi.mock('node:fs')) so the existing tests in `remote-enroll-fs.test.ts` are unaffected. The test relies on the cleanup contract holding -- if the tmp file were NOT unlinked, the test would fail.

## Suggested direction
If the cleanup logic ever needs to evolve, the test pattern in this file is the canonical way to exercise it without touching the production environment. No code change is needed today; the pinning test is the only guarantee that the cleanup runs.
