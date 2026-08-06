# channel-poller-reap.ts: `reapChannelOrphans` SIGKILLs the `bot.pid` pid without verifying it is still the poller

## Location

`src/web/channel-poller-reap.ts`, lines 76-88 (`readBotPid`) and 202-230
(`reapChannelOrphans`).

```ts
function readBotPid(chanDir: string): number | null {
  const path = join(chanDir, 'bot.pid')
  if (!existsSync(path)) return null
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10)
    return Number.isFinite(pid) && pid > 1 ? pid : null   // <-- only a range check
  } catch {
    return null
  }
}

// reapChannelOrphans
const fromBotPid = readBotPid(chanDir)
const fromEnvScan = listPollerPidsByStateDir(envVar, chanDir)
// ...
for (const pid of all) {
  try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
}
if (all.length > 0) {
  try { execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 }) } catch { /* ignore */ }
  for (const pid of all) {
    try { process.kill(pid, 0) /* probe */; process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
}
```

## Excerpt

The `fromEnvScan` half of the reaper is *identity-checked*: a pid only makes
the list if the live `ps eww -e` snapshot shows that process carrying
`<PROVIDER>_STATE_DIR=<chanDir>` in its environment. The `fromBotPid` half has
no identity check at all. `readBotPid` validates only that the file content
parses to a number `> 1`; `reapChannelOrphans` then SIGTERMs it, waits 300 ms,
and SIGKILLs whatever still answers `kill(pid, 0)`.

Nothing in this repository ever deletes `bot.pid` — it is written by the
channel plugin (`<chanDir>/bot.pid`) and left behind on every crash, every
`tmux kill-session`, and every reboot. So the file routinely outlives the
process it names, and the pid it names is then free to be reused by the OS
(macOS recycles pids after ~99998, and after a reboot the counter restarts
from a low value, which is exactly the range plugin pids fall in).

The module is aware of the principle it is violating: the sibling reaper for
detached claudes documents it explicitly —

```ts
// Identification is by tmux-pane attribution, NOT env/argv heuristics (cmdline
// alone cannot tell a live agent claude from a detached one -- see
// feedback_verify_session_before_kill)
```

— and `buildPollerEvidence` (same file) *does* cross-check `botPid` against the
`ps` snapshot before drawing any conclusion (`botPidAlive: botPid != null &&
byPid.has(botPid)`). Only the destructive path skips the check.

`src/channel-coordinator.ts:94-96` records that this hazard has already been
felt from the other side:

```ts
// The coordinator keeps its OWN state dir, separate from the plugin's
// ~/.claude/channels/telegram. Sharing it would let the plugin's orphan-PID
// watchdog SIGTERM our process (it kills "stale" pids in its bot.pid).
```

## Failure scenario

1. Agent `samu` runs; the telegram plugin writes
   `<agents/samu>/.claude/channels/telegram/bot.pid` = `8100`.
2. The host reboots (or the machine runs long enough for the pid counter to
   wrap). `bot.pid` still says `8100`; nothing cleans it up.
3. After the reboot, pid `8100` belongs to an unrelated process — a low pid is
   typical for system daemons and for whatever the user launched early in the
   session.
4. The dashboard starts `samu`. `startAgentProcess`
   (`src/web/agent-process.ts:991`) calls `reapChannelOrphans('telegram', dir)`
   before the spawn.
5. `listPollerPidsByStateDir` returns `[]` (no poller is running yet, so
   nothing carries `TELEGRAM_STATE_DIR=<chanDir>`), but `fromBotPid` is `8100`,
   so `all = [8100]`.
6. The reaper SIGTERMs `8100`, sleeps 300 ms, then SIGKILLs it. An unrelated
   process is killed, and the INFO log claims
   `channel-poller-reap: orphans killed` with `reaped: [8100]`.

The same hole makes the reaper's own retry unsafe in a milder way: the
`SIGTERM` → 300 ms → `SIGKILL` window is long enough for the pid to be reused
by a process spawned during the sweep, and the `kill(pid, 0)` probe cannot tell
the difference.

Severity is bounded by needing a stale `bot.pid` **and** pid reuse, which is
why this has not been observed as an incident; it is a silent
kill-the-wrong-process hazard, not a crash.

## Pinning test

`src/__tests__/channel-poller-reap.test.ts`,
`describe('reapChannelOrphans')` →
`'PINNING: SIGKILLs an uncorroborated bot.pid pid that the env scan does not see'`.

It seeds `bot.pid` = `9101` inside a tmpdir sandbox, scripts `ps eww -e` to
return **no** matching row, and asserts that `9101` is nevertheless SIGTERMed
and SIGKILLed. When the identity check is added, that test must fail (the
expected `reaped` becomes `[]`).

## Suggested direction

Do not signal a `bot.pid` pid that the live snapshot does not corroborate.
Both pieces already exist in this file; the reaper just has to use them:

```ts
const fromEnvScan = listPollerPidsByStateDir(envVar, chanDir)
const botPid = readBotPid(chanDir)
// Only trust bot.pid when the process it names is still a poller for THIS
// channel dir (or at least still the bun/node command we started).
const fromBotPid = botPid != null && fromEnvScan.includes(botPid) ? botPid : null
```

That is the strictest form and makes `bot.pid` redundant, which is arguably the
right conclusion — the env scan is a superset by construction. If `bot.pid`
must stay useful for pollers the env scan can miss (the case the header comment
worries about), verify the command instead, e.g. read the pid's row out of the
`ps` snapshot the module already collects (`snapshotProcs()`) and require
`command` to contain `bun`/`node` plus the plugin path before signalling.

Independently: the plugin's `bot.pid` should be treated as advisory and stamped
(pid + start time, as `ps -o lstart` reports it) so staleness is detectable at
all. A pid alone is not an identity.
