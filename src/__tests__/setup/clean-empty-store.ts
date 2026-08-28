// Global teardown: a teszt suite futása alatt egyes SUT-ok a live checkout-ba
// írhatnak (store/ vagy agents/ mappát hoznak létre), mert a SUT init kódja
// a vi.mock('../config.js', ...) előtt fut le. Ez a teardown hook indulás
// ELŐTT és közben is törli az üres mappákat, hogy a unit teszt ne hagyjon
// nyomot a repo gyökerében.
//
// process.on('exit', ...) vitest worker-ekben nem mindig fut le, ezért a
// beforeAll hook-ban is periódikusan ellenőrzünk.
import { existsSync, readdirSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const dirs = [join(repoRoot, 'store'), join(repoRoot, 'agents')]

function cleanEmpty(): void {
  for (const d of dirs) {
    try {
      if (existsSync(d) && readdirSync(d).length === 0) {
        rmdirSync(d)
      }
    } catch { /* ignore */ }
  }
}

cleanEmpty()

process.on('beforeExit', cleanEmpty)
process.on('exit', cleanEmpty)
