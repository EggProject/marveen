#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRoot = join(scriptDir, '..')
const argv = process.argv.slice(2)
let root = defaultRoot
if (argv[0] === '--root') {
  root = argv[1] || ''
  argv.splice(0, 2)
}

const command = argv.shift()
if (!root || !command) {
  console.error('usage: runtime-config.mjs [--root PATH] get KEY | get-many KEY... | has-secret ID')
  process.exit(2)
}

process.env.CLAUDECLAW_ENV_DIR = root

const importFromDist = async (relative) => import(pathToFileURL(join(root, 'dist', relative)).href)
const { readConfigOverrides, resolveConfigValue } = await importFromDist('config-resolution.js')
const overrides = readConfigOverrides(join(root, 'store', 'config-overrides.json'))

if (command === 'get') {
  const key = argv[0]
  if (!key) process.exit(2)
  process.stdout.write(String(resolveConfigValue(key, overrides)))
  process.exit(0)
}

if (command === 'get-many') {
  if (argv.length === 0) process.exit(2)
  const values = Object.fromEntries(argv.map((key) => [key, resolveConfigValue(key, overrides)]))
  process.stdout.write(JSON.stringify(values))
  process.exit(0)
}

if (command === 'has-secret') {
  const id = argv[0]
  if (!id) process.exit(2)
  const { getSecret } = await importFromDist(join('web', 'vault.js'))
  process.stdout.write(getSecret(id) === null ? 'false' : 'true')
  process.exit(0)
}

console.error(`unknown runtime-config command: ${command}`)
process.exit(2)
