# G (channel-coordinator) — Executive summary

Synthesis of `01-module-state-analysis.md` (module/state lens) and the
framework-level inputs the task brief names as references
(`h-cross-cutting/00-summary.md`, `d-channel-provider/00-summary.md`,
`a-db/00-summary.md`, `b-config/00-summary.md`,
`f-agent-subsystem/00-summary.md`, `e-process-lock/00-summary.md`,
plus `review-correctness.md` + `review-completeness.md`). Cross-checked
against `src/channel-coordinator.ts` (442 LOC, read in full on
2026-08-30), `src/channel-coordinator/{telegram-client,ingest,liveness,
provider-poller-match}.ts`, and the entry-point guard at
`src/channel-coordinator.ts:435`. The task brief's referenced
`02-type-interface-analysis.md` does **not** exist in this directory as
of 2026-08-30 — the type/interface claims used below are taken from the
state analysis and cross-checked against the source files cited inline.
**Planning only — no source files modified.**

---

## Thesis

G is the **smallest blast radius** of the eight subsystems in the
framework plan and a structural anomaly: `src/channel-coordinator.ts` is
a single-process BACKFILL poller that runs as a separate launchd unit
(`com.marveen.channel-coordinator`), has zero production importers
(it is invoked via launchd or `node dist/channel-coordinator.js`, never
imported), and is gated from import-time execution by the
`import.meta.url === pathToFileURL(process.argv[1]).href` guard at
`channel-coordinator.ts:435`. The refactor produces four class
candidates — `TelegramClient` (wraps `telegram-client.ts`), `IngestWorker`
(wraps the persistence layer in `ingest.ts`), `LivenessTracker` (wraps
the streak/cooldown state in `channel-coordinator.ts:101-106`), and the
orchestrator `ChannelCoordinator` (wraps the entry file) — with the
existing `TelegramApiError` class (`telegram-client.ts:45-54`) preserved
verbatim. The single non-obvious structural call is **"load-bearing
entry-point guard stays free"**: the L435 guard must survive as a
free-standing top-level expression even after the orchestrator becomes
a class, because the class form must be importable by tests without
starting a second coordinator process.

---

## Scope

### Files this plan TOUCHES (4 files)

| File | LOC | Why | Phase |
|---|---:|---|---|
| `src/channel-coordinator.ts` | 442 | extract `ChannelCoordinator` class + `LivenessTracker` class; preserve `installSignalHandlers` test seam; keep `main()` + entry-point guard as a free function | G.4, G.5, G.6 |
| `src/channel-coordinator/telegram-client.ts` | 227 | introduce `TelegramClient` class wrapping the 7 free functions (`mapUpdate`, `getUpdates`, `probeHighWater` + 4 format/split/validate helpers); keep `TelegramApiError` as a class; preserve free-function exports during migration | G.1 |
| `src/channel-coordinator/ingest.ts` | 231 | introduce `IngestWorker` class wrapping the 7 free functions + 1 class singleton (`db`); re-export `COORDINATOR_AGENT_ID` so the 3 external const-only consumers (`web/agent-message-wrap.ts:21`, `web/federation/local-catalog.ts:8`, `web/routes/messages.ts:11`) keep working | G.2 |
| `src/channel-coordinator/liveness.ts` | 288 | introduce `LivenessTracker` class for the streak/cooldown state currently held in `channel-coordinator.ts:101-106` (the liveness *probe* functions stay free — they are pure utility functions consumed by both `ChannelCoordinator` and 2 external web/ files) | G.3 |

### Files this plan does NOT touch

- **`src/channel-coordinator/provider-poller-match.ts`** — 92 LOC, pure utility + frozen regex constants. The 1 consumer is `liveness.ts:18`. No instance state. Stays as a free-function module per `d-channel-provider/00-summary.md` "leave the 18 pure utility modules as namespaces" precedent and `CLAUDE.md §3` ("Don't 'improve' adjacent code").
- **`src/__tests__/channel-coordinator-*.test.ts`** (11 files) and **`src/__tests__/provider-poller-match.test.ts`** — they exercise the 4 G files directly via free-function imports today; tests get *updated* to match the class API in later phases, but their layout, runner (`bun --bun vitest`), and coverage targets are not in scope (consistent with `00-summary.md` "Explicitly OUT OF SCOPE").
- **The `import.meta.url === pathToFileURL(process.argv[1]).href` guard at `channel-coordinator.ts:435`** — load-bearing for test isolation (per `01 §10` it prevents `vi.mock` substitutes from starting a second coordinator). Stays as a top-level expression even after `main()` becomes a `ChannelCoordinator.start()` method.
- **`src/__tests__/messages-routes.test.ts:101`** (`vi.mock('../channel-coordinator/ingest.js', …)` factory substituting `COORDINATOR_AGENT_ID`) — preserved because `IngestWorker` keeps `COORDINATOR_AGENT_ID` as a static or instance property that the mock factory can still resolve.

---

## Dependency: what other subsystems expect from G

| Consumer | G deliverable it needs | What it expects | Blocking? |
|---|---|---|---|
| **`web/agent-message-wrap.ts:21`** | `COORDINATOR_AGENT_ID` const | Used to filter `agent_messages.from_agent`. Must resolve at module import time. | **Yes** for the export shape; **No** for the class form (a static field or instance property works). |
| **`web/federation/local-catalog.ts:8`** | `COORDINATOR_AGENT_ID` const | Same as above. | Same. |
| **`web/routes/messages.ts:11`** | `COORDINATOR_AGENT_ID` const | Same as above. | Same. |
| **`src/web/channel-monitor.ts:50`** | `getClaudePidForSession, hasChannelPluginAlive, probeChannelPluginLiveness` | The 3 liveness helpers consumed by the dashboard's channel-monitor (per `01 §11`). | **Yes** — `liveness.ts` keeps these as free functions. |
| **`src/web/schedule-mcp-precheck.ts:22`** | `getClaudePidForSession` | The single liveness helper used by the schedule precheck. | **Yes** — same. |
| **`src/notify.ts:2`** (via `web.ts` route handlers) | `ChannelProvider` from D | The 5 sendMessage/sendPhoto paths via `getProvider(type)`. G does not own this — D does. | No. |
| **`src/index.ts:378-410`** shutdown | `ChannelCoordinator.stop()` integration | Today `index.ts` does NOT touch `channel-coordinator.ts` (zero importers); the coordinator runs as a separate process and is killed by launchd. After G.4, the dashboard's shutdown sequence is unaffected. | **No** — coordinator lifecycle is process-scoped, not App-scoped. |
| **H (logger migration)** | `LoggerLike` interface (H.1) | `channel-coordinator.ts` has 8 logger call sites (verified by inspection of `channel-coordinator.ts:150, 173, 244, 252, 254, 275, 293, 295, 303, 333, 340, 343, 355, 374, 411, 427, 437`); per `00-summary.md` G classes (specifically `ChannelCoordinator`) take `LoggerLike` in their constructor. | **Yes** for G.7 (LoggerLike adoption). |
| **D (`ChannelEnv`)** | `config.ts:324-326` helpers | `ChannelCoordinator` reads `CHANNEL_PROVIDER` (`channel-coordinator.ts:57`); D's `ChannelEnv` is consumed at the `config.ts` level, not in G. | No. |
| **A (`DbClient`)** | `Database` handle | `IngestWorker` opens its OWN handle (per `01 §10` "the coordinator is a SEPARATE process from the dashboard, so it cannot share the dashboard's sqlite singleton"). After A.1, `IngestWorker` may receive a `DbClient` via constructor OR open its own handle — per `01 §10` the latter is correct. | No. |

**What G does NOT owe anyone.** G does not call into `web/`, `db.ts` (the dashboard singleton), or `federation/`. The dashboard's `DbClient` (A.1) and the coordinator's own DB handle are separate processes.

---

## Top 3 risks specific to G

1. **`installSignalHandlers` ownership in the class form** (`channel-coordinator.ts:407-420`). Today the function registers SIGTERM/SIGINT handlers at `main()` startup (L426); the `stopping` latch at L103 is module-level. If `ChannelCoordinator` takes ownership of signal handlers in its constructor, re-running the constructor (e.g., from a test, or after `vi.resetModules()`) would double-register and the SIGTERM latch would fire twice. The mitigation is a `process.listenerCount` guard at construction time, or — per the safer alternative — keeping `installSignalHandlers` as a free function that the test bootstrap can call explicitly. Detail in `06-risks-and-mitigations.md` GR1.

2. **The 4 mutable lets at `channel-coordinator.ts:101-106` (`state`, `downStreak`, `stopping`, `nativeConfirmedUpUntil`) must move together into one class instance.** Per `01 §1.2`, `runLoop` (L311-403) reads AND writes all 4 within its `while (!stopping)` body (the L322-339-372-393 reads/writes are interleaved across all four). Splitting them across 4 separate classes introduces ordering hazards; collapsing them into 4 private fields of `ChannelCoordinator` is the only safe move. After class extraction, a race between `stop()` (the SIGTERM latch) and `runLoop()` is structurally impossible (single-threaded JS, single process) but the `setTimeout(…, 3000)` at L412 introduces a 3-second window where `stopping = true` and `closeIngestDb()` is deferred — the class form must preserve this 3-second drain. Detail in `06-risks-and-mitigations.md` GR2.

3. **`TelegramApiError` migration: class survives, `kind` discriminator survives, `instanceof` checks survive.** Per `h-cross-cutting/03-class-boundaries.md:305-311`, `TelegramApiError` is the **only class** in G today (one of the 9 existing error classes in the codebase per `review-completeness.md` CE-1) and the only one whose `kind` discriminator drives control flow at 5 sites in `channel-coordinator.ts` (L335, L338, L366, L372, L378). The H.4 `AppError` base picks `RequestBodyTooLargeError` + `PeerResponseTooLargeError` first; `TelegramApiError` is deferred longest. The D.4 `TestRunMarkingDecorator` uses `ChannelProvider`, which has its own error path independent of `TelegramApiError`. The G migration must NOT split `TelegramApiError` into a subclass per `kind` (rejected in `h-cross-cutting/03-class-boundaries.md:307-311` per `review-completeness.md` OE-1/OE-2). Detail in `06-risks-and-mitigations.md` GR3.

---

## Migration order inside G

```
G.1  TelegramClient class extraction       (introduce alongside; free fns survive)
  |
G.2  IngestWorker class extraction         (introduce alongside; COORDINATOR_AGENT_ID re-exported)
  |
G.3  LivenessTracker class extraction      (introduce alongside; free liveness probe fns survive)
  |
G.4  ChannelCoordinator class extraction   (orchestrator; 4 lets become private fields)
  |
G.5  installSignalHandlers decision       (class method OR keep free fn — see GR1)
  |
G.6  Consumer migration (channel-coordinator.ts main() entry; index.ts unaffected)
  |
G.7  LoggerLike adoption                   (depends on H.1)
  |
G.8  Free function removal                 (gated on every consumer migrated)
```

Rationale:

- **G.1 first** because `telegram-client.ts` is the leaf module — zero module-level state, zero consumers outside G itself (1 internal: `channel-coordinator.ts:36`), and the existing `TelegramApiError` class is the only existing class surface to preserve. Extracting `TelegramClient` proves the class-form-vs-free-function coexistence pattern (per `d-channel-provider/03-class-boundaries.md:166-169` and `b-config/03-class-boundaries.md:168` precedents) before the orchestrator's more complex state surface is touched.
- **G.2 next** because the `db` singleton at `ingest.ts:25` is the simplest class-extraction surface (1 mutable binding + 8 free functions), but the `COORDINATOR_AGENT_ID` re-export shape (per `01 §11`) is the only constraint — the 3 external const-only consumers must keep working without modification until G.8.
- **G.3 next** because the 4 mutable lets at `channel-coordinator.ts:101-106` are the *conceptual* liveness tracker (streak + cooldown), but they live in the entry file today; the actual liveness *probe* functions in `liveness.ts` stay free. The class form here is a 4-field POJO-like wrapper around the streak state — the smallest of the 4 classes.
- **G.4 fourth** because `ChannelCoordinator` is the orchestrator and depends on the 3 other classes (it takes `TelegramClient` + `IngestWorker` + `LivenessTracker` as constructor args per the brief). Building it last in the G sequence means the constructor signature is settled and `installSignalHandlers` (G.5) can be designed against the actual `ChannelCoordinator` shape.
- **G.5 separate phase** because the signal-handler ownership decision (class method vs free function) is a design choice with measurable tradeoffs (per GR1) that deserves its own phase and review. Default recommendation: **keep `installSignalHandlers` as a free function** — it is called once from `main()` (L426), and the `process.listenerCount` guard at module-init time is simpler than a class-method-side guard.
- **G.6 minimal** because the entry file is the only consumer (zero importers per `01 §11`). The consumer migration is the `main()` rewrite at `channel-coordinator.ts:422-431` to construct a `ChannelCoordinator` and call `.start()`. The entry-point guard at L435 stays verbatim.
- **G.7 deferred to H.1** per `h-cross-cutting/00-summary.md` Dependency table: `ChannelCoordinator` takes `LoggerLike` in its constructor only after H.1 lands the interface.
- **G.8 last inside G, gated on every consumer migrated.** The gate is `grep -rln "from ['\"]\\./channel-coordinator\\/telegram-client\\.js['\"]" src/ --include='*.ts' | grep -v __tests__` returning only `src/channel-coordinator.ts` itself (and likewise for the 3 other files). The 10 dedicated `channel-coordinator-*.test.ts` files and the 4 liveness mocks (`channel-monitor.test.ts:259`, `channel-monitor-baseline.test.ts:222`, `channel-monitor-coverage.test.ts:243`, `schedule-mcp-precheck-full.test.ts:80`) must be updated to class API; removed in G.8 only after they migrate.

---

## Cross-references (verified 2026-08-30)

- `src/channel-coordinator.ts:57` — `const PROVIDER = CHANNEL_PROVIDER`
- `src/channel-coordinator.ts:98` — `const PID_FILE = join(STATE_DIR, 'coordinator.pid')`
- `src/channel-coordinator.ts:101-106` — 4 module-level lets (`state`, `downStreak`, `stopping`, `nativeConfirmedUpUntil`)
- `src/channel-coordinator.ts:233-258` — `processBatch`
- `src/channel-coordinator.ts:270-298` — `reconcilePending`
- `src/channel-coordinator.ts:302-307` — `fatalExit`
- `src/channel-coordinator.ts:311-403` — `runLoop` (state machine)
- `src/channel-coordinator.ts:407-420` — `installSignalHandlers`
- `src/channel-coordinator.ts:422-431` — `main`
- `src/channel-coordinator.ts:435` — entry-point guard
- `src/channel-coordinator/telegram-client.ts:45-54` — `class TelegramApiError`
- `src/channel-coordinator/telegram-client.ts:143-190` — `getUpdates`
- `src/channel-coordinator/telegram-client.ts:201-226` — `probeHighWater`
- `src/channel-coordinator/ingest.ts:23` — `COORDINATOR_AGENT_ID`
- `src/channel-coordinator/ingest.ts:25` — `let db: Database | null = null`
- `src/channel-coordinator/ingest.ts:27-91` — `initIngestDb`

---

## [ASSUMPTION] markers

- [ASSUMPTION: `02-type-interface-analysis.md` referenced in the task brief is **absent** in this directory as of 2026-08-30 — the only file present is `01-module-state-analysis.md` plus this plan. The type/interface claims used in `03-class-boundaries.md` and `04-generic-interfaces.md` are taken from `01 §Per-file inventory` + the source files cited inline. If `02` is produced later, the cross-check should be repeated.]
- [ASSUMPTION: G does NOT introduce a `ChannelPairingStore` dependency (per `01 §11.2`, no production coupling exists today between the coordinator and the dashboard's `channel-pairing.ts`). If A's `ChannelPairingStore` (per `a-db/03-class-boundaries.md §A13`) introduces a G coupling, the dependency table above must be revisited.]
- [ASSUMPTION: `ChannelCoordinator` is constructed once per process (in `main()`, after the L435 entry-point guard passes). Per `01 §11`, the file is run as a process not imported; the class form preserves this — the guard stays at module top level, the `main()` body becomes the construction site.]

---

**End of G executive summary. No source files modified.**
