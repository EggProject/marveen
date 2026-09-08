# C.1 AuthGate code-review --fix commit (3663c3e)

The /code-review max --fix run on 2026-09-08 applied 6 fixes to the working tree:

1. **web-server.test.ts mock factory** (lines 201-205): added `defaultGate` aggregate + `getRouteContextAuth` projection helper. Resolved 62 of 62 failures caused by the C.1 refactor's switch from free functions (`resolveAuth`, `requiresAuth`, `isFederationWireEndpoint`) to `defaultGate.X()` singleton methods.

2. **auth-gate.ts AuthGateDeps** (line 52): dropped `LoggerLike` and `log` field (dead DI surface after the factory body never used `deps.log`). Updated `defaultGate` init to omit the `log` arg.

3. **auth-gate.ts resolveAuth wrapper** (line 138): documented `_dashboardToken` parameter as a 5-arg backward-compat shim for the 5 test files; suppressed the lint warning via inline comment.

4. **auth-gate.test.ts**: dropped `noopLog` fixture (no longer needed after the log field removal); `createAuthGate` calls updated to `createAuthGate({ dashboardToken: TOKEN })`.

6. **federation-capabilities.test.ts** (line 36): added `delete process.env.DASHBOARD_TOKEN` in `beforeEach` so the test-dashboard-token setup file does not shadow the on-disk `.dashboard-token` the suite writes at line 96.

6. **federation-capabilities-cov.test.ts** (lines 190-194): updated stale comment about the env-first branch being "cold" (it is now always taken in the default test env because of test-dashboard-token.ts).

7. **test-dashboard-token.ts** (line 9): added trailing newline.

Per CLAUDE.md §7 post-fix commit rule, the session mainloop committed these as `3663c3e` on `refactor/classbase` with author `EggProjectTeams <eggprojectteams@gmail.com>`.

Verification: tsc clean, vitest 160/160 PASS on the 3 directly-touched test files (`auth-gate.test.ts`, `web-server.test.ts`, `federation-capabilities.test.ts`). Full suite 11670/11671 (1 pre-existing unrelated failure in `scripts/agent-memory/cli/run.test.ts`).

The 2 Skipped findings (wrapper removal, factory revert) are recorded in Honcho conclusions `c1-authgate-code-review-skipped-wrapper-removal` and `c1-authgate-code-review-skipped-factory-revert` (and their shared-memory counterparts) for release-checklist-prevention.

## Why this entry was added

Honcho `create_conclusion` timed out at 150s for this entry specifically (the other 5 C.1 entries saved successfully to Honcho). Per CLAUDE.md §7 Memory dual-write rule, the project-local record must exist regardless of Honcho availability. This shared-memory file is the durable backup.

To sync to Honcho when the MCP server is responsive again:

```
honcho create_conclusion --content "$(cat .claude/shared-memory/c1-authgate-code-review-fix-commit.md)"
```

Or via the agent-memory script (when Honcho is available):

```
pnpm claude:memory write c1-authgate-code-review-fix-commit .claude/shared-memory/c1-authgate-code-review-fix-commit.md
```