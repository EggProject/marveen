# channel-poller-reap.ts: `isClaudeBinary`'s two `?? ''` fallbacks are unreachable defensive code

## Location

`src/web/channel-poller-reap.ts`, lines 267-268.

```ts
function isClaudeBinary(command: string): boolean {
  const argv0 = command.trim().split(/\s+/, 1)[0] ?? ''   // <-- line 267
  const base = argv0.split('/').pop() ?? ''               // <-- line 268
  return base === 'claude'
}
```

## Excerpt

Both `??` right-hand arms are required by `noUncheckedIndexedAccess` (which
types `array[0]` as `string | undefined`) and by `Array.prototype.pop`'s
`string | undefined` return type, but neither can fire at runtime:

1. `String.prototype.split(separator, 1)` always returns an array with at
   least one element. Even for the empty string, `''.split(/\s+/, 1)` is
   `['']`. So `[0]` is never `undefined` and `?? ''` never evaluates.
2. `argv0.split('/')` likewise always yields at least one element, so `pop()`
   on it never returns `undefined` and the second `?? ''` never evaluates.

The two fallbacks are therefore type-satisfying no-ops. They are the only
uncovered branches in the file.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A caller drives `findOrphanChannelClaudes` with every shape of `command`
   the real `ps -axww -o command=` output can produce: an absolute path
   (`/opt/homebrew/bin/claude ...`), a bare binary (`claude ...`), a
   non-claude argv0 whose tail merely mentions the claude command line (the
   tmux server row), a row with no `--channels`, and a row whose argv0 is the
   flag itself (`  --channels ...`).
2. `command.trim().split(/\s+/, 1)[0]` is a string in all five cases, so v8
   records the line 267 fallback as untaken.
3. `argv0.split('/').pop()` is a string in all five cases, so v8 records the
   line 268 fallback as untaken.
4. Branch coverage caps at 97.53% (79/81) while statements, lines and
   functions all reach 100%.

Unlike `agent-process.ts`'s three dead arms (which have no test-side lever at
all), these two *are* reachable with a prototype patch, the same lever
`auto-restart-runner.test.ts:867` uses for its `Map.prototype.get` fallbacks.
That restores the 100% gate but tests nothing about the module.

## Pinning test

`src/__tests__/channel-poller-reap.test.ts`,
`describe('findOrphanChannelClaudes')` →
`"forces both `?? ''` fallbacks in isClaudeBinary by patching String.prototype.split"`.

It replaces `String.prototype.split` with a stub returning `[]` for the
duration of one synchronous `findOrphanChannelClaudes` call (restored in a
`finally`), which drives both fallbacks and asserts the row is skipped rather
than throwing. The reachable siblings are pinned by the neighbouring tests:

- `'never matches the tmux server even though its argv embeds the claude command'`
  (argv0 is `tmux`, path-qualified),
- `'matches a bare `claude` argv[0] with no directory component'`
  (single-element `split('/')`),
- `'ignores a bare `--channels` argv with no binary at argv[0]'`
  (argv0 is the flag).

If the fallbacks are removed, the prototype-patch test must be deleted with
them; the three sibling tests keep the real behaviour covered.

## Suggested direction

Make the invariant provable instead of papering over it, e.g.

```ts
function isClaudeBinary(command: string): boolean {
  // split always yields >= 1 element, so the first segment is a string.
  const [argv0 = ''] = command.trim().split(/\s+/, 1)
  return argv0.slice(argv0.lastIndexOf('/') + 1) === 'claude'
}
```

`lastIndexOf` + `slice` removes the `pop()` fallback outright (no
`string | undefined` anywhere), and the destructuring default at least keeps
the remaining one in a single readable place. Alternatively keep the code as
is and accept a documented 97.53% branch ceiling for this file — but then the
repo-wide `perFile: 100` threshold in `vitest.config.ts` needs an explicit
exception, which is worse than the one-line rewrite.
