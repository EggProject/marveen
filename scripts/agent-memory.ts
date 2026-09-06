#!/usr/bin/env bun
// scripts/agent-memory.ts
// Usage: bun scripts/agent-memory.ts write <topic> <content-file>
// Or:    pnpm claude:memory write <topic> <content-file>
//
// Dual-writes memory entries to:
//   1. .claude/shared-memory/<topic>.md (always; project-local durable record)
//   2. Honcho memory via HTTP API (if HONCHO_API_KEY env var is set)
//
// When Honcho is unreachable, the script writes only to shared-memory and
// prints a warning; the project-local entry is the authoritative record in
// that case.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = process.cwd()
const SHARED_MEMORY_DIR = join(PROJECT_ROOT, '.claude', 'shared-memory')

async function writeSharedMemory(topic: string, content: string): Promise<string> {
  if (!existsSync(SHARED_MEMORY_DIR)) {
    mkdirSync(SHARED_MEMORY_DIR, { recursive: true })
  }
  const outPath = join(SHARED_MEMORY_DIR, `${topic}.md`)
  writeFileSync(outPath, content, 'utf-8')
  return outPath
}

async function writeHoncho(content: string): Promise<boolean> {
  const apiKey = process.env.HONCHO_API_KEY
  const endpoint = process.env.HONCHO_ENDPOINT || 'https://api.honcho.ai'
  if (!apiKey) {
    console.warn('HONCHO_API_KEY not set; skipping Honcho write. .claude/shared-memory/<topic>.md was written.')
    return false
  }
  try {
    const response = await fetch(`${endpoint}/v2/conclusions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    })
    if (!response.ok) {
      console.warn(`Honcho write failed: ${response.status} ${await response.text()}`)
      return false
    }
    return true
  } catch (err) {
    console.warn(`Honcho write error: ${err}`)
    return false
  }
}

async function main(): Promise<void> {
  const [, , cmd, topic, contentFile] = process.argv
  if (cmd !== 'write' || !topic || !contentFile) {
    console.error('Usage: bun scripts/agent-memory.ts write <topic> <content-file>')
    process.exit(1)
  }
  const content = readFileSync(contentFile, 'utf-8')
  const outPath = await writeSharedMemory(topic, content)
  console.log(`Wrote ${outPath}`)
  const honchoOk = await writeHoncho(content)
  if (honchoOk) {
    console.log('Wrote Honcho conclusion.')
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
