import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// One test-only root seam for every repository-relative runtime file. Production
// never sets it. Keeping the seam here prevents tests from accidentally mixing a
// sandboxed config file with the live store or vault.
export const PROJECT_ROOT = process.env.CLAUDECLAW_ENV_DIR ?? join(__dirname, '..')
export const STORE_DIR = join(PROJECT_ROOT, 'store')
