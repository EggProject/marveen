// Routes-side coverage for the reauth-detection pure helper.
//
// NOTE: the canonical source file lives at `src/web/reauth-detect.ts`, not at
// `src/web/routes/reauth-detect.ts` (the original task target path). The
// existing suite `src/__tests__/reauth-detect.test.ts` already drives the
// helper to 100% coverage; this companion suite re-asserts the same surface
// from the "routes" naming angle so the coverage gate stays green regardless
// of which import path the suite reaches the module through. See
// `docs/needs-to-be-fix/routes-reauth-detect-missing-source-path.md`.
//
// The helper is intentionally dependency-free (no db / config / logger /
// auth-gate / auth-sessions imports), so the mocks listed in the task brief
// are not needed here. We import the real module directly and drive every
// branch through deterministic pane fixtures.

import { describe, it, expect } from 'vitest'
import {
  detectReauthNeeded,
  type ReauthState,
} from '../web/reauth-detect.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a pane string by joining lines with `\n`. Trailing newline
 *  preserved when `trailing === true` to exercise the literal-empty-tail
 *  branch in `tailOf`. */
function pane(lines: string[], trailing = false): string {
  return trailing ? lines.join('\n') + '\n' : lines.join('\n')
}

/** A live-status-line shaped "healthy" tail (an input box with the context
 *  readout above it, exactly as Claude Code renders after a successful
 *  login). The two `─{10,}` borders let `liveStatusRegion` find the box. */
function healthyLiveTail(): string {
  return pane([
    '✻ Crunched for 0s',
    '                                        ~290k uncached · /clear to start fresh',
    '──────────────────────────────────────────────────────────────── Devy ──',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ])
}

/** A live-status-line shaped "broken" tail: the box is present but the live
 *  status region immediately above it still says the auth marker. */
function brokenLiveTail(marker: string): string {
  return pane([
    '  ⎿  Login interrupted',
    '❯ /login',
    '  ⎿  Login interrupted',
    marker,
    '────────────────────────────────────────────────────────────── Finy ──',
    '❯ ',
    '──────────────────────────────────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ])
}

// ---------------------------------------------------------------------------
// Null / empty / falsy inputs -- the early `if (!pane)` guard.
// ---------------------------------------------------------------------------

describe('detectReauthNeeded: nullish / empty inputs', () => {
  it('returns needsReauth:false for null with no reason', () => {
    const r = detectReauthNeeded(null)
    expect(r).toEqual({ needsReauth: false })
    expect(r.reason).toBeUndefined()
  })

  it('returns needsReauth:false for undefined with no reason', () => {
    const r = detectReauthNeeded(undefined)
    expect(r).toEqual({ needsReauth: false })
    expect(r.reason).toBeUndefined()
  })

  it('returns needsReauth:false for the empty string with no reason', () => {
    const r = detectReauthNeeded('')
    expect(r).toEqual({ needsReauth: false })
    expect(r.reason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// REAUTH_MARKERS -- one test per marker, in declaration order so the
// "most-specific first" comment in the source stays load-bearing.
// ---------------------------------------------------------------------------

describe('detectReauthNeeded: marker detection', () => {
  it('detects the first-run "Select login method" onboarding picker', () => {
    const r = detectReauthNeeded(
      pane([
        ' Welcome to Claude Code',
        '',
        ' Select login method:',
        '',
        ' ❯ 1. Claude account with subscription',
        '   2. Anthropic Console account',
      ]),
    )
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('First-run onboarding picker (Select login method)')
  })

  it('detects the browser sign-in URL screen (Use the url below...)', () => {
    const r = detectReauthNeeded(
      pane([
        ' Use the url below to sign in:',
        '',
        ' https://claude.ai/oauth/authorize?code=...',
      ]),
    )
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('Browser sign-in screen (first-run gate)')
  })

  it('detects the browser sign-in code-paste screen (Paste code here...)', () => {
    const r = detectReauthNeeded(
      pane([
        ' Use the url below to sign in:',
        ' https://claude.ai/oauth/authorize?code=...',
        '',
        ' Paste code here if prompted >',
      ]),
    )
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('Browser sign-in screen (first-run gate)')
  })

  it('detects "Invalid authentication credentials"', () => {
    const r = detectReauthNeeded('API Error: 401 Invalid authentication credentials')
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('Invalid authentication credentials (401)')
  })

  it('detects "Please run /login"', () => {
    const r = detectReauthNeeded(pane(['Some output', '  Please run /login']))
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('Please run /login')
  })

  it('detects "Not logged in"', () => {
    // Use ONLY the "Not logged in" marker -- "Please run /login" is matched
    // first in the ordered REAUTH_MARKERS list and would shadow it.
    const r = detectReauthNeeded('Not logged in · run the auth flow again')
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('Not logged in')
  })

  it('detects bare "API Error: 401"', () => {
    const r = detectReauthNeeded('request failed: API Error: 401')
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('API Error: 401')
  })

  it('detects "OAuth token has expired"', () => {
    const r = detectReauthNeeded('Your OAuth token has expired.')
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('OAuth token expired')
  })

  it('detects "OAuth token expired" (without "has")', () => {
    const r = detectReauthNeeded('OAuth token expired; please re-authenticate.')
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('OAuth token expired')
  })

  it('detects "Invalid API key"', () => {
    const r = detectReauthNeeded('Error: Invalid API key · ANTHROPIC_API_KEY')
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('Invalid API key')
  })

  it('detects "session has expired ... /login"', () => {
    const r = detectReauthNeeded('Your session has expired. Please /login again.')
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('Session expired')
  })

  // Ordering: the more specific "Invalid authentication credentials" wins over
  // the looser "API Error: 401" when both are in the same tail. This locks in
  // the source comment "Ordered most-specific first".
  it('prefers the most-specific marker when several are present', () => {
    const r = detectReauthNeeded(
      pane([
        'API Error: 401',
        'Invalid authentication credentials',
        'Please run /login',
      ]),
    )
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('Invalid authentication credentials (401)')
  })
})

// ---------------------------------------------------------------------------
// tailOf / liveStatusRegion interactions -- the two-region dispatch.
// ---------------------------------------------------------------------------

describe('detectReauthNeeded: region selection', () => {
  it('uses the last TAIL_LINES when there is no input box', () => {
    // Marker is in the tail window -- fires.
    const fires = detectReauthNeeded(
      pane([
        ...Array.from({ length: 20 }, (_, i) => `work line ${i}`),
        'Please run /login',
      ]),
    )
    expect(fires.needsReauth).toBe(true)

    // Same shape, marker pushed just outside the 15-line tail -- no fire.
    const quiet = detectReauthNeeded(
      pane([
        ...Array.from({ length: 20 }, (_, i) => `work line ${i}`),
        'Please run /login',
        // 16 filler lines push the marker past the 15-line window.
        ...Array.from({ length: 16 }, (_, i) => `tail filler ${i}`),
      ]),
    )
    expect(quiet.needsReauth).toBe(false)
  })

  it('falls back to the 15-line tail when only ONE box border is present', () => {
    // Only one long `─` line: liveStatusRegion returns null (needs >=2), and
    // the helper falls back to the last 15 lines. The marker sits inside that
    // window so it must fire.
    const r = detectReauthNeeded(
      pane([
        'Please run /login',
        '──────────────────────────────────────────────────────────────── Devy ──',
        '❯ ',
      ]),
    )
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toBe('Please run /login')
  })

  it('uses the live status region (not the transcript) when both box borders are present', () => {
    // The first-run picker marker is ONLY in scrollback, well above the box.
    // liveStatusRegion() trims the region to the area around the box, so the
    // marker should NOT be visible to the marker scan.
    const r = detectReauthNeeded(
      pane([
        '❯ a "Select login method" képernyőről beszéltünk',
        ...Array.from({ length: 20 }, (_, i) => `work line ${i}`),
        '──────────────────────────────────────────────────────────────────────',
        '❯ ',
        '──────────────────────────────────────────────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ]),
    )
    expect(r.needsReauth).toBe(false)
  })

  it('reads the live status line above the input box when it carries the failure', () => {
    const r = detectReauthNeeded(brokenLiveTail('                                            Not logged in · Run /login'))
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toMatch(/not logged in/i)
  })

  it('returns no-fire when the live status line is healthy even though scrollback mentions the failure', () => {
    const r = detectReauthNeeded(
      pane([
        '  1 in_progress Devy kártya </scheduled-task>',
        '  ⎿  Not logged in · Please run /login',
        '✻ Crunched for 0s',
        '❯ /login',
        '  ⎿  Login interrupted',
        '❯ /login',
        '  ⎿  Login successful',
        '                                        ~290k uncached · /clear to start fresh',
        '──────────────────────────────────────────────────────────────── Devy ──',
        '❯ ',
        '────────────────────────────────────────────────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
      ]),
    )
    expect(r.needsReauth).toBe(false)
  })

  it('treats a healthy live status region as a clean bill of health', () => {
    expect(detectReauthNeeded(healthyLiveTail()).needsReauth).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ESCALATION_QUOTE_MARKERS -- the self-quote guard. Two Hungarian strings
// from buildEscalationMessage / buildQuietSummaryMessage in reauth-healer.ts.
// ---------------------------------------------------------------------------

describe('detectReauthNeeded: self-quote guard', () => {
  it('ignores a tail that quotes the OAuth-token escalation line', () => {
    const r = detectReauthNeeded(
      pane([
        ...Array.from({ length: 10 }, (_, i) => `work line ${i}`),
        '🔐 A(z) bigme ágens halott OAuth tokent jelez (Please run /login) több mint ~9 perce.',
        'Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb), automatikusan nem gyógyítható.',
      ]),
    )
    expect(r.needsReauth).toBe(false)
  })

  it('ignores a tail that quotes the picker-reason escalation (First-run onboarding picker)', () => {
    const r = detectReauthNeeded(
      pane([
        ...Array.from({ length: 10 }, (_, i) => `work line ${i}`),
        '🔐 A(z) boni ágens halott OAuth tokent jelez (First-run onboarding picker (Select login method)) több mint ~9 perce.',
        'Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb), automatikusan nem gyógyítható.',
      ]),
    )
    expect(r.needsReauth).toBe(false)
  })

  it('ignores a tail that quotes the quiet-hours morning summary', () => {
    const r = detectReauthNeeded(
      pane([
        '🔐 Reggeli token-összegzés: az éjszakai csendes sáv (23:00-06:00) alatt elnyomott riasztások. MOST IS halott tokent jelez:',
        '• bigme: Invalid authentication credentials (401) (~45 perce)',
        'Manuális browser /login kell a dashboardon (az ügynök kártyáján a "Bejelentkezés" gomb).',
      ]),
    )
    expect(r.needsReauth).toBe(false)
  })

  it('matches the guard case-insensitively (the source uses /i)', () => {
    const r = detectReauthNeeded(
      'A(Z) BIGME áGENS HALOTT OAUTH TOKENT JELEZ (Please run /login)',
    )
    expect(r.needsReauth).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Negative cases that must NOT fire -- belt-and-braces over the marker list.
// ---------------------------------------------------------------------------

describe('detectReauthNeeded: negative cases', () => {
  it('does not fire on bare "/login" used as a chat topic', () => {
    const r = detectReauthNeeded(
      pane([
        '❯ hogyan működik a /login parancs?',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ]),
    )
    expect(r.needsReauth).toBe(false)
  })

  it('does not fire on a normal idle pane', () => {
    const r = detectReauthNeeded(
      pane([
        '✻ Sautéed for 1m',
        '❯',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
      ]),
    )
    expect(r.needsReauth).toBe(false)
  })

  it('does not fire when the marker is in scrollback above the tail', () => {
    const scrollback = pane([
      'reviewing: detects "Invalid authentication credentials"',
      'and "Please run /login" and "API Error: 401"',
      ...Array.from({ length: 20 }, (_, i) => `work line ${i}`),
      '❯',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ])
    expect(detectReauthNeeded(scrollback).needsReauth).toBe(false)
  })

  it('does not fire on a pane that is exactly one line shorter than the threshold (14 lines)', () => {
    // tailOf slices `lines.length - n`; with 14 lines and n=15 we get all 14.
    // No marker anywhere -> clean.
    const lines = Array.from({ length: 14 }, (_, i) => `line ${i}`)
    expect(detectReauthNeeded(pane(lines)).needsReauth).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ReauthState shape contract
// ---------------------------------------------------------------------------

describe('detectReauthNeeded: return-shape contract', () => {
  it('returns a plain object that satisfies ReauthState on the negative path', () => {
    const r: ReauthState = detectReauthNeeded(null)
    expect(typeof r).toBe('object')
    expect(r.needsReauth).toBe(false)
    expect(r.reason).toBeUndefined()
  })

  it('returns a ReauthState with reason on the positive path', () => {
    const r: ReauthState = detectReauthNeeded('Please run /login')
    expect(r.needsReauth).toBe(true)
    expect(typeof r.reason).toBe('string')
    expect(r.reason!.length).toBeGreaterThan(0)
  })

  it('returns exactly one of {needsReauth:true, reason:string} or {needsReauth:false}', () => {
    const samples: Array<string | null | undefined> = [
      null,
      undefined,
      '',
      'Some idle pane',
      'Please run /login',
      'API Error: 401',
      'Not logged in',
      healthyLiveTail(),
      brokenLiveTail('OAuth token has expired'),
    ]
    for (const s of samples) {
      const r = detectReauthNeeded(s)
      if (r.needsReauth) {
        expect(typeof r.reason).toBe('string')
        expect(r.reason!.length).toBeGreaterThan(0)
      } else {
        expect(r.reason).toBeUndefined()
      }
    }
  })
})
