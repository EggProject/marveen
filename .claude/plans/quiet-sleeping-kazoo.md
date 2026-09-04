# Cycle 23 — env-update-mode-downgrade (1 sor, HIGH)

## Context

A `src/env.ts:87` `updateEnvFile()` minden hívása a `.env` fájlt **0644**-re rontja le, pedig a telepítő általában `0600`-zal hozza létre (titkos fájl: `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, stb.). A bug az `atomicWriteFileSync` umašk-alapú viselkedéséből fakad: az új tmp inode a process umask-jával jön létre, és mivel `env.ts` nem adja át a `mode` opciót, a célfájl `0600` jogosultsága a `renameSync` során elvész.

Ez pontosan a 2026-07-27-i teszt-incident hibaosztálya (`env.test.ts unlink+rewrote the live .env (mode 600 -> 644)`), csak PRODUKCIÓS kódút csinálja ugyanazt. Bármely fleet-import / identity takeover (`MAIN_AGENT_ID` + `CHANNEL_PROVIDER` mirror) után a teljes titok-készletet a gépen lévő összes nem-root user olvashatja — észrevétlenül, mert az `updateEnvFile` sikerrel tér vissza, a tartalom helyes, csak a jogosultság romlott el.

A user a 21 fennmaradt 1 soros jelöltből ezt választotta (HIGH severity, security domain).

## Fix

### 1. `src/env.ts:87` — 1 sor (apply atomicWriteFileSync mode opció)

```diff
-  atomicWriteFileSync(envPath, out.join('\n'))
+  atomicWriteFileSync(envPath, out.join('\n'), { mode: 0o600 })
```

A fix a javaslat 1. opcióját választja (a 3-soros mode-preserve alternatíva helyett) — a `0o600` explicit megadása egyértelmű security contract, és a kontaineres 0644-es use-case a projekt jelenlegi állapotában nincs dokumentálva sehol (`.env` telepítési útmutató `0600`).

### 2. `src/__tests__/env.test.ts:210-228` — pinning test flip

A jelenlegi teszt a **defektív** viselkedést rögzíti (`0o644`):

```diff
-    // atomicWriteFileSync mode opcio nelkul hivodik (src/env.ts:87): uj tmp
-    // fajl keszul default umask-kal, majd rename-el a helyere -- a 0600 igy
-    // elveszik. Ez a 2026-07-27-i incidens hibaosztalya.
-    expect(statSync(envPath).mode & 0o777).toBe(0o644)
+    // atomicWriteFileSync { mode: 0o600 } opcioval hivodik (src/env.ts:87): a
+    // tmp fajl a write utan chmod 0o600-zal jon letre, majd rename. A 0600
+    // jogosultsag a frissites utan is megmarad.
+    expect(statSync(envPath).mode & 0o777).toBe(0o600)
```

Plusz a teszt címének és belső kommentjeinek frissítése: `PINNED BUG env-update-mode-downgrade` → `preserves 0600 across updateEnvFile`.

### 3. `docs/needs-to-be-fix/INDEX.md:21` — Resolved sor

```diff
-| `env-update-mode-downgrade` | `src/env.ts:87` | ... | `src/__tests__/env.test.ts` | — |
+| `env-update-mode-downgrade` | `src/env.ts:87` | ... | `src/__tests__/env.test.ts` | Resolved: 2026-08-17 <sha> |
```

## Verify

- `bun --bun vitest run src/__tests__/env.test.ts` — a flip-elt teszt zöld, a többi env.test.ts teszt nem sérül
- `bun --bun vitest run` — teljes suite (baseline baseline: 381 fájl / 11107 teszt)
- `bunx tsc --noEmit | wc -l` — 2255 baseline-zaj, 0 új hiba
- `git status` — clean, 3 commit (fix + docs + test flip), pusholatlan

## Workflow

Indulás: `test/baseline` (clean, szinkronban az origin-nal).
Végrehajtás Workflow tool-lal, 3 fázisban:

| Phase | Task | Commit |
|-------|------|--------|
| A | `src/env.ts:87` fix + ENV_MODE_OPCIO argumentum | `fix(env): preserve 0600 across updateEnvFile (closes env-update-mode-downgrade)` |
| B | `src/__tests__/env.test.ts` pinning test flip | `test(env): flip env-update-mode-downgrade expectation to 0600` |
| C | `docs/needs-to-be-fix/INDEX.md` Resolved sor | `docs(needs-to-be-fix): mark env-update-mode-downgrade resolved` |

A /code-review xhigh --fix skill a workflow végén fut, a 3 commitra.

## Files modified

- `src/env.ts` (+1 karakter, 1 sor)
- `src/__tests__/env.test.ts` (1 sor assertion + 3 sor komment flip)
- `docs/needs-to-be-fix/INDEX.md` (1 sor)

Visszavezetés: `test/baseline` (push a user kezében marad).
