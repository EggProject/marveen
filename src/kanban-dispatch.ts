// Pure decision logic for the kanban -> agent dispatch (option D).
//
// When a kanban card is moved to `in_progress`, the dashboard wakes the
// assigned agent by enqueuing an inter-agent message (createAgentMessage ->
// the existing message-router, which gives us retry / dedup / trust-wrapping /
// busy-receiver handling for free). This module decides WHO, if anyone, should
// be woken. Kept pure so the decision tree is unit-tested without tmux/db.
//
// Rules (mirroring the assignee semantics from PR #251):
//   - empty / unknown assignee        -> null  (no dispatch)
//   - the human owner (OWNER_NAME)     -> null  (humans never get a prompt)
//   - the bot / main agent             -> MAIN_AGENT_ID (main channels session)
//   - a sub-agent, ONLY if its session is running -> that agent's id
//     (a non-running sub-agent is a silent no-op; the card just stays in
//      in_progress rather than queuing a message for a session that isn't up)

export interface DispatchResolveOpts {
  ownerName: string
  botName: string
  mainAgentId: string
  agentNames: string[]
  isRunning: (name: string) => boolean
}

export function resolveKanbanDispatchTarget(
  assignee: string | null | undefined,
  opts: DispatchResolveOpts,
): string | null {
  const a = (assignee ?? '').trim()
  if (!a) return null
  const lower = a.toLowerCase()

  // Human owner never triggers an agent.
  if (lower === norm(opts.ownerName)) return null

  // Bot / main agent (matched by display name or canonical id) -> main session.
  // The returned id is trimmed defensively in case a quoted .env value leaked
  // padding into the config (readEnvFile trims unquoted, but quotes preserve
  // padding). We don't lowercase the return -- mainAgentId is the canonical
  // session name, and a tmux lookup must receive it exactly as registered.
  if (lower === norm(opts.botName) || lower === norm(opts.mainAgentId)) {
    return opts.mainAgentId.trim()
  }

  // Sub-agent: case-insensitive name match, dispatched only if it is running.
  const match = opts.agentNames.find((n) => norm(n) === lower)
  if (match && opts.isRunning(match)) return match

  return null
}

// Normalize a configured name: strip quoted-string padding from .env and
// lowercase for case-insensitive matching. The assignee (a) is already
// trimmed by the caller; only the configured names need this.
const norm = (s: string): string => s.trim().toLowerCase()
