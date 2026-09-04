---
name: retrospective
description: >-
  End-of-session retrospective for the muhely workspace. Reads the session transcript and proposes,
  only when warranted, a new skill, a change to an existing skill, or a CLAUDE.md rule change.
  Use when the SessionStart hook lists a pending session, when a task series has been fully
  completed, when the user asks for a retro or "what did we learn", or at the end of a working
  session. Never applies changes itself.
argument-hint: "<absolute path to the session transcript .jsonl>"
context: fork
agent: instructions-opus
background: true
scope: dev
---

# Retrospective

## Input

`$ARGUMENTS` is the absolute path to the session transcript `.jsonl`. When you
mention it in the written file, use only its file name (`<id>.jsonl`); the
directory is machine-specific and must not be written into the repository.
If it is empty or the file does not exist, find the newest `*.jsonl` in the
directory of the transcript path the SessionStart hook printed, and say which
file you used. With no argument, that newest transcript is always the CURRENT
session, so this fallback is intended for the end-of-session manual run, not
for processing a pending previous session. A pending previous session must
always be passed explicitly by its transcript path; the SessionStart hook
prints the current session's own transcript path so the main agent can copy
it forward when invoking this skill for a different, previous session.

Never read the whole transcript into context at once. The file can be large.
Run the skill's own reader instead, from the repository root:

```bash
node packages/shared/.agents/skills/retrospective/scripts/read-transcript.ts \
  <transcript.jsonl>
```

One pass prints six listings, each capped at 150 items:

- the user prompts, numbered, system reminders stripped, 1200 characters each,
- the slash commands the user typed,
- the tool-use counts per tool name,
- the `Skill` invocations with their arguments,
- the failed tool results: the ones the harness flagged, plus the ones whose
  text opens a line with an error label (`Error:`, `FAIL`, `Failed`), reports
  a non-zero exit code, tallies `N failed`, or says a command was not found,
  each quoted around the match. Prose about failures is not listed, so a
  session that read its own tooling does not fill the section with itself,
- the bash commands that were run.

The noise is already filtered out: `<task-notification>` blocks,
slash-command stdout, interrupt markers, and the `isMeta` entries that carry
injected skill bodies. Read that output instead of grepping the transcript
yourself, and reach for `grep` only for something the reader does not print.
`jq` and `awk` line filters do **not** work here, because a single JSONL line
holds the entire multi-line notification blob.

Subagent transcripts for the session live in
`<transcript dir>/<session id>/subagents/*.jsonl`, alongside the matching
`.meta.json` file per subagent (the session id is the transcript filename
stem). The same reader takes a subagent `.jsonl`. Sample these only for
failed tool results and repeated command sequences, never in full, capped at
100 lines total across all subagent files.

## Analyze

Look for:

- Workflows repeated 2 or more times in this session: the same tool or
  command sequence run more than once, especially with manual fixes in
  between.
- User corrections: phrases like "ne", "nem így", "helyette", "don't",
  "instead", or any message that reverses or redirects a prior step.
- Errors that needed real debugging, not a one-line typo fix.
- Skills that were invoked where the skill's guidance turned out to be
  insufficient, missing a case, or wrong for this codebase.
- Rules from `.claude/CLAUDE.md` and `.claude/rules/*.md` that were violated
  during the session. Compare against the rule text in those files directly,
  do not rely on memory of them.
- Uncommitted work. Run `git status --porcelain` and `git log --oneline -3`.
  `kötelező mindig commitolni` is a standing rule, so a working tree full of
  the session's own output is a finding, not background noise. Report it in
  the summary even when it produces no proposal.
- Run `mise exec -- pnpm claude:memory status`. When it reports a review is
  due, say so in the Session summary with the reason the command gave, and
  tell the user that `/memory-review` is theirs to run: the skill is
  user-invoked only, so this retrospective never starts one itself. This is a
  reported fact, not a proposal, so it never becomes a `memory` proposal.
- Proposals earlier runs left approved and nobody applied. Run
  `grep -rn "approved, not applied" .claude/retrospectives` from the
  repository root. Every waiting proposal carries that phrasing literally in
  its Outcomes line, so one search finds all of them. A hit counts only where
  it sits in an `Outcomes` section: the same words inside a `Proposals` block
  or an earlier run's `Still waiting` list are this archive quoting itself,
  and reporting one invents a proposal nobody made. Reporting a hit is
  the whole of what this run does with it: put its `<path>:<line>` and the
  proposal it names in this run's `Still waiting` section, which `## Output`
  places, and repeat that list in the plain-text summary returned to the
  caller, so the caller can put these to the user beside this run's own
  proposals. Never apply, re-propose, or rewrite one; this fork finishes
  before the user has been asked anything, so the decision is not here to
  make. When the command prints nothing it also exits 1, which is grep's
  empty result and not a failed run: write the literal line `Nothing still
  waiting.` in that section, because an archive with nothing waiting and a
  scan that never ran must not look the same in the file.

## Decision criteria

Propose a change only if at least one of these holds. Otherwise report "no
proposal" and stop.

- The pattern recurs across sessions, or 2 or more times within this one.
- It is non-obvious and cost real debugging time to work out.
- It is broadly reusable, not a one-off fix specific to this session's task.
- It is an explicit user correction that would otherwise repeat next time.

Routing:

- A stable fact or convention -> a new rule in `.claude/CLAUDE.md` (keep it
  under 200 lines) or in the matching `.claude/rules/*.md` file.
- A multi-step procedure -> a new or updated skill under
  `packages/shared/.agents/skills/`.
- A durable learning that is neither a rule nor a procedure, a decision with
  the reason behind it or a trap that already cost time -> an entry in
  `.claude/shared-memory/`: one topic file plus its line in the index.
- Behavior specific to one app -> `apps/<app>/AGENTS.md`.

## Output

Always write
`.claude/retrospectives/<YYYY-MM-DD>-<first 8 chars of session id>.md` (the
session id is the transcript filename stem, without `.jsonl`), even when
there are no proposals: this file is the marker the SessionStart hook looks for
in that directory, and a session with no marker can come back on the pending
list for a later session to redo. An existing marker does not always close a
session either, so do not reason from presence or absence alone;
`.claude/hooks/CLAUDE.md` ("Pending-retrospective markers") owns the exact
conditions. The file must start with the heading
`# Retrospective <YYYY-MM-DD> session <id8>`, followed by these sections:

- **Still waiting** - what the `## Analyze` scan turned up from earlier runs,
  ahead of everything else this run writes; that step owns the content,
  including the line to write when the scan turned up nothing.
- **Session summary** - 5 lines max, what the session actually did.
- **Evidence** - quoted user corrections and/or repeated command sequences
  that justify each proposal.
- **Proposals** - one entry per proposal, each with:
  - `type`: `new-skill` | `update-skill` | `claude-md` | `agents-md` |
    `memory`
  - `target path`, written relative to the repository root (never an
    absolute path; machine-specific paths are forbidden in this repository)
  - `rationale`
  - full proposed content, or a diff against the current file

  A `memory` proposal gives the topic name, the one-line summary that goes in
  the index, and the body of the topic file. Applying it is
  `pnpm claude:memory write <topic> --summary "<one line>" --content "<body>"`,
  run by the caller only after the user approved that proposal with
  AskUserQuestion, never by this skill.

- **Not proposed** - things you considered and rejected, one line each,
  with a short reason.
- **Outcomes** - one line per proposal, saying what became of it. This skill
  never writes this section and never leaves an empty one behind: it finishes
  before the caller has asked the user anything, so it cannot know what was
  decided. The caller writes it, and in a file that collects several runs it
  goes at the end of the run whose proposals it records, as one more of that
  run's own sections and at the same heading level as its `Not proposed`, so
  each set of decisions stays beside the proposals it decided.
  `.claude/rules/session-lifecycle.md` says when.

Each Outcomes line names its proposal by number and heading, then ends in one
of three phrasings, worded literally so one search across the archive finds
every proposal still waiting:

```markdown
## Outcomes

- **1. Run the database script instead of raw docker** - applied in `a1b2c3d`.
- **2. Cap the Evidence section at ten lines** - declined: the long ones are
  the useful ones.
- **3. Memory entry: the dev gateway owns the port** - approved, not applied:
  waiting for the topic name the user wants.
```

`applied in <short sha>` names the commit that carries the change, `declined:`
gives the user's own reason in a clause, and `approved, not applied:` says
what it is waiting on until the session that applies it edits that same line
in place into the `applied in <short sha>` form.
That third phrasing is why approvals are recorded and not only declines: an
approved proposal that was then lost looks exactly like a declined one in a
file that records neither.

If nothing meets the decision criteria, still write the file with the Still
waiting and Session summary sections and a `## Not proposed` section, and end
the file with the literal line `No proposal.`. Omit the Evidence and
Proposals sections in that case.

If the target file already exists (for example a manual mid-session run was
followed by more work in the same session, or this is a second pass on the
same calendar day), do not overwrite it. Instead append a new `## Run <ISO
timestamp>` section (e.g. `## Run 2026-09-01T21:40:00Z`) to the end of the
file, and write the new Still waiting, Session summary, Evidence, Proposals,
and Not proposed content one level under it, as `###` headings, so earlier
runs stay readable in the same file and every section stays attached to the
run that produced it.

Return to the caller a short plain-text summary: the number of proposals, the
file path if one was written, and one line per proposal. That summary plus the
`NEXT:` line below it is the whole of the final message, and it replaces
whatever final-report shape the agent named in `agent:` above carries: the file
this run wrote already holds the findings, and the caller acts on the `NEXT:`
line. End the response with the literal line:

```
NEXT: ask the user with AskUserQuestion which of this run's proposals to apply, and what to do with each Still waiting item carried over from an earlier run; apply only approved ones. For new-skill and update-skill proposals invoke the skill-creator skill (plugin) to write, refine, eval, and place the skill using workspace conventions. Then record this run's proposals in this file's Outcomes section, and close a carried-over item by editing its line in the earlier run's own file. .claude/rules/session-lifecycle.md says when those writes happen and how both sets go to the user.
```

## Never

- Never edit `CLAUDE.md`, `AGENTS.md`, or any `SKILL.md` yourself. Only
  propose. That holds against the pull of `agent: instructions-opus` above,
  which exists to edit exactly those files and has the tools to do so: this
  fork finishes before the user has been asked anything, so on this run there
  is no approval yet to act on.
- Never commit.
- Never include secrets, tokens, emails, or customer data from the
  transcript in the output file or in your summary.
