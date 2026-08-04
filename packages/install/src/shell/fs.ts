// Atomic filesystem writes.
//
// atomicWrite mirrors the helper in @marveen/core (write-tmp + rename).
// ensureDir recursively creates parent dirs and never throws if the
// directory already exists. Both go through the FsAdapter in types.ts
// so tests inject an in-memory stand-in.

import { writeFile, chmod, rename, mkdir, readFile as fsReadFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FsAdapter } from '../types.js'

export const defaultFs: FsAdapter = {
  async atomicWrite(path, content, mode) {
    const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, content, 'utf-8')
    if (mode !== undefined) {
      try { await chmod(tmp, mode) } catch { /* best-effort */ }
    }
    await rename(tmp, path)
  },

  async ensureDir(path) {
    await mkdir(path, { recursive: true })
  },

  async readFile(path) {
    return await fsReadFile(path, 'utf-8')
  },

  async exists(path) {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
}

export function setFsFactory(fn: () => FsAdapter): void {
  defaultFsFactory = fn
}

export function resetFsFactory(): void {
  defaultFsFactory = () => defaultFs
}

let defaultFsFactory: () => FsAdapter = () => defaultFs

export function createFs(): FsAdapter {
  return defaultFsFactory()
}

// Convenience helper used by the platform providers when they need to
// make sure a parent directory exists before writing a service unit.
export async function ensureParentDir(fs: FsAdapter, filePath: string): Promise<void> {
  await fs.ensureDir(dirname(filePath))
}