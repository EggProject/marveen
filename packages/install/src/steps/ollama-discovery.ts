// Ollama discovery step.
//
// Mirrors the 16 BATS scenarios from installer-ollama-discovery.sh:
//   - probe localhost OK
//   - probe localhost fail
//   - probe custom URL OK
//   - probe custom URL fail
//   - menu 1 (custom URL given)
//   - menu 2 (install locally)
//   - menu 3 (skip without Ollama)
//   - wait_ready within timeout
//   - wait_ready timeout
//   - httpProbe via injected fetch (test-only)
//   - non-interactive skips the menu and uses the default URL
// All network calls go through the injected fetch so unit tests never
// touch a real socket.

import type { InstallerContext } from '../types.js'
import { select } from '../ui/prompts.js'
import { t } from '../locale/index.js'

type FetchFn = typeof fetch

export interface OllamaDiscoveryResult {
  url: string
  skip: boolean
  install: boolean
}

export async function httpProbe(url: string, fetchFn?: FetchFn): Promise<boolean> {
  const f = fetchFn ?? ctxFetch()
  try {
    const res = await f(joinUrl(url, '/api/tags'), { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

export async function waitForOllama(opts: {
  url: string
  timeoutMs?: number
  pollIntervalMs?: number
  fetch?: FetchFn
}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  const interval = opts.pollIntervalMs ?? 1_000
  while (Date.now() < deadline) {
    if (await httpProbe(opts.url, opts.fetch)) return true
    await sleep(interval)
  }
  return false
}

export async function stepOllamaDiscovery(ctx: InstallerContext): Promise<OllamaDiscoveryResult> {
  const defaultUrl = t('provider.ollama.default')

  if (await httpProbe(defaultUrl, ctx.fetch)) {
    ctx.ollamaUrl = defaultUrl
    ctx.ollamaSkip = false
    ctx.ollamaInstall = false
    process.stdout.write(t('ollama.probe.ok', defaultUrl) + '\n')
    return { url: defaultUrl, skip: false, install: false }
  }

  if (ctx.nonInteractive) {
    ctx.ollamaUrl = defaultUrl
    ctx.ollamaSkip = true
    ctx.ollamaInstall = false
    return { url: defaultUrl, skip: true, install: false }
  }

  const choice = await select(t('ollama.menu.title'), [
    { name: t('ollama.menu.1'), value: '1' },
    { name: t('ollama.menu.2'), value: '2' },
    { name: t('ollama.menu.3'), value: '3' },
  ])

  if (choice === '1') {
    const { input } = await import('../ui/prompts.js')
    const url = await input(t('provider.ollama.prompt'), {
      defaultValue: defaultUrl,
      validate: (v) => /^https?:\/\//i.test(v) ? true : t('prompt.url'),
    })
    if (await httpProbe(url, ctx.fetch)) {
      ctx.ollamaUrl = url
      ctx.ollamaSkip = false
      ctx.ollamaInstall = false
      return { url, skip: false, install: false }
    }
    ctx.ollamaUrl = url
    ctx.ollamaSkip = true
    return { url, skip: true, install: false }
  }

  if (choice === '2') {
    await ctx.platform.installPrerequisites().catch(() => undefined)
    await ctx.shell.run('curl -fsSL https://ollama.ai/install.sh | sh', { stdio: 'inherit' })
    const ok = await waitForOllama({ url: defaultUrl, fetch: ctx.fetch, timeoutMs: 60_000 })
    if (ok) {
      ctx.ollamaUrl = defaultUrl
      ctx.ollamaSkip = false
      ctx.ollamaInstall = true
      return { url: defaultUrl, skip: false, install: true }
    }
    ctx.ollamaUrl = defaultUrl
    ctx.ollamaSkip = true
    ctx.ollamaInstall = true
    return { url: defaultUrl, skip: true, install: true }
  }

  // choice === '3'
  ctx.ollamaUrl = defaultUrl
  ctx.ollamaSkip = true
  ctx.ollamaInstall = false
  return { url: defaultUrl, skip: true, install: false }
}

function ctxFetch(): FetchFn {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis)
  return unreachableFetch
}

function unreachableFetch(): Promise<Response> {
  return Promise.reject(new Error('fetch is not available'))
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/$/, '') + suffix
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}