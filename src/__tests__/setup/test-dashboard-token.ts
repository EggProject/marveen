// Sets the dashboard-token env var before any test module loads. The auth-gate
// module's eager module-init defaultGate reads this via loadOrCreateDashboardToken(),
// which consults process.env.DASHBOARD_TOKEN first. Without this setupFile,
// the token would be auto-generated per process start, breaking the
// fleet-regression assertions in src/__tests__/auth-gate.test.ts.
//
// This file does NOT touch store/, does NOT mutate config, and does NOT depend
// on any other setupFile. It runs first, before assert-not-live-install.ts.
process.env.DASHBOARD_TOKEN = 'a'.repeat(64)