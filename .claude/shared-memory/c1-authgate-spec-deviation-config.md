# C.1 AuthGate spec-deviation (config: Config)

The `docs/refactor-to-classbase/c-web/05-refactor-roadmap.md:37` spec listed `config: Config` in `AuthGateDeps`. The C.1 implementation dropped `config` because `auth-gate.ts` never imports `Config` or `PROJECT_ROOT` (verified by grep).

The deps surface would be gratuitous DI: `AuthGate.resolveAuth` only needs the dashboard token, which comes from `loadOrCreateDashboardToken()` at module init (not stored on the deps bundle). The `defaultGate` singleton calls `loadOrCreateDashboardToken()` once during construction; thereafter the dashboard token is captured in the closure and never re-read.

The fix-commit `3663c3e` further dropped the `log: LoggerLike` field (also unused in the factory body), leaving `AuthGateDeps = { readonly dashboardToken: string }` — a single value field that maps to a single closure capture.

Commit `ebb7dba` (pre-fix) on `refactor/classbase`, 2026-09-08.

## Dual-write status

- Honcho conclusion `c1-authgate-spec-deviation-config`: saved successfully
- This shared-memory file: created as backup per CLAUDE.md §7