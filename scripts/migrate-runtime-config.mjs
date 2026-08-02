#!/usr/bin/env node
import { existsSync, readFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const rootIndex = argv.indexOf('--root')
const root = rootIndex >= 0 ? argv[rootIndex + 1] : join(scriptDir, '..')
if (!root) {
  console.error('usage: migrate-runtime-config.mjs [--root PATH] [--dry-run]')
  process.exit(2)
}

process.env.CLAUDECLAW_ENV_DIR = root
const fromDist = async (relative) => import(pathToFileURL(join(root, 'dist', relative)).href)
const { parseEnvText } = await fromDist('env.js')
const { SETTINGS_REGISTRY, validateSettingValue } = await fromDist('config-registry.js')
const { parseConfigOverrides } = await fromDist('config-resolution.js')
const { atomicWriteFileSync } = await fromDist(join('web', 'atomic-write.js'))

const envPath = join(root, '.env')
const overridesPath = join(root, 'store', 'config-overrides.json')
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''
const env = parseEnvText(envText)
const existingOverrides = existsSync(overridesPath)
  ? parseConfigOverrides(readFileSync(overridesPath, 'utf-8'))
  : {}

const nextOverrides = { ...existingOverrides }
const migrated = new Set()
for (const definition of SETTINGS_REGISTRY) {
  if (!(definition.key in env)) continue
  const result = validateSettingValue(definition, env[definition.key])
  if (!result.ok) throw new Error(`invalid_config:${definition.key}:${result.error}`)
  nextOverrides[definition.key] = result.value
  migrated.add(definition.key)
}

const secretIds = {
  TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  SLACK_BOT_TOKEN: 'SLACK_BOT_TOKEN',
  SLACK_APP_TOKEN: 'SLACK_APP_TOKEN',
  DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  TEAMS_BOT_CLIENT_SECRET: 'TEAMS_BOT_CLIENT_SECRET',
}
const secrets = Object.entries(secretIds)
  .filter(([key]) => Boolean(env[key]))
  .map(([key, id]) => ({ key, id, value: env[key] }))
for (const { key } of secrets) migrated.add(key)

const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || ''
if (oauthToken) migrated.add('CLAUDE_CODE_OAUTH_TOKEN')

const keptLines = envText.split('\n').filter((line) => {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return true
  const eq = trimmed.indexOf('=')
  return eq < 0 || !migrated.has(trimmed.slice(0, eq).trim())
})

const report = {
  dryRun,
  settings: [...migrated].filter((key) => !(key in secretIds) && key !== 'CLAUDE_CODE_OAUTH_TOKEN').sort(),
  secrets: secrets.map(({ id }) => id).sort(),
  oauthToken: Boolean(oauthToken),
}

if (!dryRun) {
  mkdirSync(join(root, 'store'), { recursive: true })
  if (existsSync(envPath)) copyFileSync(envPath, `${envPath}.pre-runtime-config`)
  atomicWriteFileSync(overridesPath, JSON.stringify(nextOverrides, null, 2) + '\n')
  if (secrets.length > 0) {
    const { setSecret } = await fromDist(join('web', 'vault.js'))
    for (const secret of secrets) setSecret(secret.id, secret.id, secret.value)
  }
  if (oauthToken) writeFileSync(join(root, 'store', '.claude-oauth-token'), oauthToken + '\n', { mode: 0o600 })
  atomicWriteFileSync(envPath, keptLines.join('\n'))
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n')
