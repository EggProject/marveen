# C.1 AuthGate spec-deviation (env: ChannelEnv)

The `docs/refactor-to-classbase/c-web/05-refactor-roadmap.md:37` spec listed `env: ChannelEnv` in `AuthGateDeps`. The C.1 implementation dropped `env` because `auth-gate.ts` never imports or calls any `ChannelEnv` method (verified by grep over `src/web/auth-gate.ts:76-121` — `resolveAuth`, `requiresAuth`, `isFederationWireEndpoint`, `parseCookies` do not consume any `ChannelEnv` field).

`ChannelEnv` is reserved for the C.7 federation cluster, which may re-introduce it if a downstream component requires it.

Final `AuthGateDeps` shape after the fix-commit `3663c3e` (which removed the unused `log` field): `{ readonly dashboardToken: string }` — single field, pure value.

Commit `ebb7dba` (pre-fix) on `refactor/classbase`, 2026-09-08.

## Dual-write status

- Honcho conclusion `c1-authgate-spec-deviation-env`: saved successfully (response: "Saved conclusion")
- This shared-memory file: created as backup per CLAUDE.md §7 Memory dual-write rule