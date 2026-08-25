# platform.ts: XDG_SESSION_TYPE=tty is misclassified as `linux-gui`

## Location

`src/platform.ts`, line 13:

```ts
const hasDisplay = !!(process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY'] || process.env['XDG_SESSION_TYPE'])
return hasDisplay ? 'linux-gui' : 'linux-server'
```

## What the line is trying to do

Decide whether the current Linux process is attached to a GUI display
(X11 / Wayland) so the rest of the codebase can pick between
`linux-gui` and `linux-server` semantics (keychain paths, browser
launcher, window-manager probes, etc.).

## Why this is wrong

`XDG_SESSION_TYPE` is a freedesktop-spec value, one of
`x11`, `wayland`, `tty`, `mir`, `unspecified`. The check above treats
ANY truthy value as proof of a GUI session, but `tty` (and
`unspecified`) explicitly mean a headless TTY session -- no display
server is attached. A console-only Linux box (a server, a CI runner,
a `tmux new-session` on a remote box without X forwarding) ends up
classified as `linux-gui`.

The real-world fallout is the same shape as the `keychain` / `launchctl`
family of platform-misclassification bugs already documented in this
folder: every consumer that branches on `PLATFORM === 'linux-gui'`
will now run its GUI arm on a host with no display, so:

- The `~/.Xauthority` probe (if one is ever added) will silently miss.
- A future "show notification" feature may try to open a libnotify
  socket that does not exist; the error will surface far from the
  actual cause.
- The condition is monotonic: once `XDG_SESSION_TYPE=tty` is exported
  by a headless box's PAM/env, every downstream caller trusts the
  wrong tag.

`DISPLAY` and `WAYLAND_DISPLAY` are also imperfect signals (both can
be set in containers without a working server, and neither is set in
pure Wayland without XWayland), but at least they correlate with "an X
client could talk to SOMETHING." `XDG_SESSION_TYPE=tty` does not even
correlate that loosely.

## Failure scenario

A Linux server install with no display server and the environment
shown below:

```
XDG_SESSION_TYPE=tty
```

`detect()` returns `'linux-gui'`. Downstream code expecting GUI
features (window-manager probes, browser-launcher, notification daemon)
executes its GUI arm against a host that has none of those, and the
errors look unrelated to platform detection.

## Pinning test

`src/__tests__/platform.test.ts` includes a test titled
"`treats XDG_SESSION_TYPE=tty as a GUI session (pinned as a bug)`".
It sets `XDG_SESSION_TYPE=tty` (with DISPLAY and WAYLAND_DISPLAY both
unset) and asserts `PLATFORM === 'linux-gui'`, which is the current
behaviour. When the bug is fixed, this test must be flipped to assert
`PLATFORM === 'linux-server'` so the regression cannot quietly come
back.

## Suggested fix

```ts
function isGuiSession(): boolean {
  if (process.env['DISPLAY']) return true
  if (process.env['WAYLAND_DISPLAY']) return true
  const xdg = process.env['XDG_SESSION_TYPE']
  if (xdg === 'x11' || xdg === 'wayland' || xdg === 'mir') return true
  return false
}
```

The `mir` branch is included for completeness even though Mir is
essentially dead upstream; treating it as "GUI" is safer than the
current "any truthy value" because `mir` is a real display server.

Per task rule "NEVER modify src/platform.ts" this requires an explicit
override from the user.

## Resolution

Replaced the truthy-XDG branch with an explicit allowlist (`x11`, `wayland`,
`mir`) so `XDG_SESSION_TYPE=tty` (and `unspecified`) now correctly resolves to
`linux-server`. Flipped the regression pin in `platform.test.ts` to assert
`linux-server` and removed the "currently buggy" framing. DISPLAY and
WAYLAND_DISPLAY paths are unchanged. Fix committed in cb68aad.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
