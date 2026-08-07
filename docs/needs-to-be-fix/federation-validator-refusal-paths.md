# federation.ts validator-refusal 400 paths are unreachable in practice

## Source

* `src/web/routes/federation.ts:601` (POST /api/federation/peers add)
* `src/web/routes/federation.ts:650` (PATCH /api/federation/peers/:id)
* `src/web/routes/federation.ts:665` (DELETE /api/federation/peers/:id)
* `src/web/routes/federation.ts:703` (POST .../rotate-inbound-token)

Each of these runs `validateFederationConfig(next)` after mutating the
cached config and returns 400 when the validator returns a string.

## Why the path is unreachable

The mutations the SUT performs (add a peer with a fresh 64-char inbound
token, edit baseUrl/outboundToken/abandonWindowMinutes/shareCapabilitySummaries,
remove one peer, rotate the inbound token) cannot produce an invalid
config:

* The PATCH handler only edits baseUrl (validated earlier), outboundToken
  (validated earlier), abandonWindowMinutes (validated earlier), and
  shareCapabilitySummaries (validated earlier). Each mutation has its
  own inline 400 guard; if any of them fires the handler returns BEFORE
  the assembled config is re-validated.
* The DELETE handler filters the peer out of the array; the remaining
  peers are unchanged and the validator already accepted them.
* The rotate handler generates a fresh 64-char inbound token via
  `generatePeerInboundToken()`; the assembled config is guaranteed to
  pass.

The 400 fallback exists as a defensive guard against a future mutation
that could break validation, but today no production call site reaches
it.

## Test coverage workaround

The new tests in `src/__tests__/routes-federation-full.test.ts` wrap
`validateFederationConfig` through a `Proxy` on the config module so a
test can force the next call to return a string. Without that wrapper
the 400 branches would be uncovered. The wrapper survives
`vi.resetModules()` because it lives in the `vi.mock('../web/federation/config.js', ...)`
factory, which vitest re-applies on re-import.

## Suggested fix

Either delete the validator-refusal branches (they cannot fire), or
leave them as defensive guards and accept the Proxy-based test pattern.