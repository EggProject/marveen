# `acquireLock` spins forever when statSync throws but the lock file is still there

## Location
`src/remote-enroll-fs.ts`, `acquireLock()` at lines 116-118.

## Excerpt
```ts
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  try {
    const st = statSync(lockPath)
    if (Date.now() - st.mtimeMs > staleMs) {
      unlinkSync(lockPath)
      continue
    }
  } catch {
    // Lock vanished between open and stat; retry immediately.
    continue
  }
  await sleep(delayMs)
}
```

## Failure scenario
The "lock vanished" branch (line 116-118) is meant to handle the case where the lock file is removed between the failed `openSync` and the `statSync`. It catches the statSync throw and continues the loop without sleeping.

But the catch is UNCONDITIONAL: if statSync throws for ANY reason (EACCES, EIO, transient fs error, ...) and the lock file is still present, the loop will:
1. `openSync` fails with EEXIST (lock still there)
2. `statSync` throws (regardless of cause)
3. `continue` (no sleep, no unlink)
4. Loop forever until retries exhausted

The end result is that the caller waits `retries * delayMs` only to fail with "could not acquire". The lock is never released because the lock holder never crashed.

A recoverable fs error (e.g. transient EIO) is treated the same as a missing file. The retry loop never tries to unlink the lock, so it cannot recover.

## Pinning test
`src/__tests__/remote-enroll-fs-full.test.ts`, test `loops without sleeping when statSync throws on the contended lock`. The test pins the current behavior: statSync throws, sleep is never called, the function eventually rejects with "could not acquire". The test ASSERTS the reject rather than asserting recovery -- the bug is that recovery is impossible from this branch.

## Suggested direction
Distinguish "statSync throws because the file is gone" (ENOENT) from "statSync throws for another reason":

```ts
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    // Lock vanished between open and stat; retry immediately.
    continue
  }
  // Other stat errors (EACCES, EIO, ...) -- the lock IS still there
  // (statSync would have succeeded if it were gone). Don't spin;
  // behave like a fresh non-stale lock and wait.
  await sleep(delayMs)
}
```

Alternatively, the catch could attempt a defensive `unlinkSync` (best-effort, ignore ENOENT) before continuing, so a stale lock that fs can't stat gets removed anyway.
