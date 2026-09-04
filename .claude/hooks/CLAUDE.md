# Claude Code hooks

TypeScript hook scripts run directly by `node` (native `.ts` type stripping).
Verified on Node v22.23.2 (the `mise.toml` pin) and v26.5.0. No build step.
Registered in `.claude/settings.json`.

## Layout

```
.claude/hooks/
  common/          shared library, split by concern
  session-start/   SessionStart hook (entrypoint + core + tests)
  stop-guard/      Stop hook (entrypoint + core + tests)
```

## Files

- `common/typeguards.ts`: type guards shared across hooks: `isRecord`, `isString`,
  `isBoolean`, `isNumber`, `isSafeSessionId`, and `hasErrorCode` (narrows an
  unknown caught error to one carrying a string `code`, like Node's
  `ErrnoException`, so an `ENOENT` can be distinguished from a real read
  error without a cast).
- `common/hook-input.ts`: stdin JSON parsing (`readStdinJson`) and hook-input
  parsing (`HookInput<TEvent>`, `StopHookInput`, `SessionStartHookInput`,
  `parseHookInput`, `parseStopHookInput`, `parseSessionStartHookInput`).
- `common/transcript.ts`: `scanTranscript`, which streams a session transcript
  `.jsonl` and counts tool uses, `TaskCreate` calls, and the tool-use count at
  the most recent retrospective run (a `retrospective` skill invocation or a
  user-typed `/retrospective` slash command, `<command-name>` text on a
  `type:"user"` line). Only the main agent's own transcript is read, so only
  its tool uses are counted; subagent tool uses live in separate transcript
  files and are not counted here.
- `common/pending-sessions.ts`: `findUnprocessedSessions`, which scans a
  transcripts directory for finished sessions with work no retrospective
  covers (used by the SessionStart hook). "Pending-retrospective markers"
  below states when an existing marker file still leaves a session eligible.
  It also exports `SKIPPED_MARKER_SUFFIX` (`.skipped.md`), the suffix it
  matches decline markers by, and that export is for a reader outside this
  package: `scripts/agent-memory/store/retrospective.ts` spells the same
  suffix a second time, and a test there imports this constant to assert the
  two still agree. `.claude/retrospectives/README.md` says why there are two
  copies and which test fails when they diverge.
- `common/project-root.ts`: `PROJECT_ROOT` (this package's `common/` directory
  is three levels below the repo root), plus the derived `HOOK_STATE_DIR`
  (`.claude/hooks/.state`), `RETROSPECTIVES_DIR`
  (`.claude/retrospectives`), and `SHARED_MEMORY_DIR`
  (`.claude/shared-memory`). Entrypoints use these instead of computing their
  own `import.meta.dirname` math, so each entrypoint's path math does not need
  to change if it moves relative to the repo root as long as it stays under
  `common/`'s sibling directories.
- `common/*.test.ts`: `node:test` suites for the above, one file per module
  (`typeguards.test.ts`, `hook-input.test.ts`, `transcript.test.ts`,
  `pending-sessions.test.ts`).
- `session-start/core.ts` / `session-start/hook.ts`: SessionStart hook. The
  core module assembles the stdout message from only the parts that have
  content, in order: a line naming the current session's transcript path when
  known, a shared-memory section when the shared memory index has content,
  and a pending-retrospectives section when there are unprocessed finished
  sessions; when every part is empty it returns an empty string. It also
  holds the `RETRO_MIN_TOOL_USES`, `RETRO_IDLE_MS`, `RETRO_MAX_AGE_MS`,
  `RETRO_LIMIT` constants. The entrypoint always reads
  `common/project-root.ts`'s `SHARED_MEMORY_DIR` plus `MEMORY.md`, capped at
  200 lines or 25600 bytes, whichever comes first (see "Why the session
  rules block is gone" below); a missing index file is the normal state and
  is treated as no content, silently, while a real read error (distinguished
  from `ENOENT` with `common/typeguards.ts`'s `hasErrorCode`) is logged to
  stderr. This read does not depend on the hook input at all. Separately, the
  entrypoint reads stdin and, only when the hook input is present and its
  `transcript_path` is non-empty, derives a transcripts directory as
  `dirname(transcript_path)` and, only when the hook input's `source` is
  `startup` or `resume` (never `clear`, `compact`, or `fork`, so compaction
  never re-asks), scans it with `findUnprocessedSessions` for finished
  previous sessions with work no retrospective covers. The retrospectives
  directory is `common/project-root.ts`'s `RETROSPECTIVES_DIR`. Prints the
  assembled message to stdout only when it is non-empty (no stray blank
  line). Always exits 0; on any internal error it logs to stderr and exits 0
  without printing anything.
- `session-start/core.test.ts` / `session-start/hook.test.ts`: `node:test`
  suites for the core module and for the real entrypoint as a child process
  against fixture transcripts.
- `stop-guard/core.ts` / `stop-guard/hook.ts`: Stop hook. The core module
  holds the pure decision function `decideStopAction` and the
  `SessionGuardState` type (`{ readonly todoNudged: boolean }`). It only
  enforces the Todo-list rule; it does not nudge retrospectives (see the
  SessionStart section above for how those are offered). The entrypoint reads
  stdin, validates `session_id` against `isSafeSessionId` (rejecting anything
  that isn't `[A-Za-z0-9_-]{1,128}`, to keep it safe for use in a filesystem
  path; a mismatch logs to stderr and exits 0 without touching disk), loads
  per-session state, scans the transcript, calls `decideStopAction`, and on a
  block writes the reason to stderr with exit code 2 (which Claude Code shows
  to Claude as an instruction). The state directory is `common/project-root.ts`'s
  `HOOK_STATE_DIR`. Always tolerates internal errors by exiting 0.
- `stop-guard/core.test.ts` / `stop-guard/hook.test.ts`: `node:test` suites for
  the core module and for the real entrypoint as a child process against
  fixture transcripts.

## Why the session rules block is gone

The SessionStart hook used to print a fixed block of numbered project rules
on every session start. That was a documented anti-pattern: Claude Code
already loads `.claude/CLAUDE.md` and every `paths`-less `.claude/rules/*.md`
file at launch, at the same priority, without any hook involved, and
Anthropic's own SessionStart docs say "for static context that doesn't
require a script, use CLAUDE.md instead". The rules the block repeated are
already in context by the time the hook would run; printing them again was
pure duplication. The hook now injects only things a `.claude/CLAUDE.md` or
rule file cannot: the current transcript path, the shared memory index
content, and the pending-retrospectives scan result, all of which need code
to produce.

## Hook timeouts

Configured in `.claude/settings.json`: SessionStart runs with a 30 second
timeout (the pending-retrospective scan can read several transcript files),
Stop runs with a 20 second timeout.

## Thresholds

- `TODO_MIN_TOOL_USES = 8`: once total tool uses reach this and no
  `TaskCreate` call has happened yet, the Stop hook blocks once per session
  asking for a Todo list.
- `RETRO_MIN_TOOL_USES = 40`: a finished session needs at least this many
  tool uses before the SessionStart hook offers it for a retrospective.
- `RETRO_IDLE_MS = 30 minutes`: a session transcript modified more recently
  than this is treated as possibly still live and is never offered.
- `RETRO_MAX_AGE_MS = 14 days`: a session transcript older than this is no
  longer offered.
- `RETRO_LIMIT = 3`: at most this many pending sessions are listed at once
  (newest modified first).

## Per-session state

Stored at `.claude/hooks/.state/<session_id>.json` under the project
directory (`common/project-root.ts`'s `HOOK_STATE_DIR`, used by
`stop-guard/hook.ts`). Ignored by git. Corrupt or missing state files fall
back to defaults, never crash the hook. Session ids are validated before
being used in this path.

## Pending-retrospective markers

`findUnprocessedSessions` treats a session as having a marker when some file
name in `.claude/retrospectives/` starts with `<first 8 chars of session
id>.`, contains `-<first 8 chars of session id>.`, or ends with `-<first 8
chars of session id>`, which covers a finished retrospective file
(`<YYYY-MM-DD>-<id8>.md`), a declined-offer marker
(`<YYYY-MM-DD>-<id8>.skipped.md`), and a marker file named directly from the
id prefix with no date/dash prefix (e.g. `<id8>.skipped.md`). When multiple
marker files match, the newest mtime among them is used. Whether a matching
marker skips the session depends on its kind and its mtime:

- Any matching `.skipped.md` marker skips the session unconditionally,
  regardless of mtime or transcript content, since it means a prior offer of
  this exact session was declined. This check runs before `scanTranscript` is
  called, so a skipped session's transcript is never read (an unreadable
  transcript for a skipped session produces no error output).
- Otherwise, if the marker's mtime is at or after the transcript's own mtime,
  the session is skipped: the retrospective was produced after the session's
  last activity, so it is fully covered and the marker is out-of-band (for
  example written by a background retrospective agent spawned from a later
  session, which never touches the original transcript).
- Otherwise (the marker predates the transcript, so the session kept working
  after the marker was written, most commonly a manual `/retrospective` run
  followed by more work in the same session), the session is offered only
  when at least `RETRO_MIN_TOOL_USES` tool uses happened since the last
  retrospective run recorded in the transcript itself (0 when none is
  recorded there, so the full tool-use count counts as "since the marker").

A session with no marker is separately skipped when a retrospective already
ran near the end of its own transcript (fewer than `RETRO_MIN_TOOL_USES` tool
uses since that run).

Declining an offered session relies entirely on Claude writing the
`.skipped.md` marker file as instructed in the SessionStart message; the hook
itself keeps no state about a decline.

Known, accepted limitation: marker matching uses only the first 8 characters
of the session id, so two different sessions whose ids share the same first 8
characters would be treated as sharing a marker. This is not handled and is
not considered a bug to fix.

## Running tests and typecheck

From the workspace root:

```
pnpm claude:hooks:test
pnpm claude:hooks:typecheck
```

## Manual testing

SessionStart. The scan directory is `dirname(transcript_path)`, so a path
like `/x` makes the scan run against the filesystem root `/`; point
`transcript_path` into an empty temp directory instead (it does not need to
already exist) to keep the scan fast and side-effect free:

```
scratch="$(mktemp -d)"
echo '{"hook_event_name":"SessionStart","session_id":"t","transcript_path":"'"$scratch"'/t.jsonl","cwd":"'$PWD'","source":"startup"}' | node .claude/hooks/session-start/hook.ts
```

SessionStart against a fixture transcripts directory, to see the pending
section populate (replace the fixture path with a real one containing
qualifying `.jsonl` files):

```
fixtures="$(mktemp -d)"
echo '{"hook_event_name":"SessionStart","session_id":"manual-x","transcript_path":"'"$fixtures"'/manual-x.jsonl","cwd":"'$PWD'","source":"startup"}' | node .claude/hooks/session-start/hook.ts
```

Stop hook with a nonexistent transcript (expect exit 0, no output):

```
echo '{"session_id":"x","transcript_path":"/nonexistent","cwd":"'$PWD'","hook_event_name":"Stop","stop_hook_active":false}' | node .claude/hooks/stop-guard/hook.ts; echo "exit=$?"
```

Stop hook with `stop_hook_active: true` (expect exit 0 regardless of the
transcript):

```
echo '{"session_id":"x","transcript_path":"/nonexistent","cwd":"'$PWD'","hook_event_name":"Stop","stop_hook_active":true}' | node .claude/hooks/stop-guard/hook.ts; echo "exit=$?"
```

For a full Todo-nudge test, write a transcript file with 10 or more
`tool_use` blocks and no `TaskCreate`, then run the Stop hook against it with
a fresh `session_id`. First run exits 2 with the Todo reason on stderr and
writes `.claude/hooks/.state/<session_id>.json`; the second run with the same
`session_id` exits 0 because the nudge already happened. Delete the state
file afterward to reset.
