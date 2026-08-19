import { describe, it, expect } from 'vitest'
import {
  detectPaneState,
  detectPermissionMode,
  detectsThinkingBlockError,
  detectsBlockingMenu,
  detectsPastePlaceholder,
  detectsFirstRunGate,
  detectsModelConsentDialog,
  isReadyForPrompt,
  shouldRetrySubmit,
  shouldClearTruncatedPreamble,
  decideSubmitFollowup,
  decidePaneErrorAlert,
  stuckInputSignature,
  parkedPasteSignature,
  decideStuckInputRecovery,
  decideStuckInputAction,
  parkedChannelInput,
  parkedInputText,
  parkedMachineOriginInput,
  parkedScheduledTaskInput,
  parkedInputRowCount,
  parkedMainInputHasRemedy,
  submitLanded,
  idleConsideringDimGhost,
  paneLooksIdle,
  stuckToolCallSignature,
  decideStuckToolCallRecovery,
  stripGhostSuggestion,
  paneShowsContextSaturation,
} from '../pane-state.js'

// Realistic pane fixtures modelled on actual `tmux capture-pane -p`
// output from shipping Claude Code builds. Whitespace and box-drawing
// characters (U+2500 ─, U+276F ❯, U+23F5 ⏵) preserved exactly so the
// regex matches exercise the same byte sequences they would in prod.

const SEP = '─'.repeat(80)

const IDLE_BYPASS = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const IDLE_STRICT = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ? for shortcuts',
].join('\n')

// Permission-mode footers OTHER than bypass. Every one of these is a real
// `tmux capture-pane -p` tail copied verbatim from a running fleet session on
// 2026-07-27 (the ⏵⏵/⏸ glyphs and the `·` separators are the actual bytes, not
// retyped lookalikes) -- retyping them by hand is how the previous fix passed
// its own tests while still missing the mode that was losing messages.
//
// The delivery bug: an agent parked in `accept edits on` read as 'unknown', so
// the router refused to inject and four messages to it were swallowed without
// an error, while bypass-mode agents received everything.
const modeFooter = (tail: string) => ['', SEP, '❯ ', SEP, tail].join('\n')

const IDLE_ACCEPT_EDITS = modeFooter('  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents')
const IDLE_PLAN_MODE = modeFooter('  ⏸ plan mode on (shift+tab to cycle) · ← for agents')
const IDLE_AUTO_MODE = modeFooter('  ⏵⏵ auto mode on (shift+tab to cycle)')
const IDLE_MANUAL_MODE = modeFooter('  ⏵ manual mode on (shift+tab to cycle)')
const IDLE_BYPASS_FLEETVIEW = modeFooter('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents')
// No shift+tab hint at all: the tail alone has to carry it.
const IDLE_ACCEPT_EDITS_TAIL_ONLY = modeFooter('  ⏵⏵ accept edits on · 1 monitor · ← for agents')

// The tail is what keeps prose out. Scrollback quoting a footer phrase without
// the UI chrome must NOT read as idle -- otherwise a pasted log line parks the
// router on a busy agent.
const NOT_A_FOOTER_QUOTED = ['', SEP, '❯ ', SEP, '  valaki azt írta: bypass permissions on'].join('\n')

const BUSY_FULL_FOOTER = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// The smoke-test bug scenario: spinner rendered, but the footer is still
// in its one-frame idle state before `· esc to interrupt` is appended.
const BUSY_FOOTER_FRAME_GAP = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Spinner label missing (older/newer Claude Code build). Only the
// token-count pattern is present. Must still classify as busy.
const BUSY_TOKENS_ONLY = [
  '✶ (4s · ↓ 120 tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Tool-use summary lines persist in the scrollback AFTER a turn ends --
// Claude Code does not overwrite them. Including them as busy signals
// would classify an otherwise idle agent as busy forever, starving
// the scheduler. This fixture models the post-turn idle state: the tool
// summary is on screen but no spinner, no tokens, no esc-to-interrupt.
const IDLE_AFTER_TOOL_USE = [
  '  Searched for 3 patterns, listed 4 directories (ctrl+o to expand)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Real busy-with-tool-use: spinner line present alongside the tool summary.
const BUSY_TOOL_USE_ACTIVE = [
  '  Searched for 3 patterns, listed 4 directories (ctrl+o to expand)',
  '✢ Combobulating… (12s · ↓ 480 tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

const TYPING_PARKED = [
  '',
  SEP,
  '❯ Valami amit a felhasznalo elkezdett geppelni, meg nem kuldte el',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const PENDING_PASTE = [
  '',
  SEP,
  '❯ [Pasted text #1 +234 chars]',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Placeholder render from an OLDER Claude Code build: the bracketed-paste
// detector REPLACES the idle footer (`bypass permissions on ...`) with a
// `paste again to expand` hint, so the pane does NOT satisfy IDLE_FOOTER_RX.
// The detector must NOT depend on this footer being present or absent -- the
// footer shape is version-dependent. Kept as a regression case so the
// box-scoped, footer-independent detector still classifies this shape.
// The `[Pasted text #N]` stub here has no `+X chars` suffix, the other shape
// the same build emits. The stub sits on the FIRST line of the live input box.
const PENDING_PASTE_REALISTIC = [
  '',
  SEP,
  '❯ [Pasted text #38]the quick brown fox jumps over the lazy dog the quick brown',
  '  brown fox jumps over the lazy dog the quick brown fox jumps over the lazy dog',
  '  the lazy dog the quick brown fox jumps over the lazy dog',
  SEP,
  '  paste again to expand',
].join('\n')

// SANITIZED reproduction of the REAL production render shape (derived from the
// 6 captured incident panes, NOT copied verbatim -- the captures contain agent
// names / real messages). Ground truth from the captures:
//   - The long input WRAPS, so the stub straddles a line break: `...[Pasted
//     text` at the end of one line and `  #N]...` at the start of the next.
//     The single-space regex `[Pasted text #\d` MISSED this (false negative on
//     2 of 3 real incidents).
//   - The stub sits inside the LIVE INPUT BOX (the wrapped `❯` prompt line).
//   - The footer is the NORMAL `bypass permissions on (shift+tab to cycle)`
//     idle footer -- there is NO `paste again to expand` line. The detector
//     must therefore not rely on that hint.
// Benign filler stands in for the real (sensitive) message body.
const PENDING_PASTE_WRAPPED_REAL_SHAPE = [
  '',
  SEP,
  '❯ TEAM MEMBER NOTICE filler filler filler filler filler filler filler b[Pasted text',
  '  #3]filler continuation of the wrapped message body in the live input box here',
  '  more benign filler text continuing inside the same wrapped input box region',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Same wrapped-stub real shape but with the DIGITS themselves straddling the
// break: `#` at the end of one line, the digit at the start of the next. The
// `\s*` between `#` and the digit must tolerate this too.
const PENDING_PASTE_WRAPPED_DIGIT_SPLIT = [
  '',
  SEP,
  '❯ filler filler filler filler filler filler filler filler filler [Pasted text #',
  '  12]filler continuation of the parked message body inside the live input box',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// FALSE-POSITIVE guard: a `[Pasted text #N +X chars]` literal sits ONLY in an
// upper reply line (these agents routinely quote tmux captures and discuss this
// very bug), while the live input box at the bottom is EMPTY. A whole-pane
// match would fire a destructive Ctrl-C + resend on a healthy, idle agent. The
// box-scoped detector must return false here.
const PASTE_ECHO_IN_SCROLLBACK_ONLY = [
  '  Quoting a capture in a reply: [Pasted text #1 +900 chars] -- discussed in',
  '  the stuck-input bug thread, just prose about the placeholder behaviour',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Historical ❯ above the separators (scrollback). Must NOT count as
// parked input -- the input box is strictly the region between the two
// most recent separators.
const IDLE_WITH_SCROLLBACK_CARET = [
  '  ❯ some old echoed command from scrollback',
  '  output of that command',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A pane that is not Claude Code at all (regular shell).
const NON_CLAUDE = [
  'user@host ~ $ ls',
  'README.md  src/  test/',
].join('\n')

// Background-shells footer variant. Claude Code rewrites the bypass-mode
// footer when the session has one or more BashTool background shells
// running: the "(shift+tab to cycle)" hint is replaced with the
// "· N shells · ctrl+t to hide tasks · ↓ to manage" indicator. The pane
// is still idle and must accept a new prompt -- otherwise inter-agent
// messages and scheduled tasks pile up in pending forever for any agent
// that polls (gh run list, watchers, etc.) in the background.
const IDLE_BACKGROUND_SHELLS = [
  '  85 tasks (84 done, 1 in progress, 0 open)',
  '   … +80 completed',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 3 shells · ctrl+t to hide tasks · ↓ to manage',
].join('\n')

// Same variant with a single shell (singular form). Defensive: the regex
// must accept both "shell" and "shells" so a 1-shell session is not stuck.
const IDLE_BACKGROUND_ONE_SHELL = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell · ctrl+t to hide tasks · ↓ to manage',
].join('\n')

// Background-shells footer with the tasks panel HIDDEN. When the
// operator (or the agent) presses ctrl+t to hide the tasks panel,
// Claude Code drops the "ctrl+t to hide tasks" segment and renders a
// shorter footer: "· N shells · ↓ to manage". The pane is still idle;
// the only difference is that the toggle hint is gone because the panel
// it would toggle is already hidden. Observed in production on a sub-
// agent session where the operator had hidden the tasks panel.
const IDLE_BACKGROUND_SHELLS_HIDDEN = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 3 shells · ↓ to manage',
].join('\n')

// Same hidden-tasks variant with a single shell (singular form).
// Defensive: covers the corner where a session has exactly one
// background shell AND the tasks panel is hidden, so neither the
// plural form nor the ctrl+t segment is present.
const IDLE_BACKGROUND_ONE_SHELL_HIDDEN = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
].join('\n')

// Wedged thinking-block API error. An assistant turn ended with the
// 400 about thinking blocks that "cannot be modified"; the pane shows
// the tool-output chrome (`⎿  API Error: ...`), a past-tense thinking
// stamp, an empty input box and the idle footer. The U+23BF result
// glyph and the full phrase are reproduced exactly so the regex sees
// the same bytes it would in prod. Sanitised: no internal names/paths.
const ERROR_THINKING_BLOCK = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` or `redacted_thinking` blocks in the latest assistant message',
  '      cannot be modified. These blocks must remain as they were in the original response.',
  '',
  '✻ Sauteed for 1s',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A message body that QUOTES "API Error 400" in prose (an instruction
// to report if the error recurs). No `⎿  API Error: <num>` chrome and
// no "cannot be modified" phrase -- must NOT be read as a wedged error.
const ERROR_ECHO_IN_MESSAGE = [
  '  HA a session-history korrupt es ismet API Error 400 jon a feldolgozas',
  '  elejen, AZONNAL jelezd vissza inter-agent uzenetben.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A reply that quotes the FULL phrase ("thinking ... cannot be
// modified") in prose, e.g. a bug analysis, but WITHOUT the
// `⎿  API Error: <num>` chrome glyph. The chrome guard must keep this
// out of the 'error' class.
const ERROR_FULL_PHRASE_PROSE = [
  '  A hiba lenyege: a thinking vagy redacted_thinking blocks cannot be',
  '  modified ket API-hivas kozott. Ezt most csak elemzem, nem elo hiba.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// An old error far up in scrollback (above the live tail), with a fresh
// idle turn below it. The position scope must ignore the stale error so
// a recovered session is not stuck classified as 'error'.
const ERROR_DEEP_SCROLLBACK = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.',
  ...Array(24).fill('  (normal output line after the session recovered)'),
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Error chrome present BUT a live spinner is also rendered: the turn is
// running again, not wedged. The busy guard must win so we do not stop
// injecting into a session that is actually working.
const ERROR_DURING_BUSY = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.',
  '✻ Combobulating… (12s · ↓ 480 tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// A BENIGN chrome error (429) on one line AND an unrelated "thinking ...
// cannot be modified" prose several lines below it (outside the chrome
// block). The guards are required WITHIN one chrome block, so this must
// NOT be flagged -- otherwise a healthy session that hits a rate limit
// and elsewhere mentions the phrase would be wrongly reset.
const ERROR_DECOUPLED_BENIGN = [
  '  ⎿  API Error: 429 overloaded_error: server busy, retrying',
  '  retry succeeded, continuing the task',
  '  finished that step',
  '',
  '  Note: the thinking-block error is when a block cannot be modified.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A real wedged error with a STRAY footer-looking line ("? for
// shortcuts") quoted higher up in scrollback. The footer must be found
// from the bottom, otherwise the scope locks onto the stray line and the
// real error below it is missed (false negative).
const ERROR_WITH_STRAY_FOOTER_ABOVE = [
  '  Use the ? for shortcuts hint mentioned in the docs',
  '  (a scrollback message that quotes help text)',
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` or `redacted_thinking` blocks in the latest assistant message',
  '      cannot be modified. These blocks must remain as they were in the original response.',
  '✻ Sauteed for 1s',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Narrow terminal: the long error message wraps so "cannot be modified"
// lands on the 4th line of the chrome block (chrome + 3 continuations).
// A 3-line window would miss it (false negative); the 4-line block
// catches it. The thinking kind is on the chrome line, redacted_thinking
// on the 2nd, the phrase on the 4th.
const ERROR_NARROW_WRAP = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking`',
  '      or `redacted_thinking` blocks in the latest assistant',
  '      message. These response',
  '      blocks cannot be modified and must remain unchanged.',
  '✻ Sauteed for 1s',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// The mode the footer advertises, surfaced for the dashboard. Every mode is
// still 'idle' for delivery -- this only answers "and what happens after it
// arrives?", which is what nobody could see when an agent sat in an ask-first
// mode for hours looking healthy.
describe('detectPermissionMode', () => {
  it.each([
    ['bypass permissions', IDLE_BYPASS_FLEETVIEW],
    ['accept edits', IDLE_ACCEPT_EDITS],
    ['plan mode', IDLE_PLAN_MODE],
    ['auto mode', IDLE_AUTO_MODE],
    ['manual mode', IDLE_MANUAL_MODE],
    ['accept edits', IDLE_ACCEPT_EDITS_TAIL_ONLY],
  ])('reads %s off the footer', (expected, pane) => {
    expect(detectPermissionMode(pane)).toBe(expected)
  })

  it('calls the no-banner footer "default" (asks about everything)', () => {
    expect(detectPermissionMode(IDLE_STRICT)).toBe('default')
  })

  it('returns null when there is no footer to read', () => {
    expect(detectPermissionMode('')).toBeNull()
    expect(detectPermissionMode('csak valami szöveg')).toBeNull()
  })

  it('does not invent a mode from a quoted footer phrase', () => {
    expect(detectPermissionMode(NOT_A_FOOTER_QUOTED)).toBeNull()
  })
})

describe('detectPaneState', () => {
  it('returns unknown for empty input', () => {
    expect(detectPaneState('')).toBe('unknown')
    expect(detectPaneState('   \n\n  ')).toBe('unknown')
  })

  it('detects idle on bypass-mode footer with empty input box', () => {
    expect(detectPaneState(IDLE_BYPASS)).toBe('idle')
  })

  it('detects idle on strict-mode footer ("? for shortcuts")', () => {
    expect(detectPaneState(IDLE_STRICT)).toBe('idle')
  })

  // Every permission mode must read as idle, not just bypass. Before this,
  // anything else classified as 'unknown' and the router silently skipped it.
  it.each([
    ['accept edits', IDLE_ACCEPT_EDITS],
    ['plan mode', IDLE_PLAN_MODE],
    ['auto mode', IDLE_AUTO_MODE],
    ['manual mode', IDLE_MANUAL_MODE],
    ['bypass with the FleetView tail', IDLE_BYPASS_FLEETVIEW],
    ['accept edits with no shift+tab hint', IDLE_ACCEPT_EDITS_TAIL_ONLY],
  ])('detects idle on the %s footer', (_label, pane) => {
    expect(detectPaneState(pane)).toBe('idle')
    expect(isReadyForPrompt(pane)).toBe(true)
  })

  it('does not read a quoted footer phrase without the UI tail as idle', () => {
    expect(detectPaneState(NOT_A_FOOTER_QUOTED)).not.toBe('idle')
  })


  it('detects idle when the footer shows the multi-shell indicator', () => {
    // Regression: Claude Code rewrites "(shift+tab to cycle)" to
    // "· N shells · ctrl+t to hide tasks · ↓ to manage" when the session
    // has BashTool background shells running. The old strict regex did
    // not match this variant, so any session with a background poll
    // was classified 'unknown' and never received inter-agent messages.
    expect(detectPaneState(IDLE_BACKGROUND_SHELLS)).toBe('idle')
  })

  it('detects idle when the footer shows the singular "1 shell" form', () => {
    // The footer uses the singular "1 shell" (not "1 shells") for a
    // single background shell. Split from the multi-shell test so a
    // future regression on either form fails with a precise signal.
    expect(detectPaneState(IDLE_BACKGROUND_ONE_SHELL)).toBe('idle')
  })

  it('detects idle when the tasks panel is HIDDEN (no "ctrl+t" segment)', () => {
    // Claude Code drops the "ctrl+t to hide tasks" segment when the
    // tasks panel is already hidden, leaving "· N shells · ↓ to manage"
    // as the only suffix. The pane is still idle, just with a shorter
    // footer. The previous regex only matched the "ctrl+t" form, so
    // sessions with the tasks panel hidden were classified 'unknown'
    // and inter-agent messages stalled until the next manual toggle.
    expect(detectPaneState(IDLE_BACKGROUND_SHELLS_HIDDEN)).toBe('idle')
    expect(detectPaneState(IDLE_BACKGROUND_ONE_SHELL_HIDDEN)).toBe('idle')
  })

  it('does NOT classify a truncated "· N shell" prefix as idle', () => {
    // Defense in depth: the shells-variant requires either the
    // "· N shells · ctrl+t" marker or the "· N shells · ↓ to manage"
    // marker, not just the bare "· N shell(s)" prefix. Two reasons we
    // pin this down with an explicit negative test:
    //   1. A malformed or partially rendered footer (terminal
    //      corruption, mid-render frame) must classify as 'unknown'
    //      so we do not deliver a prompt into a pane that is not
    //      really ready.
    //   2. The "bypass permissions on · 1 shell" substring could
    //      appear in scrollback as quoted log output or an echoed
    //      message, and the regex must not be tricked into treating
    //      that as a live footer.
    // The fixture is deliberately minimal: no other idle markers
    // (no "(shift+tab to cycle)", no "? for shortcuts") so the
    // assertion isolates the truncated-shells path specifically.
    const truncated = [
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell',
    ].join('\n')
    expect(detectPaneState(truncated)).toBe('unknown')
  })

  it('detects busy when "esc to interrupt" footer marker is present', () => {
    expect(detectPaneState(BUSY_FULL_FOOTER)).toBe('busy')
  })

  it('detects busy even when the footer frame-gap hides "esc to interrupt"', () => {
    // Regression for the smoke-test-11-10 bug: spinner + tokens visible,
    // footer still shows plain idle. Old single-regex detector said idle
    // (false positive). New detector catches via BUSY_INDICATORS.
    expect(detectPaneState(BUSY_FOOTER_FRAME_GAP)).toBe('busy')
  })

  it('detects busy from the token-count pattern alone (unknown spinner label)', () => {
    // A Claude Code release could rename "Combobulating" to anything. The
    // (Ns · ↓N tokens) pattern is the load-bearing fallback.
    expect(detectPaneState(BUSY_TOKENS_ONLY)).toBe('busy')
  })

  it('detects busy when a tool-use summary is paired with a live spinner', () => {
    expect(detectPaneState(BUSY_TOOL_USE_ACTIVE)).toBe('busy')
  })

  it('detects error when wedged on the thinking-block 400', () => {
    // The wedged state: idle footer (turn finished) + past-tense
    // thinking stamp, no live busy signal, but the live tail shows the
    // `⎿  API Error: ... thinking ... cannot be modified` output. Old
    // detector said 'idle' here, so the scheduler kept injecting doomed
    // prompts. Must now be 'error' so isReadyForPrompt() returns false.
    expect(detectPaneState(ERROR_THINKING_BLOCK)).toBe('error')
  })

  it('does NOT classify a prose "API Error 400" mention as error', () => {
    // A message body quoting "API Error 400" (an instruction to report
    // recurrence) has no `⎿  API Error: <num>` chrome and no
    // "cannot be modified" phrase. Must stay idle.
    expect(detectPaneState(ERROR_ECHO_IN_MESSAGE)).toBe('idle')
  })

  it('does NOT classify the full phrase in prose (no chrome) as error', () => {
    // A bug-analysis reply quoting "thinking ... cannot be modified" in
    // prose, without the tool-output chrome glyph, must not trip the
    // detector. The chrome guard is what discriminates a real wedged
    // turn from a quote.
    expect(detectPaneState(ERROR_FULL_PHRASE_PROSE)).toBe('idle')
  })

  it('does NOT classify a stale error in deep scrollback as error', () => {
    // Once a session recovers, its old error scrolls up out of the live
    // tail. The position scope must ignore it so a healthy session is
    // not stuck flagged. Below the stale error the pane is plainly idle.
    expect(detectPaneState(ERROR_DEEP_SCROLLBACK)).toBe('idle')
  })

  it('prefers busy over error when a live spinner is rendered', () => {
    // Error chrome on screen but the turn is running again (spinner +
    // token tail). The busy guard precedes the error guard so we do not
    // stop injecting into a session that is actually working.
    expect(detectPaneState(ERROR_DURING_BUSY)).toBe('busy')
  })

  it('does NOT flag a benign chrome + decoupled phrase as error', () => {
    // A 429 chrome on one line and an unrelated "cannot be modified"
    // prose several lines below (outside the chrome block) must not
    // AND-combine into a false positive. This is the per-block guard.
    expect(detectPaneState(ERROR_DECOUPLED_BENIGN)).toBe('idle')
  })

  it('detects error even when a stray footer line sits in scrollback', () => {
    // The footer is found from the bottom, so a "? for shortcuts" string
    // quoted higher up does not steal the scope from the real wedged
    // error sitting just above the live footer.
    expect(detectPaneState(ERROR_WITH_STRAY_FOOTER_ABOVE)).toBe('error')
  })

  it('detects error when a narrow terminal wraps the message onto 4 lines', () => {
    // The phrase "cannot be modified" wraps to the 4th line of the
    // chrome block. The 4-line block window must still catch it.
    expect(detectPaneState(ERROR_NARROW_WRAP)).toBe('error')
  })

  it('does NOT classify idle-with-stale-tool-use-scrollback as busy', () => {
    // Tool-use summary lines survive into the scrollback after the turn
    // ends. Classifying them as busy would starve the scheduler after
    // any agent's tool call. Only active-turn signals (spinner, tokens,
    // esc-to-interrupt, footer-scoped) count.
    expect(detectPaneState(IDLE_AFTER_TOOL_USE)).toBe('idle')
  })

  it('does NOT classify a stale token-counter scrolled above the box as busy', () => {
    // 94-retry starvation regression (2026-06-30): a completed turn's final
    // "Accomplishing… (Ns · ↓ N tokens)" frame lingered well above the idle
    // input box. The token-counter scan is region-scoped, so a counter that
    // has scrolled out of the live bottom region must not pin the pane busy.
    const staleCounter = [
      '✶ Accomplishing… (3m 8s · ↓ 9.3k tokens)',
      '⏺ Done: rebuilt and restarted the dashboard.',
      '⏺ Verified endpoints, logged the fix.',
      '⏺ Extra trailing scrollback line one.',
      '⏺ Extra trailing scrollback line two.',
      '⏺ Extra trailing scrollback line three.',
      '⏺ Extra trailing scrollback line four.',
      '⏺ Extra trailing scrollback line five.',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(staleCounter)).toBe('idle')
  })

  it('detects typing when text is parked in the input box', () => {
    expect(detectPaneState(TYPING_PARKED)).toBe('typing')
  })

  it('merges typing into busy when mergeTypingAsBusy is set', () => {
    expect(detectPaneState(TYPING_PARKED, { mergeTypingAsBusy: true })).toBe('busy')
  })

  it('treats a pending-paste placeholder as busy', () => {
    expect(detectPaneState(PENDING_PASTE)).toBe('busy')
  })

  it('treats the older-build placeholder (paste-again footer) as busy, not unknown', () => {
    // Regression for the root-cause gap: the older placeholder render replaces
    // the idle footer with `paste again to expand`, so it failed IDLE_FOOTER_RX
    // and was mis-classified 'unknown' (slipping past the readiness/retry
    // guards). The paste check now runs BEFORE the idle-footer gate.
    expect(detectPaneState(PENDING_PASTE_REALISTIC)).toBe('busy')
  })

  it('treats the WRAPPED real-shape placeholder (normal idle footer) as busy', () => {
    // The primary real-incident shape: wrapped stub inside the input box with
    // the NORMAL idle footer below it. Must read 'busy' so the scheduler/router
    // defer rather than pile a second prompt onto the parked placeholder.
    expect(detectPaneState(PENDING_PASTE_WRAPPED_REAL_SHAPE)).toBe('busy')
    expect(detectPaneState(PENDING_PASTE_WRAPPED_DIGIT_SPLIT)).toBe('busy')
  })

  it('stays idle when a stub is only quoted in scrollback and the box is empty', () => {
    // False-positive guard: a `[Pasted text #N]` quoted in a reply line must
    // not flip an idle, empty-box pane to 'busy'.
    expect(detectPaneState(PASTE_ECHO_IN_SCROLLBACK_ONLY)).toBe('idle')
  })

  it('does NOT confuse a historical ❯ in scrollback for a parked input', () => {
    expect(detectPaneState(IDLE_WITH_SCROLLBACK_CARET)).toBe('idle')
  })

  it('returns unknown for a pane that is not a Claude Code surface', () => {
    expect(detectPaneState(NON_CLAUDE)).toBe('unknown')
  })

  it.each([
    'Pondering…',
    'Beaming…',
    'Thinking…',
    'Reticulating…',
    'Configuring…',
    'Noodling…',
    'Ruminating…',
    'Percolating…',
    'Cogitating…',
    'Deliberating…',
    'Contemplating…',
    'Musing…',
    'Brewing…',
    'Synthesizing…',
    'Distilling…',
    'Refining…',
    'Simmering…',
    'Crafting…',
    'Formulating…',
    'Consulting…',
    'Unfurling…',
    'Unspooling…',
    'Unraveling…',
  ])('matches a busy spinner label paired with the runtime tail: %s', (label) => {
    // The label regex requires the `(Ns · ↓` tail on the same line so
    // prose like a Markdown heading `# Thinking…` does not false-positive.
    const snap = [
      `✢ ${label} (3s · ↓ 42 tokens)`,
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('busy')
  })

  it('does NOT classify a bare spinner-label word as busy (Markdown heading in reply text)', () => {
    // Regression: spinner labels followed by U+2026 ellipsis must not
    // false-positive on prose that happens to contain the word.
    // Without the `(Ns · ↓` tail requirement, any of these would stall
    // the scheduler forever once they landed in scrollback.
    const snaps = [
      '# Thinking…',
      'Step 1: Crafting… the plan',
      'Beaming… a message through the router',
    ]
    for (const prose of snaps) {
      const snap = [
        prose,
        SEP,
        '❯ ',
        SEP,
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n')
      expect(detectPaneState(snap)).toBe('idle')
    }
  })

  it('busy indicator wins over a visible idle footer', () => {
    // Both signals present: spinner says busy, footer says idle. Caller
    // must trust busy (it's a superset constraint).
    const snap = [
      '✢ Combobulating… (7s · ↓ 80 tokens)',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('busy')
  })

  it('does not match the token-count pattern in unrelated numeric text', () => {
    const snap = [
      'Some unrelated log line: latency 5s, count 42',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('idle')
  })

  it('handles pane without any separators gracefully', () => {
    const snap = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    // Footer alone (no box) -> treat as idle. No parked input to detect.
    expect(detectPaneState(snap)).toBe('idle')
  })

  it('handles footer with missing bottom separator', () => {
    // Defensive: only one separator visible -- no input box detection,
    // but footer + no busy indicators still means idle.
    const snap = [
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('idle')
  })
})

describe('isReadyForPrompt', () => {
  it('is true only when state === idle', () => {
    expect(isReadyForPrompt(IDLE_BYPASS)).toBe(true)
    expect(isReadyForPrompt(IDLE_STRICT)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_SHELLS)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_ONE_SHELL)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_SHELLS_HIDDEN)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_ONE_SHELL_HIDDEN)).toBe(true)
    expect(isReadyForPrompt(BUSY_FULL_FOOTER)).toBe(false)
    expect(isReadyForPrompt(BUSY_FOOTER_FRAME_GAP)).toBe(false)
    expect(isReadyForPrompt(TYPING_PARKED)).toBe(false)
    expect(isReadyForPrompt(PENDING_PASTE)).toBe(false)
    expect(isReadyForPrompt(NON_CLAUDE)).toBe(false)
    expect(isReadyForPrompt('')).toBe(false)
    // A wedged thinking-block error is not idle, so it is not ready --
    // this is what stops the router/scheduler injecting doomed prompts.
    expect(isReadyForPrompt(ERROR_THINKING_BLOCK)).toBe(false)
  })
})

describe('detectsThinkingBlockError', () => {
  it('is true on the wedged thinking-block 400 pane', () => {
    expect(detectsThinkingBlockError(ERROR_THINKING_BLOCK)).toBe(true)
  })

  it('is false on a healthy idle pane', () => {
    expect(detectsThinkingBlockError(IDLE_BYPASS)).toBe(false)
    expect(detectsThinkingBlockError(IDLE_BACKGROUND_SHELLS)).toBe(false)
  })

  it('is false when only the chrome is present without the thinking phrase', () => {
    // A different turn-level API error (rate limit, overloaded) renders
    // the same `⎿  API Error:` chrome but is NOT the thinking-block
    // class. Those recover on their own / via the rate-limit watchdog,
    // so they must not be flagged as the wedged state.
    const rateLimit = [
      '  ⎿  API Error: 429 rate_limit_error: too many requests',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectsThinkingBlockError(rateLimit)).toBe(false)
  })

  it('is false when the phrase appears without the chrome glyph', () => {
    expect(detectsThinkingBlockError(ERROR_FULL_PHRASE_PROSE)).toBe(false)
  })

  it('is false when there is no idle footer (no live region to scope)', () => {
    // Without an idle footer the pane is busy or not a Claude surface;
    // there is no settled live tail to inspect, so we never flag error.
    const noFooter = [
      '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.',
      '✻ Combobulating… (12s · ↓ 480 tokens · esc to interrupt)',
    ].join('\n')
    expect(detectsThinkingBlockError(noFooter)).toBe(false)
  })

  it('is false on a stale error above the live tail', () => {
    expect(detectsThinkingBlockError(ERROR_DEEP_SCROLLBACK)).toBe(false)
  })

  it('is false when chrome and phrase are in different blocks', () => {
    // Benign 429 chrome + decoupled phrase prose below it: the phrase
    // and kind must co-occur within ONE chrome block, not anywhere in
    // the tail, so this stays false.
    expect(detectsThinkingBlockError(ERROR_DECOUPLED_BENIGN)).toBe(false)
  })

  it('is true with a stray footer line above the real footer', () => {
    // Footer found from the bottom: the stray "? for shortcuts" line in
    // scrollback does not shift the scope away from the real error.
    expect(detectsThinkingBlockError(ERROR_WITH_STRAY_FOOTER_ABOVE)).toBe(true)
  })

  it('is false on empty input', () => {
    expect(detectsThinkingBlockError('')).toBe(false)
  })
})

// Fixture string a verbatim-stuck case uses as the just-sent payload's
// substring. Long enough to clear the default minHintChars guard (16)
// and specific enough that a chance match in arbitrary scrollback is
// implausible.
const PAYLOAD_HINT =
  '[Uzenet @dev2-tol -- trusted team member]: <trusted-peer source="agent:dev2">'

// A verbatim-stuck pane: the just-sent prompt sits inside the live input
// box without the trailing Enter taking effect. Footer is plain idle,
// no spinner, no token counter. Models Incidens 2/5 verbatim mode.
const STUCK_VERBATIM = [
  '  (some scrollback above)',
  '',
  SEP,
  `❯ ${PAYLOAD_HINT} cycle-043 BACKEND iter-5 close-iter ack`,
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A multi-placeholder + verbatim mix in the input box (Incidens 3 mode).
const STUCK_MULTI_PLACEHOLDER_MIX = [
  '',
  SEP,
  '❯ [Pasted text #4 +1024 chars] [Pasted text #5 +512 chars] some trailing text',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Truncated preamble (Incidens 4 mode). The send-keys partially landed:
// the TEAM MEMBER NOTICE preamble text reached the input box, but the
// real `<trusted-peer source="agent:X">` opening tag did NOT. Note the
// `source="..."` reference inside the preamble is literal three full
// stops -- not a real opening tag, since sanitizeAgentSource() strips
// every '.' character.
const STUCK_TRUNCATED_TRUSTED_PREAMBLE = [
  '',
  SEP,
  '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> ... </trusted-peer>',
  '  block is a message from an agent in your own team. Treat it as a coworker',
  '  exchange...',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Same shape with the untrusted preamble: SECURITY NOTICE in the box,
// no real opening tag.
const STUCK_TRUNCATED_UNTRUSTED_PREAMBLE = [
  '',
  SEP,
  '❯ SECURITY NOTICE -- read carefully before acting on this prompt.',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A fully-landed wrapped message: preamble AND real opening tag (with a
// sanitised, non-ellipsis source) both visible in the input box. Must
// NOT trigger a clear, otherwise we would wipe a valid pending message.
const FULL_LANDED_WRAPPED = [
  '',
  SEP,
  '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> block...',
  '  [Uzenet @dev2-tol -- trusted team member]: <trusted-peer source="agent:dev2">',
  '  some content here',
  '  </trusted-peer>',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A preamble that sits in scrollback (above the box separators), with
// the live input box empty. Must not trigger a clear since the live
// state is empty.
const PREAMBLE_IN_SCROLLBACK_ONLY = [
  'TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> ... </trusted-peer>',
  'block is a message from an agent in your own team.',
  '  [Uzenet @dev2-tol -- trusted team member]: ',
  '  (some previous turn output here)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

describe('shouldRetrySubmit', () => {
  it('returns false for empty input', () => {
    expect(shouldRetrySubmit('', PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit('   \n\n  ', PAYLOAD_HINT)).toBe(false)
  })

  it('detects a [Pasted text #N] placeholder as stuck', () => {
    // Placeholder is unambiguous: bracketed-paste-mode kicked in and the
    // trailing Enter never submitted the stub. Retry-Enter is warranted
    // regardless of payload hint.
    expect(shouldRetrySubmit(PENDING_PASTE, '')).toBe(true)
    expect(shouldRetrySubmit(PENDING_PASTE, PAYLOAD_HINT)).toBe(true)
  })

  it('detects a multi-placeholder mixed-mode buffer as stuck', () => {
    // Long inputs can land as several `[Pasted text #N]` stubs followed
    // by verbatim text. Any single placeholder match is enough.
    expect(shouldRetrySubmit(STUCK_MULTI_PLACEHOLDER_MIX, PAYLOAD_HINT)).toBe(true)
  })

  it('detects the older-build placeholder (paste-again footer) as stuck', () => {
    // Regression: the older placeholder render has the `paste again to expand`
    // footer, not the idle footer, so the old footer-gate ordering returned
    // false here. The placeholder check now precedes the idle-footer gate.
    expect(shouldRetrySubmit(PENDING_PASTE_REALISTIC, '')).toBe(true)
    expect(shouldRetrySubmit(PENDING_PASTE_REALISTIC, PAYLOAD_HINT)).toBe(true)
  })

  it('detects the WRAPPED real-shape placeholder (normal idle footer) as stuck', () => {
    // The primary real-incident shape: wrapped stub + normal idle footer. The
    // single-space regex missed the wrap; the wrap-tolerant box-scoped check
    // now catches it so the recovery fires.
    expect(shouldRetrySubmit(PENDING_PASTE_WRAPPED_REAL_SHAPE, '')).toBe(true)
    expect(shouldRetrySubmit(PENDING_PASTE_WRAPPED_DIGIT_SPLIT, '')).toBe(true)
  })

  it('returns false when a stub is only quoted in scrollback (empty box)', () => {
    // False-positive guard: must not fire a clear-and-resend when the stub is
    // merely quoted above an empty input box.
    expect(shouldRetrySubmit(PASTE_ECHO_IN_SCROLLBACK_ONLY, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(PASTE_ECHO_IN_SCROLLBACK_ONLY, '')).toBe(false)
  })

  it('detects verbatim parked payload (footer idle, no spinner) as stuck', () => {
    // The payload substring sits in the live input box and the footer
    // shows bypass idle without any busy markers. Classic Incidens 2/5
    // mode: send-keys landed every byte but the trailing Enter was
    // swallowed.
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT)).toBe(true)
  })

  it('returns false when the pane is busy', () => {
    // Active spinner / tokens / esc-to-interrupt means the prompt is
    // being processed -- retrying Enter would inject an empty line into
    // the next turn's prompt.
    expect(shouldRetrySubmit(BUSY_FULL_FOOTER, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(BUSY_FOOTER_FRAME_GAP, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(BUSY_TOKENS_ONLY, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false on a clean idle pane with no parked input', () => {
    expect(shouldRetrySubmit(IDLE_BYPASS, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(IDLE_STRICT, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(IDLE_BACKGROUND_SHELLS, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false on a non-Claude-Code pane (no idle footer)', () => {
    expect(shouldRetrySubmit(NON_CLAUDE, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false when the operator-typed input does not contain the hint', () => {
    // The pane is typing-state but the parked text is something the
    // operator was typing manually, NOT the just-sent payload. We must
    // not retry Enter -- doing so would submit the operator's draft.
    expect(shouldRetrySubmit(TYPING_PARKED, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false when payloadHint is shorter than minHintChars', () => {
    // Short hints would false-positive on common UI substrings (e.g.
    // matching "OK" or a single word in the box). The caller must pass
    // a hint of at least the configured minimum length to opt into the
    // verbatim-detection path.
    const shortHint = 'short'
    expect(shouldRetrySubmit(STUCK_VERBATIM, shortHint)).toBe(false)
  })

  it('honours a custom minHintChars option', () => {
    // Caller can lower the threshold for deliberate use (e.g. a known
    // short-but-unique sentinel) by passing minHintChars explicitly.
    const hint = 'ack#7421'
    const stuck = [
      '',
      SEP,
      `❯ ${hint} pending submit`,
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldRetrySubmit(stuck, hint, { minHintChars: 8 })).toBe(true)
    // Default threshold rejects the same hint as too short.
    expect(shouldRetrySubmit(stuck, hint)).toBe(false)
  })

  it('does not match the verbatim hint when it only appears in scrollback', () => {
    // The payload substring is in the scrollback above the box (a
    // previous turn's echo), but the live input box is empty. No
    // retry -- the prompt already completed.
    const scrollbackOnly = [
      `  ${PAYLOAD_HINT} -- echoed from a previous turn`,
      '  (more scrollback)',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldRetrySubmit(scrollbackOnly, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false when no idle footer is present (pane state unknown)', () => {
    const noFooter = [
      `❯ ${PAYLOAD_HINT} text without a recognised footer`,
    ].join('\n')
    expect(shouldRetrySubmit(noFooter, PAYLOAD_HINT)).toBe(false)
  })
})

describe('shouldClearTruncatedPreamble', () => {
  it('returns false on empty input', () => {
    expect(shouldClearTruncatedPreamble('')).toBe(false)
  })

  it('detects truncated trusted-peer preamble in the live input box', () => {
    // TEAM MEMBER NOTICE preamble visible, no real opening tag. Caller
    // must Ctrl-U clear before the next send or trust semantics leak.
    expect(shouldClearTruncatedPreamble(STUCK_TRUNCATED_TRUSTED_PREAMBLE)).toBe(true)
  })

  it('detects truncated untrusted preamble in the live input box', () => {
    expect(shouldClearTruncatedPreamble(STUCK_TRUNCATED_UNTRUSTED_PREAMBLE)).toBe(true)
  })

  it('does NOT classify a fully-landed wrapped message as truncated', () => {
    // Preamble AND a real opening tag (sanitised source) both visible:
    // the wrapped content landed end-to-end, no clear needed.
    expect(shouldClearTruncatedPreamble(FULL_LANDED_WRAPPED)).toBe(false)
  })

  it('does NOT trigger when the preamble lives only in scrollback', () => {
    // Live input box is empty -- preamble is a post-turn artifact, not
    // a stale send. A clear would be pointless (and would waste a
    // Ctrl-U on an empty buffer, harmless but noisy in logs).
    expect(shouldClearTruncatedPreamble(PREAMBLE_IN_SCROLLBACK_ONLY)).toBe(false)
  })

  it('does NOT trigger on a clean idle pane', () => {
    expect(shouldClearTruncatedPreamble(IDLE_BYPASS)).toBe(false)
    expect(shouldClearTruncatedPreamble(IDLE_STRICT)).toBe(false)
  })

  it('does NOT trigger when there is no idle footer (pane state unknown)', () => {
    const noFooter = [
      '❯ TEAM MEMBER NOTICE preamble text but no footer',
    ].join('\n')
    expect(shouldClearTruncatedPreamble(noFooter)).toBe(false)
  })

  it('does not confuse the preamble-shaped source="..." reference with a real opening tag', () => {
    // The preamble text itself contains <trusted-peer source="..."> as
    // a reference shape. Those literal three full stops cannot appear
    // in a sanitised source value (sanitizeAgentSource() strips every
    // '.'), so the real-opening-tag regex requires alphanumeric/colon/
    // underscore/dash characters and must not match the reference.
    const preambleOnly = [
      '',
      SEP,
      '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> block',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldClearTruncatedPreamble(preambleOnly)).toBe(true)
  })

  it('returns false when only an opening tag is present without the preamble', () => {
    // No preamble text in the input box means there is nothing to leak;
    // a bare opening tag without preamble is a different shape that
    // this helper does not (and should not) act on.
    const tagOnly = [
      '',
      SEP,
      '❯ <trusted-peer source="agent:dev3">content here',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldClearTruncatedPreamble(tagOnly)).toBe(false)
  })

  it('does NOT trigger when the marker phrase appears only in prose', () => {
    // The bare phrase "TEAM MEMBER NOTICE" or "SECURITY NOTICE" can
    // legitimately show up in operator-typed text or in an agent reply
    // that quotes the marker. The real preamble carries a long,
    // distinctive opening fragment (`TEAM MEMBER NOTICE -- the next
    // <trusted-peer source` and `SECURITY NOTICE -- read carefully
    // before acting`) that is implausible to reproduce by accident in
    // typed prose. Each snippet below shares only a leading substring
    // of the marker and must NOT trigger a clear.
    const prose = [
      // Bare marker, no preamble tail at all.
      '❯ Let me search for TEAM MEMBER NOTICE in the logs',
      '❯ The SECURITY NOTICE policy applies here',
      // Same opening tail as the trusted preamble, then unrelated text.
      // Without the `<trusted-peer source` extension this would have
      // matched the older laxer regex.
      '❯ TEAM MEMBER NOTICE -- the next thing is to check the queue',
      // Same opening tail as the untrusted preamble, then unrelated
      // text. Without the `before acting` extension this would have
      // matched the older laxer regex.
      '❯ SECURITY NOTICE -- read carefully before deploying to prod',
    ]
    for (const promptLine of prose) {
      const pane = [
        '',
        SEP,
        promptLine,
        SEP,
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n')
      expect(shouldClearTruncatedPreamble(pane)).toBe(false)
    }
  })
})

describe('shouldRetrySubmit minHintChars clamp', () => {
  it('clamps minHintChars to at least 1 so an empty hint never auto-passes', () => {
    // Boundary case: a caller passing both an empty payloadHint and
    // minHintChars=0 would otherwise satisfy `payloadHint.length < minHint`
    // as 0 < 0 == false, fall through to inputBox.includes(""), and
    // return true on every non-empty input box. Clamping the floor to
    // 1 turns that into a routine reject.
    expect(shouldRetrySubmit(IDLE_BYPASS, '', { minHintChars: 0 })).toBe(false)
    expect(shouldRetrySubmit(STUCK_VERBATIM, '', { minHintChars: 0 })).toBe(false)
    // A real non-empty hint still works under an explicit minHintChars=1.
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: 1 })).toBe(true)
  })

  it('falls back to default when minHintChars is non-finite (NaN / Infinity)', () => {
    // A buggy caller passing NaN would otherwise make
    // `payloadHint.length < NaN` always false, silently disabling the
    // length guard and accepting any hint. Infinity would make the
    // same comparison always true, blocking the verbatim path forever.
    // Both cases must fall back to the default minimum (16) so the
    // helper degrades safely.
    expect(shouldRetrySubmit(STUCK_VERBATIM, 'x', { minHintChars: NaN })).toBe(false)
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: NaN })).toBe(true)
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: Infinity })).toBe(true)
  })

  it('rejects negative minHintChars by clamping to 1', () => {
    // A negative value (e.g. -5) would let any non-empty hint pass the
    // length guard, even a single-character one. Clamping to >= 1
    // forces at least a one-character hint to be present.
    expect(shouldRetrySubmit(STUCK_VERBATIM, '', { minHintChars: -5 })).toBe(false)
    // The verbatim path still works for a real-length hint with a
    // negative argument.
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: -5 })).toBe(true)
  })
})

describe('decideSubmitFollowup', () => {
  it('returns "give-up" when the pane capture failed', () => {
    // A null pane means we cannot tell whether the prompt landed; the
    // safest action is to stop retrying rather than fire a blind
    // Enter that might submit a different turn's draft.
    expect(decideSubmitFollowup(null, PAYLOAD_HINT, 0, 2)).toBe('give-up')
  })

  it('returns "done" when the pane is not stuck', () => {
    // shouldRetrySubmit-positive panes are the only ones that should
    // receive a follow-up Enter. A busy pane, a clean idle pane, and
    // a typing pane without the hint all return "done".
    expect(decideSubmitFollowup(BUSY_FULL_FOOTER, PAYLOAD_HINT, 0, 2)).toBe('done')
    expect(decideSubmitFollowup(IDLE_BYPASS, PAYLOAD_HINT, 0, 2)).toBe('done')
    expect(decideSubmitFollowup(TYPING_PARKED, PAYLOAD_HINT, 0, 2)).toBe('done')
  })

  it('returns "retry-enter" for VERBATIM stuck text while below the cap', () => {
    // Verbatim parked text (trailing Enter swallowed) submits on a plain
    // Enter, so the verbatim path still routes to retry-enter.
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 0, 2)).toBe('retry-enter')
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 1, 2)).toBe('retry-enter')
  })

  it('returns "clear-and-resend" for a paste placeholder while below the cap', () => {
    // A `[Pasted text #N]` placeholder is PROVEN not to submit on a plain
    // Enter (Enter only expands it to still-parked verbatim text), so it must
    // route to the clear-and-resend recovery, NOT retry-enter. Covers the
    // single-line, older-build, and wrapped real-shape placeholders.
    expect(decideSubmitFollowup(PENDING_PASTE, '', 0, 2)).toBe('clear-and-resend')
    expect(decideSubmitFollowup(PENDING_PASTE_REALISTIC, '', 0, 2)).toBe('clear-and-resend')
    expect(decideSubmitFollowup(PENDING_PASTE_WRAPPED_REAL_SHAPE, '', 0, 2)).toBe('clear-and-resend')
  })

  it('returns "done" when a stub is only quoted in scrollback (empty box)', () => {
    // False-positive guard at the decision layer: a quoted stub above an empty
    // box is not stuck, so no follow-up action fires.
    expect(decideSubmitFollowup(PASTE_ECHO_IN_SCROLLBACK_ONLY, PAYLOAD_HINT, 0, 2)).toBe('done')
  })

  it('returns "give-up" once attempts reach the cap', () => {
    // attempt === maxAttempts means we have already fired maxAttempts
    // extra Enters and the pane is still stuck. Bail rather than
    // burning more retries on a pane that refuses to flush.
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 2, 2)).toBe('give-up')
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 5, 2)).toBe('give-up')
  })

  it('returns "give-up" for a placeholder once attempts reach the cap', () => {
    // A placeholder that survived the clear-and-resend budget must bail too,
    // not loop forever clearing and re-sending.
    expect(decideSubmitFollowup(PENDING_PASTE_REALISTIC, '', 4, 4)).toBe('give-up')
    expect(decideSubmitFollowup(PENDING_PASTE, '', 2, 2)).toBe('give-up')
  })

  it('treats maxAttempts === 0 as "give-up on first stuck observation"', () => {
    // A caller that disabled retry by passing 0 still gets a clean
    // "give-up" branch (with the warn-log behaviour the loop attaches
    // to that action) rather than silently retrying.
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 0, 0)).toBe('give-up')
    // Done-state on a maxAttempts=0 pane still returns done -- there
    // is nothing to retry.
    expect(decideSubmitFollowup(IDLE_BYPASS, PAYLOAD_HINT, 0, 0)).toBe('done')
  })
})

describe('decidePaneErrorAlert', () => {
  const TH = { confirmMs: 120_000, dedupMs: 1_800_000, clearMs: 300_000 }
  const NONE = { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }

  it('does nothing when not in error and no active spell', () => {
    const d = decidePaneErrorAlert(false, NONE, 5000, TH)
    expect(d.alert).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('records first sighting without alerting (confirm window)', () => {
    const d = decidePaneErrorAlert(true, NONE, 10_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next.firstSeenAt).toBe(10_000)
    expect(d.next.lastAlertAt).toBe(null)
    expect(d.next.lastErrorAt).toBe(10_000)
  })

  it('does not alert while still inside the confirm window', () => {
    // First seen at t=0, now t=60s, confirm window 120s -> not yet.
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 0 }, 60_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next.firstSeenAt).toBe(0)
  })

  it('alerts once the confirm window elapses (first alert)', () => {
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 60_000 }, 120_000, TH)
    expect(d.alert).toBe(true)
    expect(d.next.firstSeenAt).toBe(0)
    expect(d.next.lastAlertAt).toBe(120_000)
  })

  it('suppresses repeat alerts inside the dedup window', () => {
    // Sustained error, last alert 10 min ago, dedup 30 min -> quiet.
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: 660_000 }, 720_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next.lastAlertAt).toBe(120_000)
  })

  it('re-alerts once the dedup window elapses', () => {
    // Last alert at t=120s, now t=120s+30min -> dedup elapsed.
    const now = 120_000 + 1_800_000
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: now - 60_000 }, now, TH)
    expect(d.alert).toBe(true)
    expect(d.next.lastAlertAt).toBe(now)
  })

  it('clears the spell after a sustained error-free gap', () => {
    // error stops, last error 6 min ago (> clearMs 5 min) -> clear.
    const d = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: 60_000 }, 420_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('starts a fresh spell after the cleared recovery', () => {
    // error -> sustained recovery (cleared) -> error again times its own
    // confirm window from the new sighting.
    const recovered = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: 60_000 }, 420_000, TH)
    expect(recovered.next).toEqual(NONE)
    const reappeared = decidePaneErrorAlert(true, recovered.next, 500_000, TH)
    expect(reappeared.alert).toBe(false)
    expect(reappeared.next.firstSeenAt).toBe(500_000)
  })

  it('holds the spell across a brief non-error blip (flapping capture)', () => {
    // A genuinely wedged but flapping session: error, then one non-error
    // tick (null capture / mid-flight busy) only 60s after the last
    // error (< clearMs). The spell must NOT reset, otherwise the confirm
    // window never elapses and the wedged session never alerts.
    const held = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 60_000 }, 120_000, TH)
    expect(held.alert).toBe(false)
    expect(held.next.firstSeenAt).toBe(0) // spell preserved
    // The next error tick is sustained from the original firstSeenAt and
    // alerts (confirm window elapsed), proving the flap did not starve it.
    const back = decidePaneErrorAlert(true, held.next, 180_000, TH)
    expect(back.alert).toBe(true)
  })

  it('never alerts on the first sighting even when confirmMs is 0', () => {
    // The first-sighting guard means an error must be observed on at
    // least two ticks before any alert, independent of confirmMs. A
    // single transient one-tick error never fires an alert.
    const zeroTh = { confirmMs: 0, dedupMs: 1_800_000, clearMs: 300_000 }
    const first = decidePaneErrorAlert(true, NONE, 1000, zeroTh)
    expect(first.alert).toBe(false)
    expect(first.next.firstSeenAt).toBe(1000)
    // Second tick with confirmMs=0 now alerts (sustained from tick 1).
    const second = decidePaneErrorAlert(true, first.next, 1001, zeroTh)
    expect(second.alert).toBe(true)
  })

  it('does not stall on backwards clock skew (future timestamp)', () => {
    // now jumps backwards (NTP correction): a stored firstSeenAt in the
    // future would drive the delta negative and stall. Instead restart
    // the spell from now rather than getting stuck never-alerting.
    const skewed = decidePaneErrorAlert(true, { firstSeenAt: 1_000_000, lastAlertAt: 1_000_000, lastErrorAt: 1_000_000 }, 500_000, TH)
    expect(skewed.alert).toBe(false)
    expect(skewed.next.firstSeenAt).toBe(500_000)
    expect(skewed.next.lastAlertAt).toBe(null)
  })
})

describe('stuckInputSignature', () => {
  it('returns a normalised signature for parked input', () => {
    const sig = stuckInputSignature(TYPING_PARKED)
    expect(sig).not.toBeNull()
    expect(sig).toContain('Valami amit a felhasznalo elkezdett geppelni')
    // Whitespace collapsed so a re-flow / cursor blink does not look new.
    expect(sig).not.toMatch(/\s{2,}/)
  })

  it('is null for an idle empty input box', () => {
    expect(stuckInputSignature(IDLE_BYPASS)).toBeNull()
  })

  it('is null for a busy pane', () => {
    expect(stuckInputSignature(BUSY_FULL_FOOTER)).toBeNull()
  })

  it('is null for a paste placeholder (treated as busy, not parked text)', () => {
    expect(stuckInputSignature(PENDING_PASTE)).toBeNull()
  })

  it('ignores a ❯ caret left in scrollback', () => {
    expect(stuckInputSignature(IDLE_WITH_SCROLLBACK_CARET)).toBeNull()
  })
})

describe('decideStuckInputRecovery', () => {
  const TH = { confirmMs: 10_000, dedupMs: 12_000, maxAttempts: 3 }
  const NONE = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0, giveUpAlerted: false }

  it('does nothing when nothing is parked and no spell is active', () => {
    const d = decideStuckInputRecovery(null, NONE, 5_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('records the first sighting without recovering (confirm window)', () => {
    const d = decideStuckInputRecovery('msg-A', NONE, 10_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual({ parkedSig: 'msg-A', firstSeenAt: 10_000, lastRecoverAt: null, attempts: 0 })
  })

  it('does not recover while still inside the confirm window', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: null, attempts: 0 }
    const d = decideStuckInputRecovery('msg-A', prev, 9_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.firstSeenAt).toBe(0)
  })

  it('recovers once the same text persists past the confirm window', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: null, attempts: 0 }
    const d = decideStuckInputRecovery('msg-A', prev, 10_000, TH)
    expect(d.recover).toBe(true)
    expect(d.next.attempts).toBe(1)
    expect(d.next.lastRecoverAt).toBe(10_000)
    expect(d.next.firstSeenAt).toBe(0)
  })

  it('restarts the confirm window when the parked text changes', () => {
    // A new/different message arriving (or text still being composed)
    // must not inherit the prior spell's elapsed time.
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: null, attempts: 0 }
    const d = decideStuckInputRecovery('msg-B', prev, 9_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual({ parkedSig: 'msg-B', firstSeenAt: 9_000, lastRecoverAt: null, attempts: 0 })
  })

  it('suppresses a repeat recovery inside the dedup window', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 10_000, attempts: 1 }
    const d = decideStuckInputRecovery('msg-A', prev, 18_000, TH) // 8s < 12s dedup
    expect(d.recover).toBe(false)
    expect(d.next.attempts).toBe(1)
  })

  it('recovers again once the dedup window elapses', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 10_000, attempts: 1 }
    const d = decideStuckInputRecovery('msg-A', prev, 22_000, TH) // 12s >= dedup
    expect(d.recover).toBe(true)
    expect(d.next.attempts).toBe(2)
    expect(d.next.lastRecoverAt).toBe(22_000)
  })

  it('gives up after maxAttempts without further recoveries', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 40_000, attempts: 3 }
    const d = decideStuckInputRecovery('msg-A', prev, 60_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.attempts).toBe(3)
  })

  it('clears the spell when the input box empties', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 10_000, attempts: 1 }
    const d = decideStuckInputRecovery(null, prev, 30_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('does not stall on backwards clock skew (future timestamp)', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 1_000_000, lastRecoverAt: 1_000_000, attempts: 1 }
    const d = decideStuckInputRecovery('msg-A', prev, 500_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.firstSeenAt).toBe(500_000)
    expect(d.next.lastRecoverAt).toBe(null)
    expect(d.next.attempts).toBe(0)
  })

  it('preserves giveUpAlerted across backwards clock skew within the SAME spell', () => {
    // Regression: a clock jump within the same spell used to silently drop
    // giveUpAlerted (the "Backwards clock skew" branch returned a fresh object
    // without it), letting the watcher's per-spell alert gate re-open and the
    // give-up alert fire a second time once the spell reached maxAttempts again.
    const prev = { parkedSig: 'msg-A', firstSeenAt: 1_000_000, lastRecoverAt: 1_000_000, attempts: 5, giveUpAlerted: true }
    const d = decideStuckInputRecovery('msg-A', prev, 500_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.firstSeenAt).toBe(500_000)
    expect(d.next.lastRecoverAt).toBe(null)
    expect(d.next.attempts).toBe(0)
    expect(d.next.giveUpAlerted).toBe(true)
  })
})

describe('parkedChannelInput (stuck channel-block gate + truncation guard)', () => {
  const SEP = '─'.repeat(80)
  const wrap = (boxLines: string[]) =>
    ['', SEP, ...boxLines, SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

  it('returns null when the pane is idle (nothing parked)', () => {
    expect(parkedChannelInput(wrap(['❯ ']))).toBeNull()
  })

  it('returns null for a HUMAN hand-typed draft (no <channel> marker) -- never touched', () => {
    expect(parkedChannelInput(wrap(['❯ Valami amit a felhasznalo elkezdett geppelni']))).toBeNull()
  })

  it('extracts a COMPLETE single-line parked channel block with chat_id', () => {
    const pane = wrap(['❯ <channel source="plugin:telegram:telegram" chat_id="1268077055" message_id="999" ts="2026-06-05T10:00:00Z">Szia, mi a helyzet?</channel>'])
    const r = parkedChannelInput(pane)
    expect(r).not.toBeNull()
    expect(r!.complete).toBe(true)
    expect(r!.chatId).toBe('1268077055')
    expect(r!.block).toContain('</channel>')
    expect(r!.block).toContain('chat_id="1268077055"')
  })

  it('reconstructs a wrapped multi-line block when chat_id stays intact', () => {
    // Terminal wrap splits message_id but NOT chat_id -> still recoverable.
    const pane = wrap([
      '❯ <channel source="plugin:telegram:telegram" chat_id="1268077055" mess',
      'age_id="999" ts="2026-06-05T10:00:00Z">Hosszu uzenet ami tobb sorba',
      'tordelodott a terminal szelessegen.</channel>',
    ])
    const r = parkedChannelInput(pane)
    expect(r).not.toBeNull()
    expect(r!.complete).toBe(true)
    expect(r!.chatId).toBe('1268077055')
  })

  it('flags complete:false when the closing </channel> scrolled off (truncated)', () => {
    const pane = wrap(['❯ <channel source="plugin:telegram:telegram" chat_id="1268077055" ts="2026-06-05T10:00:00Z">Az uzenet vege lescrollozott es nincs zaro tag'])
    const r = parkedChannelInput(pane)
    expect(r).not.toBeNull()
    expect(r!.complete).toBe(false)
    expect(r!.chatId).toBeNull()
  })

  it('flags complete:false when a wrap corrupts chat_id with embedded whitespace', () => {
    // Wrap landed INSIDE the chat_id value -> "126 8077055" after collapse.
    const pane = wrap([
      '❯ <channel source="plugin:telegram:telegram" chat_id="126',
      '8077055" message_id="999">Test</channel>',
    ])
    const r = parkedChannelInput(pane)
    expect(r).not.toBeNull()
    expect(r!.complete).toBe(false) // refuse re-inject; caller stays on Enter
    expect(r!.chatId).toBeNull()
  })

  it('returns null for a non-plugin channel marker (defensive)', () => {
    expect(parkedChannelInput(wrap(['❯ <channel source="other:thing" chat_id="1">x</channel>']))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Contract tests: esc-to-interrupt live-region scoping (port from kovesdan/marveen)
//
// Root cause: a watchdog report or log output that quotes "esc to interrupt"
// anywhere in the scrollback permanently classified an otherwise-idle session
// as busy (81-retry starvation incident). The fix scopes the phrase check to
// the bottom LIVE_FOOTER_REGION_LINES of the pane.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Contract tests: shouldRetrySubmit footer-region scoping
//
// shouldRetrySubmit applies the same esc-to-interrupt footer-region scope as
// detectPaneState (lines 390-392 of pane-state.ts). A pane whose TRANSCRIPT
// prose quotes "esc to interrupt" in scrollback but whose footer is idle
// must NOT be treated as busy by shouldRetrySubmit -- if stuck content is
// present in the input box the function must return true (idle-path).
//
// Mental-revert: if the footer-scoped check in shouldRetrySubmit were replaced
// by a whole-pane scan (e.g. `BUSY_ESC_TO_INTERRUPT_RX.test(pane)` instead of
// `BUSY_ESC_TO_INTERRUPT_RX.test(retryFooterRegion)`), the busy branch fires
// and shouldRetrySubmit returns false -- making this test fail.
// ---------------------------------------------------------------------------
describe('shouldRetrySubmit: esc-to-interrupt scoped to live footer region', () => {
  const SEP_R = '─'.repeat(80)
  const HINT = '[Uzenet @dev2-tol -- trusted team member]: <trusted-peer source="agent:dev2">'

  it('returns true (stuck) when "esc to interrupt" appears only in scrollback and the input box holds the payload', () => {
    // The transcript prose quotes "esc to interrupt" (e.g. a watchdog log
    // line) but the footer is plain idle and the live input box contains the
    // just-sent payload. With whole-pane scanning the busy check would fire
    // and return false (incorrectly skipping the retry). With footer-region
    // scoping the busy path is not triggered, so the stuck input is detected
    // and shouldRetrySubmit returns true.
    const pane = [
      '  [watchdog]: waited for esc to interrupt before giving up',
      '  (some other scrollback)',
      '',
      SEP_R,
      `❯ ${HINT} cycle-077 BACKEND iter-1 close-iter ack`,
      SEP_R,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldRetrySubmit(pane, HINT)).toBe(true)
  })

  it('returns false (busy, no retry) when "esc to interrupt" is in the live footer (active turn)', () => {
    // Confirms that a real active-turn footer with "esc to interrupt" appended
    // still prevents a spurious retry -- the region-scoped check fires on the
    // footer itself, so shouldRetrySubmit correctly returns false.
    const pane = [
      '',
      SEP_R,
      `❯ ${HINT} cycle-077`,
      SEP_R,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    expect(shouldRetrySubmit(pane, HINT)).toBe(false)
  })
})

describe('detectPaneState: esc-to-interrupt scoped to live footer region', () => {
  const SEP_R = '─'.repeat(80)

  it('classifies as idle when "esc to interrupt" appears only in scrollback prose', () => {
    // A watchdog report or tool-call output that QUOTES the phrase somewhere
    // above the live input box. With whole-pane scanning this would pin the
    // session as busy forever; scoped to the footer region it is correctly idle.
    const pane = [
      '  [watchdog report]: session was busy, waiting for esc to interrupt signal',
      '  (scrollback content continues)',
      '',
      SEP_R,
      '❯ ',
      SEP_R,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('classifies as busy when "esc to interrupt" appears in the footer line (live turn)', () => {
    // The real busy signal: Claude Code appends "· esc to interrupt" to the
    // bypass-mode footer during an active turn. Must still be caught.
    const pane = [
      '',
      SEP_R,
      '❯ ',
      SEP_R,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })
})

describe('parkedInputText', () => {
  const SEP2 = '─'.repeat(80)
  const TYPING_PARKED2 = [
    '', SEP2,
    '❯ Valami amit a felhasznalo elkezdett geppelni, meg nem kuldte el',
    SEP2,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
  const IDLE_EMPTY = [
    '', SEP2, '❯ ', SEP2,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
  // A long inter-agent message wrapped across two input-box lines by the TUI.
  const WRAPPED_PARKED = [
    '', SEP2,
    '❯ [Uzenet @system-tol]: Uj csapattag erkezett: balazsmarveenja. Udv',
    '  neki ha legkozelebb beszeltek!',
    SEP2,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')

  it('returns the parked input text when typing', () => {
    expect(parkedInputText(TYPING_PARKED2)).toBe(
      'Valami amit a felhasznalo elkezdett geppelni, meg nem kuldte el',
    )
  })

  it('returns null for an empty (idle) input box', () => {
    expect(parkedInputText(IDLE_EMPTY)).toBe(null)
  })

  it('returns null when the pane is not Claude Code', () => {
    expect(parkedInputText('user@host ~ $ ls\nREADME.md')).toBe(null)
  })

  it('collapses terminal-wrapped lines into a single submittable line', () => {
    expect(parkedInputText(WRAPPED_PARKED)).toBe(
      '[Uzenet @system-tol]: Uj csapattag erkezett: balazsmarveenja. Udv neki ha legkozelebb beszeltek!',
    )
  })
})

describe('parked input rendered with a non-breaking space (U+00A0) after ❯', () => {
  // Live Claude Code panes render a NON-BREAKING SPACE (U+00A0), not an
  // ASCII space, between the ❯ prompt glyph and parked (delivered-but-not-
  // yet-submitted) text. Byte-for-byte the prompt line reads
  //   e2 9d af (❯)  c2 a0 (NBSP)  <text>
  // The ASCII-space form only shows up in scrollback for already-submitted
  // lines. The original PARKED_INPUT_RX `/❯[ \t]+\S/` accepted only ASCII
  // space or tab after the glyph, so an NBSP-rendered parked box fell
  // through to 'idle'. And because every stuck-input recovery helper
  // (stuckInputSignature, parkedChannelInput, parkedInputText) gates on
  // detectPaneState === 'typing', that single miss took the whole recovery
  // chain down: the delivered message stranded in the box forever, no
  // recovery Enter was ever sent. Verified live 2026 on real captured panes.
  const NBSP = '\u00a0'
  const NBSP_PARKED = [
    '', SEP,
    `❯${NBSP}[Uzenet @dev2-tol]: please re-run the merge once CI is green`,
    SEP,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
  // The same message with an ordinary ASCII space, so the fix is proven to
  // keep the pre-existing form working rather than swap one gap for another.
  const ASCII_PARKED = [
    '', SEP,
    '❯ [Uzenet @dev2-tol]: please re-run the merge once CI is green',
    SEP,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')

  it('classifies an NBSP-prompted parked box as typing, not idle', () => {
    expect(detectPaneState(NBSP_PARKED)).toBe('typing')
  })

  it('still classifies the ASCII-space parked box as typing (no regression)', () => {
    expect(detectPaneState(ASCII_PARKED)).toBe('typing')
  })

  it('merges an NBSP-parked box to busy when mergeTypingAsBusy is set', () => {
    expect(detectPaneState(NBSP_PARKED, { mergeTypingAsBusy: true })).toBe('busy')
  })

  it('does not report an NBSP-parked pane as ready for a new prompt', () => {
    expect(isReadyForPrompt(NBSP_PARKED)).toBe(false)
  })

  it('revives the stuck-input recovery chain (signature is non-null)', () => {
    expect(stuckInputSignature(NBSP_PARKED)).not.toBe(null)
  })

  it('recovers the parked text with the ❯ prompt and NBSP stripped', () => {
    expect(parkedInputText(NBSP_PARKED)).toBe(
      '[Uzenet @dev2-tol]: please re-run the merge once CI is green',
    )
  })

  // The production-critical stranding path: an inbound plugin notification
  // (Telegram / inter-agent <channel> block) delivered into the box but not
  // submitted, rendered with the NBSP gap. This is the exact shape that
  // strands in the wild, so lock that parkedChannelInput recovers it intact.
  it('recovers an NBSP-prompted parked CHANNEL block with the correct chat_id', () => {
    const pane = [
      '', SEP,
      `❯${NBSP}<channel source="plugin:telegram:telegram" chat_id="1268077055" message_id="999" ts="2026-06-05T10:00:00Z">message body</channel>`,
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    const r = parkedChannelInput(pane)
    expect(r).not.toBeNull()
    expect(r!.complete).toBe(true)
    expect(r!.chatId).toBe('1268077055')
  })

  // Real stranded messages are long and the TUI wraps them across input-box
  // lines. Lock that NBSP + terminal-wrap collapse to one submittable line.
  it('collapses a terminal-wrapped NBSP-parked message into one submittable line', () => {
    const pane = [
      '', SEP,
      `❯${NBSP}[Uzenet @dev3-tol]: please review the latest changes when you`,
      '  have a moment and re-run the merge once CI is green',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('typing')
    expect(parkedInputText(pane)).toBe(
      '[Uzenet @dev3-tol]: please review the latest changes when you have a moment and re-run the merge once CI is green',
    )
  })

  // The idle footer has two arms (bypass-permissions and the strict
  // `? for shortcuts`). Lock NBSP detection under the strict arm too.
  it('classifies an NBSP-parked box as typing under the strict shortcuts footer', () => {
    const pane = [
      '', SEP,
      `❯${NBSP}[Uzenet @dev2-tol]: ping`,
      SEP,
      '  ? for shortcuts',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('typing')
  })
})

describe('detectsBlockingMenu', () => {
  // The real /mcp "Manage MCP servers" modal that wedged the main channels
  // session for ~6h (2026-06-12). The input box is gone; the footer shows the
  // navigate/confirm/cancel hints instead of the permission footer.
  const MCP_MENU = [
    '   Manage MCP servers',
    '   5 servers',
    '',
    '     claude.ai',
    '   ❯ claude.ai Canva · ✔ connected · 39 tools',
    '     claude.ai Google Calendar · ✔ connected · 8 tools',
    '     claude.ai MailerLite · △ needs authentication',
    '',
    '   https://code.claude.com/docs/en/mcp for help',
    '   ↑/↓ to navigate · Enter to confirm · Esc to cancel',
  ].join('\n')

  // A single-screen modal that only offers Esc to exit (no navigation row).
  const ESC_ONLY_MODAL = [
    '   Some dialog title',
    '   body text here',
    '',
    '   Press Esc to exit',
  ].join('\n')

  it('detects the /mcp server-manager modal', () => {
    expect(detectsBlockingMenu(MCP_MENU)).toBe(true)
  })

  it('detects an esc-only modal with no navigation row', () => {
    expect(detectsBlockingMenu(ESC_ONLY_MODAL)).toBe(true)
  })

  it('is false for a normal idle prompt (bypass/strict)', () => {
    expect(detectsBlockingMenu(IDLE_BYPASS)).toBe(false)
    expect(detectsBlockingMenu(IDLE_STRICT)).toBe(false)
  })

  it('is false for a busy turn even if it renders esc-to-interrupt', () => {
    expect(detectsBlockingMenu(BUSY_FULL_FOOTER)).toBe(false)
    expect(detectsBlockingMenu(BUSY_TOKENS_ONLY)).toBe(false)
  })

  it('is false for an empty pane', () => {
    expect(detectsBlockingMenu('')).toBe(false)
    expect(detectsBlockingMenu('   \n  ')).toBe(false)
  })

  it('does not trigger on a reply that merely quotes menu chrome above a live prompt', () => {
    const quoted = [
      '  Tipp: a /mcp menuben az "Esc to cancel" sorral lepsz ki.',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectsBlockingMenu(quoted)).toBe(false)
  })
})

describe('detectsPastePlaceholder', () => {
  it('detects the `[Pasted text #N +X chars]` stub', () => {
    expect(detectsPastePlaceholder(PENDING_PASTE)).toBe(true)
  })

  it('detects the bare `[Pasted text #N]` stub (no +X chars suffix)', () => {
    // The older build emits the bare shape (with `paste again to expand`
    // footer); both stub shapes must match regardless of the footer.
    expect(detectsPastePlaceholder(PENDING_PASTE_REALISTIC)).toBe(true)
  })

  it('detects the WRAPPED stub (real shape: line break between `[Pasted text` and `#N`)', () => {
    // The primary real-incident case: a long input wraps so the stub straddles
    // a line break, and the footer is the NORMAL idle footer (no `paste again
    // to expand`). The single-space regex missed this on 2 of 3 real incidents.
    expect(detectsPastePlaceholder(PENDING_PASTE_WRAPPED_REAL_SHAPE)).toBe(true)
  })

  it('detects the wrapped stub when the DIGITS straddle the line break', () => {
    // `#` at the end of one line, the digit at the start of the next.
    expect(detectsPastePlaceholder(PENDING_PASTE_WRAPPED_DIGIT_SPLIT)).toBe(true)
  })

  it('is false when a stub appears ONLY in an upper reply line (scoped to the box)', () => {
    // False-positive guard (the confirmed bug): a `[Pasted text #N]` quoted in
    // scrollback / a reply while the live input box is empty must NOT trigger a
    // destructive clear-and-resend on a healthy idle agent.
    expect(detectsPastePlaceholder(PASTE_ECHO_IN_SCROLLBACK_ONLY)).toBe(false)
  })

  it('detects a multi-stub mixed buffer', () => {
    expect(detectsPastePlaceholder(STUCK_MULTI_PLACEHOLDER_MIX)).toBe(true)
  })

  it('is false on a clean idle pane', () => {
    expect(detectsPastePlaceholder(IDLE_BYPASS)).toBe(false)
    expect(detectsPastePlaceholder(IDLE_STRICT)).toBe(false)
  })

  it('is false on a busy pane', () => {
    expect(detectsPastePlaceholder(BUSY_FULL_FOOTER)).toBe(false)
    expect(detectsPastePlaceholder(BUSY_TOKENS_ONLY)).toBe(false)
  })

  it('is false on verbatim parked text (no stub)', () => {
    expect(detectsPastePlaceholder(STUCK_VERBATIM)).toBe(false)
    expect(detectsPastePlaceholder(TYPING_PARKED)).toBe(false)
  })

  it('is false on an empty / whitespace pane', () => {
    expect(detectsPastePlaceholder('')).toBe(false)
    expect(detectsPastePlaceholder('   \n  ')).toBe(false)
  })

  it('does NOT key on the `paste again to expand` hint alone', () => {
    // The hint LINGERS for a frame after the message submits (box already
    // empty, stub gone). Keying on it would false-positive a freshly-
    // submitted pane as still stuck. Only the `[Pasted text #N]` stub counts.
    const submittedButHintLingers = [
      '  ⏺ Done.',
      '',
      SEP,
      '❯ ',
      SEP,
      '  paste again to expand',
    ].join('\n')
    expect(detectsPastePlaceholder(submittedButHintLingers)).toBe(false)
  })

  it('matches the stub when it sits inside the live input box', () => {
    // Scoped to the box: a stub on the prompt line (between the separators) is
    // a genuine parked placeholder and must match, regardless of whether the
    // footer is the normal idle footer or `paste again to expand`.
    const stubInBox = [
      'some preceding line',
      SEP,
      '❯ leading text [Pasted text #7] trailing text',
      SEP,
      '  paste again to expand',
    ].join('\n')
    expect(detectsPastePlaceholder(stubInBox)).toBe(true)
  })
})

describe('parkedInputRowCount', () => {
  it('returns 0 for an empty input box (bare prompt)', () => {
    expect(parkedInputRowCount(IDLE_BYPASS)).toBe(0)
    expect(parkedInputRowCount(BUSY_FULL_FOOTER)).toBe(0)
  })

  it('returns 0 when there is no input box at all', () => {
    expect(parkedInputRowCount('just scrollback text\nno separators here')).toBe(0)
  })

  it('returns 1 for a single-row parked input', () => {
    expect(parkedInputRowCount(TYPING_PARKED)).toBe(1)
    expect(parkedInputRowCount(PENDING_PASTE)).toBe(1)
  })

  it('counts every visual row of a wrapped multi-row parked input', () => {
    // A wrapped message occupying 3 box-interior rows; a bare Enter here would
    // insert a newline instead of submitting.
    const multiRow = [
      '',
      SEP,
      '❯ first line of a long parked message that wraps across',
      '  several visual rows inside the input box and would not',
      '  submit on a bare Enter',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedInputRowCount(multiRow)).toBe(3)
  })
})

describe('submitLanded', () => {
  // The exact text parked before the submit attempt.
  const parkedSig = stuckInputSignature(TYPING_PARKED) as string

  it('captures a non-empty signature from the parked fixture', () => {
    expect(parkedSig).toBeTruthy()
  })

  it('is false when the identical signature is still parked', () => {
    expect(submitLanded(parkedSig, TYPING_PARKED)).toBe(false)
  })

  it('is true when the box cleared (pane went idle)', () => {
    expect(submitLanded(parkedSig, IDLE_BYPASS)).toBe(true)
  })

  it('is true when the agent started processing (pane went busy)', () => {
    expect(submitLanded(parkedSig, BUSY_FULL_FOOTER)).toBe(true)
  })

  it('is true when different text is now parked', () => {
    expect(submitLanded(parkedSig, PENDING_PASTE)).toBe(true)
  })

  it('is false when there is no after-capture (null)', () => {
    expect(submitLanded(parkedSig, null)).toBe(false)
  })
})

// Fresh-session / welcome-screen layout (Claude Code logo + model line + cwd,
// the input box framed by two ──── rules, ❯ prefix, NO footer). Modelled on a
// real captured stuck pane (store/qwen-welcome-stuck-fixture.txt) where a
// delivered multi-row message parked before any footer rendered, and the whole
// recovery stack went blind (liveInputBox null -> detectPaneState 'unknown').
const WELCOME_STUCK = [
  '',
  ' ▐▛███▜▌   Claude Code v2.1.170',
  '▝▜█████▛▘  qwen3.6:27b-192k with high effort · API Usage Billing',
  '  ▘▘ ▝▝    ~/ClaudeClaw/agents/qwen',
  '',
  '',
  SEP,
  '❯ kepet: /Users/marvin/workspace/aahe486-screenshot.png',
  '  Olvasd be a Read tool-lal a kepfajlt, majd mondd meg: (1) mi ez az',
  '  alkalmazas, (2) a tablazat konkret ertekei. Roviden a vegeredmenyt.',
  '  </trusted-peer>',
  SEP,
  '',
].join('\n')

describe('footer-less welcome-screen parked input', () => {
  it('classifies the parked box as typing (not unknown)', () => {
    expect(detectPaneState(WELCOME_STUCK)).toBe('typing')
  })

  it('mergeTypingAsBusy folds the footer-less parked box into busy', () => {
    expect(detectPaneState(WELCOME_STUCK, { mergeTypingAsBusy: true })).toBe('busy')
  })

  it('stuckInputSignature recovers a non-null signature', () => {
    const sig = stuckInputSignature(WELCOME_STUCK)
    expect(sig).not.toBeNull()
    expect(sig).toContain('kepet')
  })

  it('parkedInputText returns the collapsed multi-row message (not empty)', () => {
    const t = parkedInputText(WELCOME_STUCK)
    expect(t).not.toBeNull()
    expect(t).not.toBe('')
    expect(t).toContain('Olvasd be')
  })

  it('parkedInputRowCount counts every wrapped row (> 1 on a real wedge)', () => {
    expect(parkedInputRowCount(WELCOME_STUCK)).toBe(4)
    expect(parkedInputRowCount(WELCOME_STUCK)).toBeGreaterThan(1)
  })

  it('submitLanded fires once the welcome wedge clears to an idle pane', () => {
    // Full P1 -> P2 chain on the real wedge: detection sees the footer-less
    // parked box (sig != null), and after the message submits the pane is no
    // longer that signature -> submitLanded true. This is what tells the
    // recovery ladder the resubmit actually landed.
    const sig = stuckInputSignature(WELCOME_STUCK)
    expect(sig).not.toBeNull()
    expect(submitLanded(sig as string, IDLE_BYPASS)).toBe(true)
  })

  it('does NOT mistake a scrollback ──── pair without a ❯ box for input', () => {
    const noBox = ['some scrollback line', SEP, 'plain text, no prompt glyph', SEP, ''].join('\n')
    expect(detectPaneState(noBox)).toBe('unknown')
    expect(parkedInputRowCount(noBox)).toBe(0)
  })
})

describe('paneShowsContextSaturation', () => {
  // Real capture shape observed live: an idle, ready-looking footer with the
  // saturation banner one line above it — the combination that lets a
  // saturated session keep silently accepting new dispatches.
  const CTX_SAT_IDLE = [
    '  some prior assistant output',
    '',
    '✻ Cooked for 3m 7s',
    '                                                              100% context used',
    SEP,
    '❯ ',
    SEP,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')

  it('detects the saturation banner on an otherwise-idle pane', () => {
    expect(detectPaneState(CTX_SAT_IDLE)).toBe('idle') // sanity: still reads as idle
    expect(paneShowsContextSaturation(CTX_SAT_IDLE)).toBe(true)
  })

  it('is false on a normal idle pane', () => {
    expect(paneShowsContextSaturation(IDLE_BYPASS)).toBe(false)
    expect(paneShowsContextSaturation(IDLE_STRICT)).toBe(false)
  })

  it('is false on a normal busy pane (no false alarm mid-turn)', () => {
    expect(paneShowsContextSaturation(BUSY_FULL_FOOTER)).toBe(false)
  })

  it('does NOT misfire on a scrollback quote of the same phrase', () => {
    const quoted = [
      '  QA report: the watchdog now greps for "100% context used" in the footer.',
      '  This is a scrollback quote, not the live indicator.',
      ...Array.from({ length: 10 }, () => '  more scrollback padding'),
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(paneShowsContextSaturation(quoted)).toBe(false)
  })

  it('is false on empty/null-ish input', () => {
    expect(paneShowsContextSaturation('')).toBe(false)
    expect(paneShowsContextSaturation('   \n  ')).toBe(false)
  })
})

describe('parkedPasteSignature (stuck [Pasted text #N] recovery)', () => {
  it('returns a stable signature for a parked placeholder (current build, idle footer)', () => {
    const sig = parkedPasteSignature(PENDING_PASTE)
    expect(sig).not.toBeNull()
    expect(sig).toContain('[Pasted text #1')
  })

  it('recovers the older build shape too (paste again to expand, no idle footer)', () => {
    // The 'typing'-gated stuckInputSignature is null here (placeholder reads as
    // busy), which is exactly the gap this function fills.
    expect(stuckInputSignature(PENDING_PASTE_REALISTIC)).toBeNull()
    expect(parkedPasteSignature(PENDING_PASTE_REALISTIC)).not.toBeNull()
  })

  it('recovers the real wrapped-stub production shape', () => {
    expect(parkedPasteSignature(PENDING_PASTE_WRAPPED_REAL_SHAPE)).not.toBeNull()
    expect(parkedPasteSignature(PENDING_PASTE_WRAPPED_DIGIT_SPLIT)).not.toBeNull()
  })

  it('is null when NO placeholder is parked (plain typing / idle / empty)', () => {
    expect(parkedPasteSignature(TYPING_PARKED)).toBeNull()
    expect(parkedPasteSignature('')).toBeNull()
    expect(parkedPasteSignature('   \n  ')).toBeNull()
  })

  it('does NOT misfire on a placeholder quoted only in scrollback', () => {
    expect(parkedPasteSignature(PASTE_ECHO_IN_SCROLLBACK_ONLY)).toBeNull()
  })

  it('is null while a live busy indicator is present (genuine in-progress paste)', () => {
    // Placeholder in the box AND a live spinner/token line just above it: the
    // turn is actually running, so recovery must NOT pre-empt it.
    const busyPaste = [
      '  Beaming… (12s · ↓ 3.1k tokens · esc to interrupt)',
      SEP,
      '❯ [Pasted text #7 +512 chars]',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedPasteSignature(busyPaste)).toBeNull()
  })

  it('is null when a token-counter busy tail is present without a spinner label', () => {
    const busyTail = [
      '  (52s · ↓ 2.6k tokens · esc to interrupt)',
      SEP,
      '❯ [Pasted text #9]',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedPasteSignature(busyTail)).toBeNull()
  })

  it('sanitized real incident shape: finished turn + parked paste -> recoverable', () => {
    // Mirrors the observed Aura capture: a past-tense "Baked for Ns" stamp (NOT
    // a live busy indicator) above the idle hint, with the scheduled-task notice
    // collapsed into a paste stub in the box.
    const auraShape = [
      '● Kihagytam a delelotti nudge-ot, mert ma mar boven volt interakcio.',
      '',
      '✻ Baked for 33s',
      '                    new task? /clear to save 108.3k tokens',
      SEP,
      '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="..."> [Pasted text',
      '  #2 +1 lines]',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(stuckInputSignature(auraShape)).toBeNull()
    expect(parkedPasteSignature(auraShape)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// stripGhostSuggestion: dim (SGR 2) hint removal from a coloured capture.
//
// The function collapses a `tmux capture-pane -e -p` coloured stream into a
// plain-text equivalent of `capture-pane -p` MINUS any text rendered with SGR
// dim (faint) intensity. The dim-text discriminator is the load-bearing fix
// for the 2026-06-26 phantom prompt-injection: Claude Code's empty-input-box
// autocomplete hint renders in dim, and a plain capture read would otherwise
// treat it as parked input and re-submit the hint as if the operator typed it.
// ---------------------------------------------------------------------------
describe('stripGhostSuggestion', () => {
  it('returns empty string for empty input', () => {
    expect(stripGhostSuggestion('')).toBe('')
  })

  it('passes through plain text unchanged', () => {
    expect(stripGhostSuggestion('plain old text')).toBe('plain old text')
  })

  it('drops text rendered with SGR 2 (dim/faint) inside an ESC[...m sequence', () => {
    // The classic phantom-prompt shape: dim autocomplete hint between the �
    // and the next prompt glyph. After stripping, only the prompt and trailing
    // space remain -- no ghost text.
    const coloured = '❯ \x1b[2mTry refactor\x1b[0m '
    expect(stripGhostSuggestion(coloured)).toBe('❯  ')
  })

  it('keeps normal-intensity text inside the same stream', () => {
    // The SGR 2 segment is dropped, but SGR 0 (reset) text after it stays.
    const coloured = 'before\x1b[2mdim\x1b[0mafter'
    expect(stripGhostSuggestion(coloured)).toBe('beforeafter')
  })

  it('strips dim across multiple consecutive dim sequences', () => {
    const coloured = '\x1b[2mfirst\x1b[2msecond\x1b[0m visible'
    expect(stripGhostSuggestion(coloured)).toBe(' visible')
  })

  it('strips dim text delimited by SGR 22 (normal intensity, not SGR 0)', () => {
    // SGR 22 explicitly cancels dim/faint. Either reset must end the dim region.
    const coloured = '\x1b[2mhidden\x1b[22mvisible'
    expect(stripGhostSuggestion(coloured)).toBe('visible')
  })

  it('handles empty SGR parameter list (bare ESC[m is a reset)', () => {
    // The "else if (c === '')" branch: empty param string is a reset code.
    const coloured = '\x1b[2mdim\x1b[mclear'
    expect(stripGhostSuggestion(coloured)).toBe('clear')
  })

  it('drops non-CSI ESC sequences (e.g. ESC followed by other letters)', () => {
    // The `i++; continue` branch: an ESC byte not followed by `[` is silently
    // dropped from the output and the cursor advances past the ESC byte alone.
    const coloured = 'pre\x1bXpost'
    expect(stripGhostSuggestion(coloured)).toBe('preXpost')
  })

  it('treats 38;5;N (8-bit colour) as one unit, not splitting on its digits', () => {
    // The branch where `c === '38'`: the next code is the colour mode ('5')
    // and the index follows. Advancing `k` by 3 must skip past the entire
    // 8-bit colour triple so the digit '5' is not misread as an SGR code.
    const coloured = '\x1b[38;5;240mcoloured\x1b[0m text'
    expect(stripGhostSuggestion(coloured)).toBe('coloured text')
  })

  it('treats 38;2;R;G;B (24-bit colour) as one unit', () => {
    // The branch where `c === '38'` AND mode === '2': advance `k` by 5.
    const coloured = '\x1b[38;2;255;128;0mrgb\x1b[0m body'
    expect(stripGhostSuggestion(coloured)).toBe('rgb body')
  })

  it('treats 48 (background-colour extended) using the same shape', () => {
    // The branch where `c === '48'`: same advance logic as 38.
    const coloured = '\x1b[48;5;7mbg\x1b[0m text'
    expect(stripGhostSuggestion(coloured)).toBe('bg text')
  })

  it('falls through to k+=1 when an extended-colour code lacks a recognised mode', () => {
    // The defensive branch: 38 with an unknown mode ('x') -> advance 1,
    // and the next iteration handles whatever follows. No crash.
    const coloured = '\x1b[38;x;1mok\x1b[0m tail'
    expect(stripGhostSuggestion(coloured)).toBe(';1mok tail')
  })

  it('does not strip non-SGR CSI sequences (skips them but emits following text)', () => {
    // ESC[2J is a cursor-clear sequence, NOT an SGR (final != 'm'). The skip
    // path advances past the escape but does not flip the dim flag.
    const coloured = '\x1b[2Jplain text'
    expect(stripGhostSuggestion(coloured)).toBe('plain text')
  })

  it('handles a non-terminated escape (j >= n) by stopping at end of input', () => {
    // The `i = j < n ? j + 1 : n` branch: when the loop walks off the end
    // looking for the final CSI byte, the cursor lands at n and the while
    // terminates cleanly without throwing.
    const coloured = 'pre\x1b[' // truncated CSI, no closing byte
    expect(stripGhostSuggestion(coloured)).toBe('pre')
  })

  it('returns plain text unchanged when no dim sequences are present', () => {
    // Real production: most of the input is normal colour codes + visible text.
    const coloured = '\x1b[1mbold\x1b[0m and \x1b[31mred\x1b[0m'
    expect(stripGhostSuggestion(coloured)).toBe('bold and red')
  })

  it('strips a dim region that spans multiple non-dim chars inside it', () => {
    // Mixed: dim, then plain, then dim, then reset. All chars emitted while
    // dim is true are dropped regardless of intervening SGR codes.
    const coloured = '\x1b[2ma\x1b[4mb\x1b[3mc\x1b[0md'
    expect(stripGhostSuggestion(coloured)).toBe('d')
  })
})

// ---------------------------------------------------------------------------
// detectsFirstRunGate: classifies a Claude Code fresh-install gate.
//
// The trust / bypass-permissions / login / theme / welcome dialogs a brand-new
// install parks on before the prompt ever renders. A sub-agent session stuck
// on one of these is the fresh-install failure mode behind "scheduled tasks
// pile up on the agents" (Oligo2000 VPS, 2026-07-22).
// ---------------------------------------------------------------------------
describe('detectsFirstRunGate', () => {
  it('returns null for empty input', () => {
    expect(detectsFirstRunGate('')).toBeNull()
    expect(detectsFirstRunGate('   \n  ')).toBeNull()
  })

  it('returns null when the pane has an idle footer (a settled prompt, not a gate)', () => {
    // Idle footer present -> the real prompt is live; not a gate. A quoted
    // dialog text without a live footer is also covered by the footer guard.
    expect(detectsFirstRunGate(IDLE_BYPASS)).toBeNull()
    expect(detectsFirstRunGate(IDLE_STRICT)).toBeNull()
  })

  it('returns null when a live busy indicator is present', () => {
    // A busy pane is never a gate; even a spinner label alone (no esc-to-
    // interrupt on the footer) short-circuits the detection.
    expect(detectsFirstRunGate(BUSY_TOKENS_ONLY)).toBeNull()
  })

  it('returns null when esc-to-interrupt is in the live footer region', () => {
    // Busy footer scope: an active turn is not a first-run gate.
    expect(detectsFirstRunGate(BUSY_FULL_FOOTER)).toBeNull()
  })

  it('detects the per-project trust dialog', () => {
    const trust = [
      '  Do you trust the files in this folder?',
      '',
      '  1. Yes, I trust this folder',
      '  2. No, exit',
    ].join('\n')
    expect(detectsFirstRunGate(trust)).toBe('trust')
  })

  it('detects the --dangerously-skip-permissions bypass dialog', () => {
    const bypass = [
      '  Bypass Permissions mode',
      '',
      '  1. Yes, I accept',
      '  2. No, exit',
    ].join('\n')
    expect(detectsFirstRunGate(bypass)).toBe('bypass-permissions')
  })

  it('detects the login picker', () => {
    const login = [
      '  Select login method',
      '',
      '  1. Claude account',
      '  2. Console account',
    ].join('\n')
    expect(detectsFirstRunGate(login)).toBe('login')
  })

  it('detects the theme picker', () => {
    const theme = [
      '  Choose the text style',
      '',
      '  1. Dark',
      '  2. Light',
    ].join('\n')
    expect(detectsFirstRunGate(theme)).toBe('theme')
  })

  it('detects the welcome banner with no prompt glyph (no ❯ -> still a gate)', () => {
    // Welcome banner alone, no input box at all -> classify 'welcome'.
    const welcome = ['  Welcome to Claude Code', '  model line, cwd, etc.'].join('\n')
    expect(detectsFirstRunGate(welcome)).toBe('welcome')
  })

  it('returns null when the welcome banner is present but a � prompt glyph exists', () => {
    // The welcome banner also heads the NORMAL fresh-session layout. A ❯
    // prompt means an input box exists; the pane is usable, not a gate.
    const welcomeWithPrompt = [
      '  Welcome to Claude Code',
      '  model line, cwd, etc.',
      '',
      SEP,
      '❯ ',
      SEP,
    ].join('\n')
    expect(detectsFirstRunGate(welcomeWithPrompt)).toBeNull()
  })

  it('prefers the more-specific gate when multiple banners are present (login over welcome)', () => {
    // The login picker renders UNDER the "Welcome to Claude Code" banner.
    // The order in FIRST_RUN_GATES places login before welcome so the more
    // specific match wins.
    const loginUnderWelcome = [
      '  Welcome to Claude Code',
      '',
      '  Select login method',
      '',
      '  1. Claude account',
    ].join('\n')
    expect(detectsFirstRunGate(loginUnderWelcome)).toBe('login')
  })

  it('prefers theme over welcome when both banners co-occur', () => {
    const themeUnderWelcome = [
      '  Welcome to Claude Code',
      '',
      '  Choose the text style',
      '',
      '  1. Dark',
    ].join('\n')
    expect(detectsFirstRunGate(themeUnderWelcome)).toBe('theme')
  })

  it('returns null when none of the gate banners are present', () => {
    // Generic footer-less pane that is not a recognised gate. No banner
    // matches and no ❯ glyph either -- nothing to report.
    const unknown = ['  some random text', '  no banners anywhere'].join('\n')
    expect(detectsFirstRunGate(unknown)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// detectsModelConsentDialog: model overage-consent dialog (the "agent-config
// says claude-fable-5 but the session runs Sonnet" drift root cause).
// ---------------------------------------------------------------------------
describe('detectsModelConsentDialog', () => {
  it('returns false on empty / whitespace input', () => {
    expect(detectsModelConsentDialog('')).toBe(false)
    expect(detectsModelConsentDialog('   \n  ')).toBe(false)
  })

  it('returns false when an idle footer is present (real prompt is live)', () => {
    // A quoted dialog text coexisting with the live idle footer must NOT
    // trigger -- the prompt is live, not parked on the dialog.
    expect(detectsModelConsentDialog(IDLE_BYPASS)).toBe(false)
  })

  it('returns false when a busy indicator is present', () => {
    expect(detectsModelConsentDialog(BUSY_FULL_FOOTER)).toBe(false)
    expect(detectsModelConsentDialog(BUSY_TOKENS_ONLY)).toBe(false)
  })

  it('returns false when the footer has "esc to interrupt"', () => {
    // Active turn: not a consent dialog.
    const liveTurn = [
      '  Fable 5 now uses usage credits',
      '  1. Continue with Fable 5',
      '  Enter to confirm',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    expect(detectsModelConsentDialog(liveTurn)).toBe(false)
  })

  it('detects the full Fable 5 consent dialog', () => {
    // Real observed render shape on a fresh first-turn-of-the-day.
    const fable = [
      '  Fable 5 now uses usage credits',
      '    1. Continue with Fable 5',
      '  ❯ 2. Switch to Sonnet 5 and continue',
      '  Enter to confirm · Esc to cancel',
    ].join('\n')
    expect(detectsModelConsentDialog(fable)).toBe(true)
  })

  it('returns false when the "Continue with" option is missing', () => {
    // Title and confirm hint are present but the continue-option list is
    // missing -- not the recognised dialog shape.
    const noOption = [
      '  Fable 5 now uses usage credits',
      '  Enter to confirm · Esc to cancel',
    ].join('\n')
    expect(detectsModelConsentDialog(noOption)).toBe(false)
  })

  it('returns false when the title phrase is missing', () => {
    const noTitle = [
      '  Some other model dialog',
      '    1. Continue with Sonnet',
      '  Enter to confirm',
    ].join('\n')
    expect(detectsModelConsentDialog(noTitle)).toBe(false)
  })

  it('returns false when the "Enter to confirm" hint sits above the footer region', () => {
    // The confirm hint must be in the LIVE FOOTER region (last few lines).
    // A scrollback quote of "Enter to confirm" alone is not enough.
    const scrollbackHint = [
      '  Enter to confirm -- this is just a help line mentioned earlier',
      ...Array.from({ length: 10 }, () => '  filler line'),
      '  Fable 5 now uses usage credits',
      '    1. Continue with Fable 5',
    ].join('\n')
    expect(detectsModelConsentDialog(scrollbackHint)).toBe(false)
  })

  it('detects a "requires usage credits" variant', () => {
    // Matcher is model-name-agnostic: the "requires usage credits" wording
    // also matches. A future "<other model> requires usage credits" dialog
    // must classify without a code change here.
    const variant = [
      '  Sonnet now requires usage credits',
      '    1. Continue with Sonnet',
      '  Enter to confirm',
    ].join('\n')
    expect(detectsModelConsentDialog(variant)).toBe(true)
  })

  it('detects a "runs on usage credits" variant', () => {
    const variant = [
      '  Opus runs on usage credits',
      '    1. Continue with Opus',
      '  Enter to confirm',
    ].join('\n')
    expect(detectsModelConsentDialog(variant)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// idleConsideringDimGhost: idle check that tolerates DIM-only parked text.
//
// Claude Code renders an empty-input-box ghost suggestion in dim (SGR-2);
// a plain capture read shows it as parked text and detectPaneState reads
// 'typing'. This helper recovers readiness when the dim-stripped view is idle.
// ---------------------------------------------------------------------------
describe('idleConsideringDimGhost', () => {
  it('returns true when the plain capture is already idle', () => {
    expect(idleConsideringDimGhost(IDLE_BYPASS, null)).toBe(true)
  })

  it('returns false when the plain capture is busy', () => {
    expect(idleConsideringDimGhost(BUSY_FULL_FOOTER, null)).toBe(false)
  })

  it('returns false when the plain capture is typing but the dimStripped view is null', () => {
    // Typing detected but no dim-stripped view passed -> cannot confirm ghost-
    // only -> stay not-ready (defensive against an unconfigured caller).
    expect(idleConsideringDimGhost(TYPING_PARKED, null)).toBe(false)
  })

  it('returns false when the plain capture is typing and the dimStripped view is also not idle', () => {
    // The dim-stripped view itself reads busy: real parked text, not ghost.
    expect(idleConsideringDimGhost(TYPING_PARKED, BUSY_FULL_FOOTER)).toBe(false)
  })

  it('returns true when the plain capture reads typing but the dim-stripped view is idle', () => {
    // The recovery: plain (with ghost) reads typing, stripped (ghost removed)
    // reads idle. The pane only ever held dim ghost text -> IS ready.
    expect(idleConsideringDimGhost(TYPING_PARKED, IDLE_BYPASS)).toBe(true)
  })

  it('returns false when the plain capture is unknown (not typing)', () => {
    // The guard `detectPaneState(plain) !== 'typing'` must reject 'unknown'
    // / 'busy' / 'error' even if the dimStripped view is idle.
    expect(idleConsideringDimGhost('', IDLE_BYPASS)).toBe(false)
    expect(idleConsideringDimGhost(NON_CLAUDE, IDLE_BYPASS)).toBe(false)
    expect(idleConsideringDimGhost(ERROR_THINKING_BLOCK, IDLE_BYPASS)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parkedMachineOriginInput: true when parked input starts with a machine
// wrapper that the delivery paths prepend (the recovery stack may act on it).
// ---------------------------------------------------------------------------
describe('parkedMachineOriginInput', () => {
  it('is false when there is no parked input', () => {
    expect(parkedMachineOriginInput(IDLE_BYPASS)).toBe(false)
    expect(parkedMachineOriginInput('')).toBe(false)
  })

  it('is false for a human hand-typed draft (no machine wrapper)', () => {
    expect(parkedMachineOriginInput(TYPING_PARKED)).toBe(false)
  })

  it('recognises the SCHEDULED TASK NOTICE wrapper', () => {
    const pane = [
      '',
      SEP,
      '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="...">',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMachineOriginInput(pane)).toBe(true)
  })

  it('recognises the <scheduled-task> opening tag', () => {
    const pane = [
      '',
      SEP,
      '❯ <scheduled-task source="..."> body of a scheduled tick',
      SEP,
      '  ⏵� bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMachineOriginInput(pane)).toBe(true)
  })

  it('recognises the TEAM MEMBER NOTICE wrapper', () => {
    const pane = [
      '',
      SEP,
      '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> some text',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMachineOriginInput(pane)).toBe(true)
  })

  it('recognises the [Uzenet @...] wrapper', () => {
    const pane = [
      '',
      SEP,
      '❯ [Uzenet @dev3-tol -- trusted team member]: hello',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMachineOriginInput(pane)).toBe(true)
  })

  it('recognises the <channel source="plugin:..."> wrapper', () => {
    const pane = [
      '',
      SEP,
      '❯ <channel source="plugin:telegram:telegram" chat_id="1">body</channel>',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMachineOriginInput(pane)).toBe(true)
  })

  it('does NOT match a wrapper that appears later in the text (anchored to start)', () => {
    // Anchored to the box start on purpose: a human draft that merely quotes
    // a wrapper deeper in the text stays protected (not treated as machine).
    const pane = [
      '',
      SEP,
      '� Some human text and then a quoted wrapper: SCHEDULED TASK NOTICE',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMachineOriginInput(pane)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parkedScheduledTaskInput: true when the parked input is a scheduled-task
// injection (the safe clear-only path; re-inject is unsafe on TUI truncation).
// ---------------------------------------------------------------------------
describe('parkedScheduledTaskInput', () => {
  it('is false when there is no parked input', () => {
    expect(parkedScheduledTaskInput(IDLE_BYPASS)).toBe(false)
    expect(parkedScheduledTaskInput('')).toBe(false)
  })

  it('recognises the SCHEDULED TASK NOTICE wrapper', () => {
    const pane = [
      '',
      SEP,
      '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="...">',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedScheduledTaskInput(pane)).toBe(true)
  })

  it('recognises the <scheduled-task> opening tag', () => {
    const pane = [
      '',
      SEP,
      '❯ <scheduled-task source="..."> body of a scheduled tick',
      SEP,
      '  ⏵� bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedScheduledTaskInput(pane)).toBe(true)
  })

  it('is false for OTHER machine-origin wrappers (TEAM MEMBER NOTICE / [Uzenet / channel)', () => {
    // The other machine-origin wrappers are NOT the scheduled-task class:
    // they belong to inter-agent or plugin delivery and use a different
    // recovery path. The helper must reject them so the clear-only branch
    // does not apply to non-scheduled parked messages.
    const teamPane = [
      '',
      SEP,
      '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> text',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedScheduledTaskInput(teamPane)).toBe(false)

    const uzenetPane = [
      '',
      SEP,
      '� [Uzenet @dev3-tol -- trusted team member]: hello',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedScheduledTaskInput(uzenetPane)).toBe(false)

    const channelPane = [
      '',
      SEP,
      '❯ <channel source="plugin:telegram:telegram" chat_id="1">body</channel>',
      SEP,
      '  �⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedScheduledTaskInput(channelPane)).toBe(false)
  })

  it('is false for a human hand-typed draft', () => {
    expect(parkedScheduledTaskInput(TYPING_PARKED)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// decideStuckInputAction: pure decision for the soft stuck-input recovery
// watcher. Returns one of six discrete actions.
// ---------------------------------------------------------------------------
describe('decideStuckInputAction', () => {
  it('routes a single-row complete <channel> block to "enter" (below the escalate cap)', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 1,
      blockComplete: true,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('enter')
  })

  it('routes a multi-row complete <channel> block to "reinject-block"', () => {
    // Multi-row is itself a reason to escalate: a plain Enter would corrupt
    // the buffer with a newline insertion.
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 3,
      blockComplete: true,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('reinject-block')
  })

  it('routes a single-row complete <channel> block to "reinject-block" when escalate=true', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: true,
      rowCount: 1,
      blockComplete: true,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('reinject-block')
  })

  it('routes a single-row plain text with sub-agent allowPlainReinject to "enter"', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 1,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: true,
      hasPlainText: true,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('enter')
  })

  it('routes a multi-row plain text with sub-agent allowPlainReinject to "reinject-plain"', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 2,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: true,
      hasPlainText: true,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('reinject-plain')
  })

  it('routes a single-row plain text with allowPlainReinject to "reinject-plain" when escalate=true', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: true,
      rowCount: 1,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: true,
      hasPlainText: true,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('reinject-plain')
  })

  it('routes a scheduled-task single-row block to "enter"', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 1,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: true,
    }
    expect(decideStuckInputAction(f)).toBe('enter')
  })

  it('routes a scheduled-task multi-row block to "clear-scheduled"', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 2,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: true,
    }
    expect(decideStuckInputAction(f)).toBe('clear-scheduled')
  })

  it('routes a single-row scheduled-task block to "clear-scheduled" when escalate=true', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: true,
      rowCount: 1,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: true,
    }
    expect(decideStuckInputAction(f)).toBe('clear-scheduled')
  })

  it('routes a truncated preamble to "clear-preamble" when escalate=true', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: true,
      rowCount: 1,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: true,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('clear-preamble')
  })

  it('does NOT clear-preamble at non-escalated tier (falls through)', () => {
    // truncatedPreamble only matters at full escalation. Below the cap, the
    // single-row fallback is the harmless Enter first; multi-row is hold.
    const singleRow: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 1,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: true,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(singleRow)).toBe('enter')
    const multiRow: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 3,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: true,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(multiRow)).toBe('hold')
  })

  it('routes a single-row truncated <channel> block to "enter" (legacy harmless Enter)', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 1,
      blockComplete: false,
      blockTruncated: true,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('enter')
  })

  it('routes a multi-row truncated <channel> block to "hold"', () => {
    // Enter would corrupt; re-inject would answer the wrong chat_id. Hold.
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 2,
      blockComplete: false,
      blockTruncated: true,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('hold')
  })

  it('routes the single-row default to "enter"', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 1,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('enter')
  })

  it('routes the multi-row default to "hold"', () => {
    const f: import('../pane-state.js').StuckInputActionFacts = {
      escalate: false,
      rowCount: 4,
      blockComplete: false,
      blockTruncated: false,
      truncatedPreamble: false,
      allowPlainReinject: false,
      hasPlainText: false,
      scheduledTaskBlock: false,
    }
    expect(decideStuckInputAction(f)).toBe('hold')
  })
})

// ---------------------------------------------------------------------------
// parkedMainInputHasRemedy: would the soft stuck-input recovery have ANY
// submitting/clearing move for the MAIN session at full escalation, or is it
// wedged in the no-remedy 'hold' branch.
// ---------------------------------------------------------------------------
describe('parkedMainInputHasRemedy', () => {
  it('returns true on an empty / idle pane (BUG: should be false but does not gate on typing state)', () => {
    // BUG PIN (docs/needs-to-be-fix/pane-state-idle-remedy.md):
    // parkedMainInputHasRemedy does not gate on the 'typing' state, so an
    // idle/empty pane also falls through to the default 'enter' branch and
    // reads as having a remedy. Documented; the test pins the actual
    // behavior so a future fix surfaces here, not in production.
    expect(parkedMainInputHasRemedy(IDLE_BYPASS)).toBe(true)
    expect(parkedMainInputHasRemedy('')).toBe(true)
  })

  it('is true when a single-row complete <channel> block is parked (chat_id-safe reinject)', () => {
    const pane = [
      '',
      SEP,
      '❯ <channel source="plugin:telegram:telegram" chat_id="1268077055" message_id="1">body</channel>',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMainInputHasRemedy(pane)).toBe(true)
  })

  it('is true when a multi-row complete <channel> block is parked', () => {
    const pane = [
      '',
      SEP,
      '❯ <channel source="plugin:telegram:telegram" chat_id="1268077055" mess',
      '  age_id="1">wrapped body that spans multiple rows here</channel>',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMainInputHasRemedy(pane)).toBe(true)
  })

  it('is true when a scheduled-task tick is parked (clear-only is a remedy)', () => {
    const pane = [
      '',
      SEP,
      '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="...">',
      '  body of the scheduled tick',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMainInputHasRemedy(pane)).toBe(true)
  })

  it('is true when a truncated preamble is parked (clear is a remedy)', () => {
    const pane = STUCK_TRUNCATED_TRUSTED_PREAMBLE
    expect(parkedMainInputHasRemedy(pane)).toBe(true)
  })

  it('is false when a single-row truncated <channel> block is parked (legacy Enter only)', () => {
    // Single-row truncated: the only action is the harmless Enter (not a
    // remedy at the escalated tier), so the main-session remedy set is empty.
    const pane = [
      '',
      SEP,
      '❯ <channel source="plugin:telegram:telegram" chat_id="1268077055" ts="x">Az uzenet vege lescrollozott es nincs zaro tag',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    // BUG-DETECTED: at escalated tier the single-row truncated <channel>
    // block routes to 'enter' (the harmless legacy fallback), which IS a
    // remedy per the function's own contract. Pin the actual behavior so a
    // future refactor cannot silently change the contract without breaking
    // the gate -- documented in docs/needs-to-be-fix/pane-state-idle-remedy.md.
    expect(parkedMainInputHasRemedy(pane)).toBe(true)
  })

  it('is false when a multi-row truncated <channel> block is parked (chat_id unsafe)', () => {
    // Multi-row + truncated = 'hold' (Enter corrupts, re-inject is wrong-id).
    // The main session has no soft remedy here.
    const pane = [
      '',
      SEP,
      '❯ <channel source="plugin:telegram:telegram" chat_id="126',
      '  8077055" message_id="1">wrapped without zaro tag and chat_id corrupted',
      SEP,
      '  ⏵� bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMainInputHasRemedy(pane)).toBe(false)
  })

  it('is true when a multi-row scheduled-task block is parked (clear-scheduled is a remedy)', () => {
    // Multi-row scheduled-task: at escalated tier, action is 'clear-scheduled',
    // which is a remedy (not 'hold'), so the predicate must return true.
    const pane = [
      '',
      SEP,
      '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="...">',
      '  body of the scheduled tick that spans multiple input rows',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMainInputHasRemedy(pane)).toBe(true)
  })

  it('is true when a single-row scheduled-task block is parked (clear-scheduled is the escalated action)', () => {
    // At escalated tier the single-row scheduled-task routes to 'clear-
    // scheduled' (because escalate is forced true in parkedMainInputHasRemedy),
    // which is a remedy -- not 'hold'.
    const pane = [
      '',
      SEP,
      '❯ SCHEDULED TASK NOTICE -- the next <scheduled-task source="...">',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMainInputHasRemedy(pane)).toBe(true)
  })

  it('is false when a multi-row truncated preamble is parked', () => {
    // Multi-row + truncatedPreamble + escalate=true -> 'clear-preamble'.
    // Actually 'clear-preamble' is a remedy, so the predicate is TRUE here.
    // Pin the exact multi-row truncated-preamble shape so a future refactor
    // cannot silently flip the remedy class.
    const pane = [
      '',
      SEP,
      '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> wrapped',
      '  preamble that spans multiple rows without a real opening tag yet',
      SEP,
      '  �⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedMainInputHasRemedy(pane)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// stuckToolCallSignature: parse the TUI's "Worked / Brewed / Baked for Ns"
// footer.
// ---------------------------------------------------------------------------
describe('stuckToolCallSignature', () => {
  it('returns null when there is no tool-call line', () => {
    expect(stuckToolCallSignature('')).toBeNull()
    expect(stuckToolCallSignature('idle pane text only')).toBeNull()
    expect(stuckToolCallSignature(IDLE_BYPASS)).toBeNull()
  })

  it('parses "Worked for Ns"', () => {
    const pane = '✻ Worked for 31s\nsome other context'
    expect(stuckToolCallSignature(pane)).toEqual({ tag: 'worked', seconds: 31 })
  })

  it('parses "Brewed for Ns"', () => {
    const pane = '✻ Brewed for 12s\nsome other context'
    expect(stuckToolCallSignature(pane)).toEqual({ tag: 'brewed', seconds: 12 })
  })

  it('parses "Baked for Ns"', () => {
    const pane = '✻ Baked for 5s'
    expect(stuckToolCallSignature(pane)).toEqual({ tag: 'baked', seconds: 5 })
  })

  it('parses "Cooking for Ns"', () => {
    const pane = '✻ Cooking for 99s'
    expect(stuckToolCallSignature(pane)).toEqual({ tag: 'cooking', seconds: 99 })
  })

  it('parses "Simmered for Ns"', () => {
    const pane = '✻ Simmered for 7s'
    expect(stuckToolCallSignature(pane)).toEqual({ tag: 'simmered', seconds: 7 })
  })

  it('parses "Sauteed for Ns" (and the misspelled "Sauted for Ns")', () => {
    const sa = '✻ Sauteed for 4s'
    const ed = '✻ Sauted for 4s'
    expect(stuckToolCallSignature(sa)).toEqual({ tag: 'sauteed', seconds: 4 })
    expect(stuckToolCallSignature(ed)).toEqual({ tag: 'sauted', seconds: 4 })
  })

  it('returns null when seconds is malformed (not parseable to a finite number)', () => {
    // The `Number.isFinite` guard: a NaN parseInt must return null rather
    // than poisoning the watcher with seconds=NaN.
    const pane = '✻ Worked for NaNs'
    expect(stuckToolCallSignature(pane)).toBeNull()
  })

  it('returns null when seconds is negative', () => {
    // Negative seconds are nonsense for a forward-progressing counter.
    const pane = '✻ Worked for -5s'
    expect(stuckToolCallSignature(pane)).toBeNull()
  })

  it('returns null when seconds is zero (treated as not in a tool-call)', () => {
    // Zero seconds is technically not negative, but matches the seconds>=0
    // floor -- the parser still returns it. Pin the actual contract: the
    // guard is "not finite OR < 0", so 0 is accepted.
    const pane = '✻ Worked for 0s'
    expect(stuckToolCallSignature(pane)).toEqual({ tag: 'worked', seconds: 0 })
  })
})

// ---------------------------------------------------------------------------
// decideStuckToolCallRecovery: should the watcher respawn this session
// because the TUI tool-call counter has stopped advancing for too long?
// Load-bearing measurement is WALL-CLOCK stagnation, NOT the displayed value.
// ---------------------------------------------------------------------------
describe('decideStuckToolCallRecovery', () => {
  const TH = { freezeSeconds: 30, stagnantPolls: 2, minPeakSeconds: 10 }
  const NONE = {
    tag: null,
    spellStartSeconds: null,
    spellPeakSeconds: null,
    firstSeenAt: null,
    lastSeconds: null,
    stagnantPolls: 0,
    stagnantSince: null,
    attempts: 0,
  }

  it('does nothing when no tool-call line is present and no spell is active', () => {
    const d = decideStuckToolCallRecovery(null, NONE, 5_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('clears the spell when the tool-call line disappears mid-spell', () => {
    const active = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: 20,
      firstSeenAt: 1_000,
      lastSeconds: 20,
      stagnantPolls: 2,
      stagnantSince: 60_000,
      attempts: 0,
    }
    const d = decideStuckToolCallRecovery(null, active, 100_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('records a fresh spell on first sighting of a new tag', () => {
    const sig = { tag: 'worked', seconds: 12 }
    const d = decideStuckToolCallRecovery(sig, NONE, 10_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.tag).toBe('worked')
    expect(d.next.spellStartSeconds).toBe(12)
    expect(d.next.spellPeakSeconds).toBe(12)
    expect(d.next.firstSeenAt).toBe(10_000)
    expect(d.next.lastSeconds).toBe(12)
    expect(d.next.stagnantPolls).toBe(0)
    expect(d.next.stagnantSince).toBeNull()
    expect(d.next.attempts).toBe(0)
  })

  it('starts a new spell when the verb changes (Brewed -> Worked is progress)', () => {
    // A verb change is genuine progress and the watcher must restart the spell.
    const prev = {
      tag: 'brewed',
      spellStartSeconds: 5,
      spellPeakSeconds: 5,
      firstSeenAt: 1_000,
      lastSeconds: 5,
      stagnantPolls: 1,
      stagnantSince: null,
      attempts: 0,
    }
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 1 }, prev, 2_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.tag).toBe('worked')
    expect(d.next.firstSeenAt).toBe(2_000)
    expect(d.next.stagnantSince).toBeNull()
  })

  it('restarts the spell on backwards clock skew', () => {
    const skewed = {
      tag: 'worked',
      spellStartSeconds: 10,
      spellPeakSeconds: 10,
      firstSeenAt: 1_000_000,
      lastSeconds: 10,
      stagnantPolls: 1,
      stagnantSince: 1_000_000,
      attempts: 1,
    }
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 10 }, skewed, 500_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.firstSeenAt).toBe(500_000)
    expect(d.next.stagnantSince).toBeNull()
    expect(d.next.attempts).toBe(0)
  })

  it('updates the spell when the counter advances (real progress)', () => {
    const prev = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: 5,
      firstSeenAt: 1_000,
      lastSeconds: 5,
      stagnantPolls: 1,
      stagnantSince: 1_000,
      attempts: 0,
    }
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 15 }, prev, 11_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.spellPeakSeconds).toBe(15)
    expect(d.next.lastSeconds).toBe(15)
    expect(d.next.stagnantPolls).toBe(0)
    expect(d.next.stagnantSince).toBeNull()
    expect(d.next.firstSeenAt).toBe(1_000) // firstSeenAt preserved
  })

  it('updates the spell when the counter advances past the previous peak', () => {
    // spellPeakSeconds is the max of previous peak and new seconds.
    const prev = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: 30,
      firstSeenAt: 1_000,
      lastSeconds: 25,
      stagnantPolls: 1,
      stagnantSince: 1_000,
      attempts: 0,
    }
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 35 }, prev, 30_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.spellPeakSeconds).toBe(35) // new max
  })

  it('holds when recovery has already fired in this spell', () => {
    const already = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: 30,
      firstSeenAt: 1_000,
      lastSeconds: 30,
      stagnantPolls: 3,
      stagnantSince: 60_000,
      attempts: 1,
    }
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 30 }, already, 120_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.attempts).toBe(1)
    expect(d.next.stagnantPolls).toBe(4)
  })

  it('does not recover when the wall-clock freezeSeconds gate is not elapsed', () => {
    // Spell has been stagnant for less than freezeSeconds; counter is frozen
    // at 30s. Wall-clock gate must hold.
    const prev = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: 30,
      firstSeenAt: 1_000,
      lastSeconds: 30,
      stagnantPolls: 1,
      stagnantSince: 10_000,
      attempts: 0,
    }
    // stagnantSince=10000, now=15000 -> 5s < 30s freezeSeconds.
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 30 }, prev, 15_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.stagnantPolls).toBe(2)
  })

  it('does not recover when the anti-fluke stagnantPolls gate is not met', () => {
    // Wall-clock is fine but only ONE stagnant poll so far (< 2).
    const prev = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: 30,
      firstSeenAt: 1_000,
      lastSeconds: 30,
      stagnantPolls: 0,
      stagnantSince: 10_000,
      attempts: 0,
    }
    // 60s >= 30s wall-clock but stagnantPolls=1 < 2.
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 30 }, prev, 70_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.stagnantPolls).toBe(1)
  })

  it('does not recover when the spell-peak discriminator is not met', () => {
    // A residual TUI footer left over after a prior respawn: peak stays low
    // (3-4s) so the minPeakSeconds=10 gate must block recovery.
    const prev = {
      tag: 'worked',
      spellStartSeconds: 3,
      spellPeakSeconds: 4,
      firstSeenAt: 1_000,
      lastSeconds: 4,
      stagnantPolls: 1,
      stagnantSince: 10_000,
      attempts: 0,
    }
    // Wall-clock and anti-fluke both elapsed (60s, 2 polls), but peak < minPeak.
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 4 }, prev, 70_000, TH)
    expect(d.recover).toBe(false)
  })

  it('recovers when all three gates hold (wall-clock, anti-fluke, spell-peak)', () => {
    // The real incident shape: counter climbed to 31s, froze, watched for
    // 30s wall-clock + 2+ stagnant polls + peak >= 10. Recovery fires.
    const prev = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: 31,
      firstSeenAt: 1_000,
      lastSeconds: 31,
      stagnantPolls: 1,
      stagnantSince: 10_000,
      attempts: 0,
    }
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, prev, 60_000, TH)
    expect(d.recover).toBe(true)
    expect(d.next.attempts).toBe(1)
    expect(d.next.stagnantPolls).toBe(2)
  })

  it('preserves stagnantSince across subsequent stagnant polls (wall-clock accumulates)', () => {
    // The `prev.stagnantSince ?? now` branch: a second consecutive stagnant
    // poll must NOT reset the start of the stagnation window.
    const prev = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: 31,
      firstSeenAt: 1_000,
      lastSeconds: 31,
      stagnantPolls: 1,
      stagnantSince: 10_000,
      attempts: 0,
    }
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, prev, 20_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.stagnantSince).toBe(10_000) // unchanged
  })

  it('handles a null spellPeakSeconds by treating it as the new seconds value', () => {
    // Defensive: a freshly built state object with spellPeakSeconds=null
    // must not crash; the spell-peak discriminator uses `prev.spellPeakSeconds
    // ?? sig.seconds`.
    const prev = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: null,
      firstSeenAt: 1_000,
      lastSeconds: null,
      stagnantPolls: 1,
      stagnantSince: 10_000,
      attempts: 0,
    }
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, prev, 60_000, TH)
    expect(d.recover).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// paneLooksIdle: thin alias over detectPaneState === 'idle'.
// ---------------------------------------------------------------------------
describe('paneLooksIdle', () => {
  it('returns true on the canonical idle pane', () => {
    expect(paneLooksIdle(IDLE_BYPASS)).toBe(true)
    expect(paneLooksIdle(IDLE_STRICT)).toBe(true)
  })

  it('returns false on busy / typing / unknown / error states', () => {
    expect(paneLooksIdle(BUSY_FULL_FOOTER)).toBe(false)
    expect(paneLooksIdle(TYPING_PARKED)).toBe(false)
    expect(paneLooksIdle(NON_CLAUDE)).toBe(false)
    expect(paneLooksIdle(ERROR_THINKING_BLOCK)).toBe(false)
    expect(paneLooksIdle(PENDING_PASTE)).toBe(false)
  })

  it('returns false on empty input', () => {
    expect(paneLooksIdle('')).toBe(false)
    expect(paneLooksIdle('   \n\n  ')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Branch-coverage tests: edge cases the happy-path suite does not hit. Each
// `it` here pins one specific branch that v8 reports as uncovered.
// ---------------------------------------------------------------------------

describe('detectPaneState: liveInputBox branch coverage', () => {
  it('handles an idle footer with no separators above it (bottomSep stays -1)', () => {
    // The `bottomSep <= 0` return-null branch in liveInputBox: with no
    // separator above the footer, the box locator cannot find a top
    // boundary and returns null. detectPaneState must not crash; the
    // parked-input branch is skipped and the result is 'idle' (no
    // parked text, footer present, no busy indicators).
    const pane = ['just one line with a footer', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('handles an idle footer with only a top separator and no bottom one', () => {
    // Footer present, only ONE separator visible -- liveInputBox cannot
    // locate the box, returns null. Without a box the parked-input branch
    // is skipped and the pane reads 'idle'.
    const pane = [SEP, '� ', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('handles a separator at index 0 with the footer below it', () => {
    // bottomSep = 0, which triggers the `bottomSep <= 0` branch in
    // liveInputBox. The function returns null and detectPaneState falls
    // through to 'idle' (footer present, no parked input, no busy).
    const pane = [SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
  })
})

describe('detectsBlockingMenu: esc-to-interrupt footer branch', () => {
  it('returns false when esc-to-interrupt is in the live footer (no busy indicator match)', () => {
    // The branch at line 420 (BUSY_ESC_TO_INTERRUPT_RX on footerRegion):
    // we construct a menu-shaped pane whose footer carries esc-to-
    // interrupt (e.g. a busy render INSIDE a menu) so the menu guard
    // at line 420 returns false. None of the BUSY_INDICATORS match, so
    // the busy pre-check does not fire and the footer branch is the
    // deciding gate.
    const busyMenu = [
      '   Some dialog title',
      '   Press Esc to exit',
      '   ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    expect(detectsBlockingMenu(busyMenu)).toBe(false)
  })
})

describe('detectsFirstRunGate: footer-esc branch', () => {
  it('returns null when a gate banner is present but esc-to-interrupt sits in the live footer', () => {
    // The branch at line 473 (BUSY_ESC_TO_INTERRUPT_RX on footerRegion).
    // A live turn is never a gate, even when the dialog banner is in the
    // pane (a quoted gate text under an active turn).
    const liveGate = [
      '  Do you trust the files in this folder?',
      '',
      '  1. Yes',
      '  2. No',
      '  some separator',
      '❯ ',
      '  some separator',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    expect(detectsFirstRunGate(liveGate)).toBeNull()
  })
})

describe('shouldRetrySubmit: inputBox-null branch', () => {
  it('returns false when the footer is recognised but no input box can be located', () => {
    // The branch at line 840 (`if (inputBox == null) return false`):
    // an idle footer is present but no separators above it, so
    // liveInputBox returns null. Without an input box the verbatim
    // substring check cannot run; the helper conservatively returns
    // false rather than firing a stray Enter on a malformed capture.
    const pane = ['just one line with a footer', '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(shouldRetrySubmit(pane, PAYLOAD_HINT)).toBe(false)
  })
})

describe('decidePaneErrorAlert: clock-skew clear branch', () => {
  const TH = { confirmMs: 120_000, dedupMs: 1_800_000, clearMs: 300_000 }

  it('clears the spell when lastErrorAt is in the future (clock skew)', () => {
    // The `errorFreeFor < 0` branch at line 1024: a future-dated
    // lastErrorAt (wall-clock jumped backwards) must clear the spell
    // immediately so the deltas do not stall the machine silently.
    const skewed = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 1_000_000 }, 500_000, TH)
    expect(skewed.alert).toBe(false)
    expect(skewed.next).toEqual({ firstSeenAt: null, lastAlertAt: null, lastErrorAt: null })
  })
})

describe('stuckInputSignature: null-box and empty-sig branches', () => {
  it('returns null when detectPaneState is typing but liveInputBox cannot locate the box', () => {
    // The branch at line 1064 (`if (box == null) return null`).
    // Footer-less welcome-screen shape where the box locator cannot
    // find a separator pair OR a ❯ prompt row -> returns null.
    const noBox = ['  some scrollback', SEP, '  plain text, no prompt glyph', SEP, ''].join('\n')
    expect(stuckInputSignature(noBox)).toBeNull()
  })

  it('returns null when the collapsed box content has zero non-whitespace characters', () => {
    // The branch at line 1066 (`return sig.length > 0 ? sig : null`):
    // a "typing" pane whose box holds ONLY whitespace after collapse
    // is treated as no parked input (null) -- a defensive edge case
    // where the TUI emitted the prompt glyph with trailing whitespace
    // but no actual user text.
    const blank = [
      '',
      SEP,
      '❯    \t  \t  ',
      SEP,
      '  ⏵� bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(stuckInputSignature(blank)).toBeNull()
  })
})

describe('parkedPasteSignature: footer-esc and empty-sig branches', () => {
  it('returns null when a placeholder is parked but esc-to-interrupt sits in the live footer (no busy indicator match)', () => {
    // Branch at line 1101 (BUSY_ESC_TO_INTERRUPT_RX.test(footerRegion)).
    // The busy pre-check (line 1097) matches on spinner/tokens patterns,
    // so to reach line 1101 the busyRegion must NOT match a busy
    // indicator. Construct a pane where only the footer-region esc-to-
    // interrupt triggers -- the live turn has just finished its busy
    // render and the footer still carries the marker.
    const busyPaste = [
      '  ⏵� bypass permissions on (shift+tab to cycle) · esc to interrupt',
      SEP,
      '❯ [Pasted text #7 +512 chars]',
      SEP,
    ].join('\n')
    expect(parkedPasteSignature(busyPaste)).toBeNull()
  })

  it('returns a collapsed non-empty signature for a minimal parked placeholder', () => {
    // The branch at line 1104 (`return sig.length > 0 ? sig : null`):
    // pin the truthy branch -- a real parked placeholder always has
    // non-empty content after whitespace collapse, so the helper
    // returns the signature (not null).
    const minimal = [
      '',
      SEP,
      '❯ [Pasted text #1',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedPasteSignature(minimal)).not.toBeNull()
  })
})

describe('parkedChannelInput: null-box branch', () => {
  it('returns null when detectPaneState is typing but liveInputBox cannot locate the box', () => {
    // The branch at line 1136: a footer-less layout where the box
    // locator falls back to the footer-less path AND cannot find a
    // ❯-prefixed separator pair -> returns null. A caller that cannot
    // recover the chat_id must not act on this pane.
    const pane = ['  some scrollback line', SEP, '  plain text, no prompt glyph', SEP, ''].join('\n')
    expect(parkedChannelInput(pane)).toBeNull()
  })
})

describe('parkedInputText: null-box and empty-flat branches', () => {
  it('returns null when detectPaneState is typing but liveInputBox cannot locate the box', () => {
    // The branch at line 1161.
    const pane = ['  some scrollback line', SEP, '  plain text, no prompt glyph', SEP, ''].join('\n')
    expect(parkedInputText(pane)).toBeNull()
  })

  it('returns null when the collapsed-flat text is empty after prompt-glyph stripping', () => {
    // The branch at line 1165 (`return flat.length > 0 ? flat : null`):
    // a typing pane whose collapsed box content is just the � prompt
    // glyph and whitespace -- no actual text to recover. Treat as null.
    const promptOnly = [
      '',
      SEP,
      '❯ \t \t ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(parkedInputText(promptOnly)).toBeNull()
  })
})

describe('stuckToolCallSignature: negative-seconds branch', () => {
  it('returns null when the regex matches but the seconds value is negative', () => {
    // The branch at line 1489 (`!Number.isFinite(seconds) || seconds < 0`):
    // a negative counter is nonsense for a forward-progressing timer;
    // must be rejected so the watcher does not enter a recovery loop on
    // a malformed render.
    const pane = '✻ Worked for -3s'
    expect(stuckToolCallSignature(pane)).toBeNull()
  })
})

describe('decideStuckToolCallRecovery: null-coalescing branches', () => {
  const TH = { freezeSeconds: 30, stagnantPolls: 2, minPeakSeconds: 10 }

  it('falls back to sig.seconds as the spell peak when spellPeakSeconds was previously null (counter advanced)', () => {
    // The branch at line 1641 (`prev.spellPeakSeconds ?? sig.seconds`):
    // when the previous state was built without a peak (defensive
    // initial-state shape), the peak falls back to sig.seconds. To
    // reach this branch the counter MUST advance (otherwise the
    // stagnation branch wins); pin the counter-advanced shape with
    // null peak to lock the null-coalesce branch.
    const prev = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: null,
      firstSeenAt: 1_000,
      lastSeconds: 10,
      stagnantPolls: 0,
      stagnantSince: null,
      attempts: 0,
    }
    // Counter advanced: 10 -> 31. The branch evaluates peak = Math.max(null ?? 31, 31) = 31.
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, prev, 35_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.spellPeakSeconds).toBe(31)
    expect(d.next.lastSeconds).toBe(31)
    expect(d.next.stagnantPolls).toBe(0)
    expect(d.next.stagnantSince).toBeNull()
  })

  it('uses "now" as the stagnation timestamp when stagnantSince was previously null', () => {
    // The branch at line 1652 (`prev.stagnantSince ?? now`): when a
    // spell has just gone stagnant (first non-progressing poll), the
    // wall-clock baseline is `now`, not a previously-stored value.
    const prev = {
      tag: 'worked',
      spellStartSeconds: 5,
      spellPeakSeconds: 31,
      firstSeenAt: 1_000,
      lastSeconds: 31,
      stagnantPolls: 0,
      stagnantSince: null,
      attempts: 0,
    }
    const d = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, prev, 35_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.stagnantSince).toBe(35_000)
  })
})


// ---------------------------------------------------------------------------
// liveInputBox: topSep < 0 branch (real, reachable path).
//
// liveInputBox runs the footer-anchored loop when an idle footer is
// present: bottomSep is the most recent BOX_SEP_RX separator above the
// footer; topSep is the second-most-recent. When only ONE separator
// exists between the footer and the top, the topSep search never finds
// a hit and the function returns null. detectPaneState's footer-anchored
// typing branch (line 627-647) has the same structure, so the same
// shape exercises its topSep < 0 check.
// ---------------------------------------------------------------------------
describe('detectPaneState / liveInputBox: only-one-separator-above-footer shape', () => {
  it('classifies a footer + single-separator pane as idle (topSep never found)', () => {
    // The shape: a non-separator line, then ONE separator (the input
    // box bottom), then the prompt + footer. The box locator's topSep
    // search loops from bottomSep-1 (= 0) down to 0, finds no second
    // separator, and returns null. detectPaneState falls through to
    // 'idle' (footer present, no parked text detected).
    const pane = [
      '  some non-separator scrollback',
      SEP,
      '  ❯ ',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
    // The parkedInputRowCount helper also calls liveInputBox internally;
    // when it returns null, the row count is 0.
    expect(parkedInputRowCount(pane)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// decidePaneErrorAlert: synthetic prev.firstSeenAt != null with
// prev.lastErrorAt === null (defensive Infinity branch).
//
// In real flow lastErrorAt is always set when firstSeenAt is set, but the
// defensive ternary still wants both outcomes covered. We construct a
// synthetic state where firstSeenAt != null and lastErrorAt === null to
// pin the Infinity branch at line 1023.
// ---------------------------------------------------------------------------
describe('decidePaneErrorAlert: synthetic Infinity branch', () => {
  it('uses Infinity path when prev has firstSeenAt but lastErrorAt is null', () => {
    // Branch at line 1023 (`prev.lastErrorAt === null ? Infinity`):
    // pin the truthy outcome via a synthetic prev state. errorFreeFor is
    // Infinity, which is always >= clearMs, so the spell clears.
    const TH = { confirmMs: 120_000, dedupMs: 1_800_000, clearMs: 300_000 }
    const synthetic = { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: null }
    const d = decidePaneErrorAlert(false, synthetic, 5_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next).toEqual({ firstSeenAt: null, lastAlertAt: null, lastErrorAt: null })
  })
})


// ---------------------------------------------------------------------------
// stripGhostSuggestion: extended-colour mode 1/5/2 path coverage.
//
// Each test exercises a different extended-colour mode (`38;5;N`, `38;2;R;G;B`,
// `38;x;1`) to pin the per-mode advance count in the inner ternary
// `mode === '2' ? 5 : 1`. v8 tracks the per-mode outcome as a separate
// branch -- one test alone is not enough.
// ---------------------------------------------------------------------------
describe('stripGhostSuggestion: per-mode extended-colour path', () => {
  it('38;5;1 (index colour, smallest valid index) advances k by 3', () => {
    const coloured = '\x1b[38;5;1mred\x1b[0m tail'
    expect(stripGhostSuggestion(coloured)).toBe('red tail')
  })

  it('38;2;0;0;0 (24-bit black, smallest RGB) advances k by 5', () => {
    const coloured = '\x1b[38;2;0;0;0mk\x1b[0m tail'
    expect(stripGhostSuggestion(coloured)).toBe('k tail')
  })

  it('38;9 (unknown single-digit mode) advances k by 1', () => {
    const coloured = '\x1b[38;9mok\x1b[0m tail'
    expect(stripGhostSuggestion(coloured)).toBe('ok tail')
  })

  it('38;; (empty mode after 38) advances k by 1', () => {
    // Defensive: empty mode string after the 38 prefix. The k += 1
    // branch fires (mode !== '5' && mode !== '2').
    const coloured = '\x1b[38;;mok\x1b[0m tail'
    expect(stripGhostSuggestion(coloured)).toBe('ok tail')
  })

  it('48;5;240 (background-colour index, largest practical index) advances k by 3', () => {
    const coloured = '\x1b[48;5;240mbg\x1b[0m tail'
    expect(stripGhostSuggestion(coloured)).toBe('bg tail')
  })

  it('48;2;255;255;255 (background RGB white) advances k by 5', () => {
    const coloured = '\x1b[48;2;255;255;255mb\x1b[0m tail'
    expect(stripGhostSuggestion(coloured)).toBe('b tail')
  })

  it('48;5 (truncated, mode 5 but missing index) advances k by 3', () => {
    // The `k += 3` runs even though the index is missing. Subsequent
    // characters are emitted normally.
    const coloured = '\x1b[48;5mx\x1b[0m tail'
    expect(stripGhostSuggestion(coloured)).toBe('x tail')
  })
})

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
