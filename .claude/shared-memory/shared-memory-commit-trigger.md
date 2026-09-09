# shared-memory-commit-trigger (2026-09-09)

## Proposal
Retrospective proposal from session `12b77c0a` (F.6 IdeaStore refactor cycle on `refactor/classbase`):

> shared-memory file Write must be followed by immediate `git add && git commit` in the same tool-turn.

## Justification
3 corpus hits in 24h (2026-09-07 `1d029d91` end-of-session, 2026-09-09 `ff2f88e4` mid-session after code-review, 2026-09-09 `12b77c0a` TWICE in one session — `f-idea-store-db-client-flakiness.md` triggered the user's "nem lett commitolva a memoria fajl!" message).

The `kötelező mindig commitolni` (CLAUDE.md §6) and dual-write rule (CLAUDE.md §7) say WHAT but not WHEN; the agent defers because the file "feels like session output". Event-driven commit trigger (the Write call) instead of session-end trigger.

## Application
**CRITICAL RULE constraint**: the user has an explicit project rule against touching CLAUDE.md. Therefore the proposal is applied as Honcho + shared-memory dual-write, NOT as CLAUDE.md §7 modification.

**Session mainloop rule from this session forward**:
1. When the Write tool produces a `.claude/shared-memory/*.md` file, the session mainloop MUST immediately `git add && git commit` the file in the same tool-turn (or in the next tool-call at the latest — never defer).
2. Do NOT defer the commit to session-end — that's the failure mode the proposal targets.
3. Use `git -c user.email=eggprojectteams@gmail.com -c user.name=EggProjectTeams commit -m "docs(shared-memory): add <topic> entry"` with author pre-check (Honcho rule 2).
4. Same applies to `.claude/retrospectives/*.md` files produced by the `/retrospective` skill (which writes but does not commit).

## Precedents
- F.4 SettingsStore `f4-settings-store-code-review-skipped-findings.md` was committed in `db6537e` as part of the F.4 cycle commit (no deferred commit) — correct pattern.
- F.6 IdeaStore `f-idea-store-db-client-flakiness.md` was committed in `7222365` AFTER the user pointed out "nem lett commitolva a memoria fajl!" — failure mode (the rule this proposal targets).
- F.6 IdeaStore `f-idea-store-code-review-skipped-findings.md` was committed in `5e34d1c` later in the same session, in a separate turn after the Write — also failure mode.

## Honcho dual-write
Entry: "shared-memory-commit-trigger (2026-09-09)" — release-checklist-prevention per CLAUDE.md §7.
