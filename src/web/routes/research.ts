import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../../config.js'
import { agentConfigRoot, listAgentNames } from '../agent-config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Read-only viewer for each agent's research/ folder (agents/<name>/research/,
// or the project root for the main agent). Mirrors routes/docs.ts: everything
// sits under /api/* (bearer-token gated), nothing is writable. Filenames
// pass NAME_RE (a character-class allowlist that excludes path separators)
// and readFileSync is called only on join(researchDir(agent), name) with
// the agent segment allowlisted upstream.
const NAME_RE = /^[A-Za-z0-9._-]+\.md$/

function titleOf(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : fallback
}

function researchDir(agent: string): string {
  return join(agentConfigRoot(agent), 'research')
}

export async function tryHandleResearch(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/research' && method === 'GET') {
    const agents = [MAIN_AGENT_ID, ...listAgentNames()]
    const result = agents.map(agent => {
      const dir = researchDir(agent)
      let docs: { name: string; title: string; ms: number }[] = []
      try {
        const dirents = readdirSync(dir, { withFileTypes: true })
        for (const entry of dirents) {
          if (!entry.isFile() || entry.isSymbolicLink()) continue
          if (!NAME_RE.test(entry.name)) continue
          const file = join(dir, entry.name)
          let title = entry.name
          let ms = 0
          try {
            title = titleOf(readFileSync(file, 'utf-8'), entry.name)
            ms = lstatSync(file).mtimeMs
          } catch {
            /* keep filename as title */
          }
          docs.push({ name: entry.name, title, ms })
        }
      } catch {
        docs = []
      }
      const out = docs
        .sort((a, b) => (b.ms - a.ms) || a.name.localeCompare(b.name))
        .map(({ name, title, ms }) => ({ name, title, updated: new Date(ms).toISOString().slice(0, 10) }))
      return { agent, docs: out }
    }).filter(a => a.docs.length > 0)
    json(res, result)
    return true
  }

  const match = path.match(/^\/api\/research\/([^/]+)\/([^/]+)$/)
  if (match && method === 'GET') {
    let agent: string
    let name: string
    try {
      agent = decodeURIComponent(match[1])
      name = decodeURIComponent(match[2])
    } catch {
      json(res, { error: 'Invalid file name' }, 400)
      return true
    }
    if (!NAME_RE.test(name)) {
      json(res, { error: 'Invalid file name' }, 400)
      return true
    }
    const agents = [MAIN_AGENT_ID, ...listAgentNames()]
    if (!agents.includes(agent)) {
      json(res, { error: 'Unknown agent' }, 404)
      return true
    }
    const file = join(researchDir(agent), name)
    const st = lstatSync(file, { throwIfNoEntry: false })
    if (!st || !st.isFile() || st.isSymbolicLink()) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    const content = readFileSync(file, 'utf-8')
    json(res, { agent, name, title: titleOf(content, name), content })
    return true
  }

  return false
}
