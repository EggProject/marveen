Két mintázat van ahogy a `claude` tmux alá kerül (a `send-keys` IPC-k nem indítanak új `claude` process-t, azok kimaradnak):

**1. `tmux new-session -d` (spawn, teljes új session)**
- `src/web/agent-process.ts:1223` — helyi sub-agent indítása (a kanonikus launch path)
- `src/web/agent-process.ts:824` — remote sub-agent indítása ssh-n át
- `src/web/agent-worker.ts:488` — a két worker session (`ctxSlow`, `ctxFast`) bootnál
- `src/web/routes/background-tasks.ts:63` — az egyetlen `claude -p` (one-shot háttérfeladat)
- `scripts/watchdog.sh:176` — hiányzó sub-agent újraindítása
- `scripts/channels.sh:529` — a fő channels session elsődleges indulása (boot path)
- `scripts/channels.sh:570` — EPERM fallback a fő channels session-höz

**2. `tmux respawn-pane -k` (in-place folyamatcsere, session marad)**
- `src/web/channel-monitor.ts:654, 726, 938` — fő channels session respawn
- `scripts/channel-watchdog.sh:211` — wedged main session recovery
- `scripts/stuck-modal-guard.sh:261` — Escape-kimerülés utáni escape