There are two ways Claude is launched under tmux. `send-keys` IPC calls are excluded because they do not start a new Claude process.

**1. `tmux new-session -d` (spawn a new session)**
- `src/web/agent-process.ts:1223`: start a local sub-agent through the canonical launch path
- `src/web/agent-process.ts:824`: start a remote sub-agent over SSH
- `src/web/agent-worker.ts:488`: start the two worker sessions (`ctxSlow` and `ctxFast`) at boot
- `src/web/routes/background-tasks.ts:63`: run the single one-shot `claude -p` background task
- `scripts/watchdog.sh:176`: restart a missing sub-agent
- `scripts/channels.sh:529`: start the primary channels session during boot
- `scripts/channels.sh:570`: use the EPERM fallback for the primary channels session

**2. `tmux respawn-pane -k` (replace the process in place and keep the session)**
- `src/web/channel-monitor.ts:654, 726, 938`: respawn the primary channels session
- `scripts/channel-watchdog.sh:211`: recover a wedged primary session
- `scripts/stuck-modal-guard.sh:261`: recover after exhausting Escape attempts
