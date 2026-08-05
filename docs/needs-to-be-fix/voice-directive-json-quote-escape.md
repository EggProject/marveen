# src/web/voice-directive.ts: only single quotes are escaped, so `"` / `\` in the state dir emits invalid JSON

## Location

`src/web/voice-directive.ts:54` — `buildTtsDirective`, the `escapedStateDir` step.

## Excerpt

```ts
const { chatId, stateDir, voiceModel } = opts
// Escape stateDir for embedding in a jq string argument
const escapedStateDir = stateDir.replace(/'/g, "'\\''")        // <-- line 54
return (
  ...
  `jq -n --arg t "A_VÁLASZOD_SZÖVEGE" '{"text":$t,"chat_id":"${chatId}","state_dir":"${escapedStateDir}","voice_model":"${voiceModel}"}' | ` +
  ...
)
```

The value lands in **two** nested quoting contexts at once:

1. a shell single-quoted string (`jq -n ... '{...}'`), and
2. a JSON string literal inside that shell string (`"state_dir":"…"`).

`replace(/'/g, "'\\''")` handles context 1 only. The comment says the escape is
"for embedding in a jq string argument", but no JSON escaping (`"` and `\`) is
applied, and `chatId` / `voiceModel` get no escaping at all.

## Failure scenario

`stateDir` is produced by `resolveAgentChannelStateDir`, which anchors two of its
three candidates at `homedir()` (`voice-directive.ts:15-16`). A home directory
(or an `AGENTS_BASE_DIR` parent path) containing a double quote or a backslash
propagates straight into the emitted JSON.

Concrete input:

```ts
buildTtsDirective({ chatId: '123', stateDir: '/tmp/a"b/channels/telegram', voiceModel: 'hu_HU-imre-medium' })
```

Emitted command fragment:

```
jq -n --arg t "A_VÁLASZOD_SZÖVEGE" '{"text":$t,"chat_id":"123","state_dir":"/tmp/a"b/channels/telegram","voice_model":"hu_HU-imre-medium"}'
```

Running that fragment (jq 1.7, verified):

```
jq: error: syntax error, unexpected IDENT, expecting '}' (Unix shell quoting issues?) at <top-level>, line 1:
{"text":$t,"chat_id":"1","state_dir":"/tmp/a"b/c","voice_model":"m"}
jq: 1 compile error
exit=3
```

Observable effect: the agent runs the directive, jq exits 3, the `curl` receives
empty stdin, `POST /api/voice/tts` never gets a valid body — and because the
directive's last line orders the agent to send **no** text reply
("Szöveges választ NE küldj"), the owner receives nothing at all. A silent drop,
not a degraded reply.

A backslash is the same class of bug with a different outcome: `C:\tmp` style or
a path segment ending in `\` turns `\"` into an escaped quote and shifts the
remaining JSON fields, so `voice_model` can be swallowed into the `state_dir`
string.

## Severity / reachability

Low likelihood, not zero. The only production caller
(`src/web/routes/voice.ts:126-141`) constrains the other two interpolations —
`agentId` is `^[a-zA-Z0-9_-]+$`, `chatId` is `^\d+$`, and `voiceModel` is gated
by `KNOWN_VOICE_MODELS` (`src/web/agent-config.ts:510-534`) — but `stateDir` is
**not** validated at that call site: it is whatever the filesystem layout under
`homedir()` / `AGENTS_BASE_DIR` yields. `"` and `\` are legal characters in POSIX
path components, so the input is reachable without any attacker, just an unusual
install path.

## Pinning test

`src/__tests__/voice-directive.test.ts` pins today's (buggy) behaviour so the fix
flips a visible assertion:

```ts
it('escapes single quotes but leaves double quotes raw (see docs/needs-to-be-fix/voice-directive-json-quote-escape.md)', () => {
  writeToken('tok')
  const directive = buildTtsDirective({ chatId: 'c1', stateDir: '/tmp/a"b/channels', voiceModel: 'tts-1' }) ?? ''
  // Pinned defect: the raw " passes through and breaks the JSON literal.
  expect(directive).toContain(`"state_dir":"/tmp/a"b/channels"`)
})
```

The single-quote case is covered by the sibling test and is *correct* for the
shell layer — it is only the JSON layer that is missing.

## Suggested direction

Do not hand-roll a second escaper. Build the JSON with `JSON.stringify` and then
apply the shell escape once to the finished document:

```ts
const payload = JSON.stringify({ text: '@@TEXT@@', chat_id: chatId, state_dir: stateDir, voice_model: voiceModel })
// jq needs $t spliced in unquoted; keep the placeholder swap explicit.
const jqFilter = payload.replace('"@@TEXT@@"', '$t').replace(/'/g, "'\\''")
```

`JSON.stringify` handles `"`, `\`, control characters and non-BMP input, and the
single shell escape then makes the whole filter safe inside `'…'`. This also
closes the (currently unreachable, but free) `chatId` / `voiceModel` holes.

Alternative, if the emitted command should stay hand-written: pass the values as
jq arguments rather than interpolating them into the filter —
`jq -n --arg t … --arg c "$CHAT" --arg d "$DIR" --arg m "$MODEL" '{text:$t,chat_id:$c,state_dir:$d,voice_model:$m}'` —
which removes the JSON layer from the problem entirely.

Per task rule "NEVER modify src/web/voice-directive.ts", no fix is applied here.
