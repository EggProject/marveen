// TS port of the 16 BATS scenarios from
// scripts/__tests__/installer-ollama-discovery.bats. Every probe goes
// through an injected fetch, so the discovery flow is exercised without
// a socket.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { httpProbe, stepOllamaDiscovery, waitForOllama } from '../../steps/ollama-discovery.js'
import { resetPromptImpls, setPromptImpls } from '../../ui/prompts.js'
import { initLocale } from '../../locale/index.js'
import { captureOutput, makeCtx, makeFetch } from '../_helpers.js'

const DEFAULT_URL = 'http://localhost:11434'

interface Recorded {
  selects: Array<{ message: string; choices: Array<{ name: string; value: string }> }>
  inputs: Array<{ message: string; default?: string; validate?: (v: string) => true | string }>
}

function script(answers: { select?: string; input?: string }): Recorded {
  const rec: Recorded = { selects: [], inputs: [] }
  setPromptImpls({
    select: (async (o: Recorded['selects'][number]) => {
      rec.selects.push(o)
      return answers.select ?? '3'
    }) as never,
    input: (async (o: Recorded['inputs'][number]) => {
      rec.inputs.push(o)
      return answers.input ?? o.default ?? ''
    }) as never,
  })
  return rec
}

beforeEach(() => { initLocale('hu') })
afterEach(() => {
  resetPromptImpls()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('steps/ollama-discovery httpProbe', () => {
  // 1
  it('returns true for a 2xx /api/tags response', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    expect(await httpProbe(DEFAULT_URL, fn)).toBe(true)
    expect(calls[0]!.url).toBe(`${DEFAULT_URL}/api/tags`)
    expect(calls[0]!.init).toEqual({ method: 'GET' })
  })

  // 2
  it('returns false for a non-2xx response', async () => {
    const { fn } = makeFetch([{ status: 500 }])
    expect(await httpProbe(DEFAULT_URL, fn)).toBe(false)
  })

  // 3
  it('returns false when the connection is refused', async () => {
    const { fn } = makeFetch([new Error('ECONNREFUSED')])
    expect(await httpProbe(DEFAULT_URL, fn)).toBe(false)
  })

  // 4
  it('strips a trailing slash from the base URL', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    await httpProbe('http://gpu-box:11434/', fn)
    expect(calls[0]!.url).toBe('http://gpu-box:11434/api/tags')
  })

  // 5
  it('falls back to the global fetch when none is injected', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)
    expect(await httpProbe(DEFAULT_URL)).toBe(true)
    expect(spy).toHaveBeenCalledOnce()
  })

  // 6
  it('returns false when no fetch implementation exists at all', async () => {
    const original = globalThis.fetch
    // @ts-expect-error -- simulating an ancient runtime without fetch
    delete globalThis.fetch
    try {
      expect(await httpProbe(DEFAULT_URL)).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('steps/ollama-discovery waitForOllama', () => {
  // 7
  it('returns true as soon as the probe succeeds', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    expect(await waitForOllama({ url: DEFAULT_URL, fetch: fn })).toBe(true)
    expect(calls).toHaveLength(1)
  })

  // 8
  it('retries until the probe succeeds', async () => {
    const { fn, calls } = makeFetch([{ status: 502 }, { status: 502 }, { ok: true }])
    expect(await waitForOllama({ url: DEFAULT_URL, fetch: fn, timeoutMs: 5_000, pollIntervalMs: 1 })).toBe(true)
    expect(calls).toHaveLength(3)
  })

  // 9
  it('returns false when the timeout has already elapsed', async () => {
    const { fn, calls } = makeFetch([{ ok: true }])
    expect(await waitForOllama({ url: DEFAULT_URL, fetch: fn, timeoutMs: 0 })).toBe(false)
    expect(calls).toHaveLength(0)
  })

  // 10
  it('returns false when the probe never succeeds', async () => {
    const { fn } = makeFetch([{ status: 500 }])
    expect(await waitForOllama({ url: DEFAULT_URL, fetch: fn, timeoutMs: 20, pollIntervalMs: 1 })).toBe(false)
  })
})

describe('steps/ollama-discovery step', () => {
  // 11
  it('uses localhost when it is already reachable and prints the probe line', async () => {
    const ctx = makeCtx({ fetch: makeFetch([{ ok: true }]).fn })
    const rec = script({})
    let res: Awaited<ReturnType<typeof stepOllamaDiscovery>> | undefined
    const { stdout } = await captureOutput(async () => { res = await stepOllamaDiscovery(ctx) })
    expect(res).toEqual({ url: DEFAULT_URL, skip: false, install: false })
    expect(ctx.ollamaUrl).toBe(DEFAULT_URL)
    expect(ctx.ollamaSkip).toBe(false)
    expect(ctx.ollamaInstall).toBe(false)
    expect(stdout).toContain(`OK -- using ${DEFAULT_URL}`)
    expect(rec.selects).toHaveLength(0)
  })

  // 12
  it('skips the menu in headless mode', async () => {
    const ctx = makeCtx({ nonInteractive: true, fetch: makeFetch([{ status: 500 }]).fn })
    const rec = script({})
    expect(await stepOllamaDiscovery(ctx)).toEqual({ url: DEFAULT_URL, skip: true, install: false })
    expect(ctx.ollamaSkip).toBe(true)
    expect(rec.selects).toHaveLength(0)
  })

  // 13
  it('offers the three menu entries when nothing is reachable', async () => {
    const ctx = makeCtx({ fetch: makeFetch([{ status: 500 }]).fn })
    const rec = script({ select: '3' })
    await stepOllamaDiscovery(ctx)
    expect(rec.selects[0]!.message).toBe('Nincs elérhető Ollama. Mit tegyünk?')
    expect(rec.selects[0]!.choices).toEqual([
      { name: 'Mashol fut, ide megadom az URL-t', value: '1' },
      { name: 'Telepítsd most helyben', value: '2' },
      { name: 'Ollama nélkül megyünk tovább', value: '3' },
    ])
  })

  // 14: choice 1, remote URL reachable
  it('choice 1 keeps a reachable remote URL', async () => {
    const ctx = makeCtx({ fetch: makeFetch([{ status: 500 }, { ok: true }]).fn })
    const rec = script({ select: '1', input: 'http://gpu-box:11434' })
    expect(await stepOllamaDiscovery(ctx)).toEqual({ url: 'http://gpu-box:11434', skip: false, install: false })
    expect(ctx.ollamaUrl).toBe('http://gpu-box:11434')
    expect(ctx.ollamaSkip).toBe(false)
    expect(rec.inputs[0]!.message).toBe('Ollama base URL:')
    expect(rec.inputs[0]!.default).toBe(DEFAULT_URL)
    expect(rec.inputs[0]!.validate!('http://x')).toBe(true)
    expect(rec.inputs[0]!.validate!('gpu-box')).toBe('http:// vagy https:// kezdetű URL-t adj meg')
  })

  // 15: choice 1, remote URL unreachable
  it('choice 1 with an unreachable URL falls back to skip', async () => {
    const ctx = makeCtx({ fetch: makeFetch([{ status: 500 }]).fn })
    script({ select: '1', input: 'http://gpu-box:11434' })
    expect(await stepOllamaDiscovery(ctx)).toEqual({ url: 'http://gpu-box:11434', skip: true, install: false })
    expect(ctx.ollamaSkip).toBe(true)
  })

  // 16: choice 2, install succeeds
  it('choice 2 installs locally and waits for the daemon', async () => {
    const ctx = makeCtx({ fetch: makeFetch([{ status: 500 }, { ok: true }]).fn })
    script({ select: '2' })
    expect(await stepOllamaDiscovery(ctx)).toEqual({ url: DEFAULT_URL, skip: false, install: true })
    expect(ctx.platform.installPrerequisites).toHaveBeenCalledOnce()
    expect(ctx.shell.run).toHaveBeenCalledWith('curl -fsSL https://ollama.ai/install.sh | sh', { stdio: 'inherit' })
    expect(ctx.ollamaInstall).toBe(true)
    expect(ctx.ollamaSkip).toBe(false)
  })

  // 17: the prerequisite failure is swallowed
  it('choice 2 survives a failing prerequisite install', async () => {
    const ctx = makeCtx({ fetch: makeFetch([{ status: 500 }, { ok: true }]).fn })
    ctx.platform.installPrerequisites.mockRejectedValue(new Error('no brew'))
    script({ select: '2' })
    expect((await stepOllamaDiscovery(ctx)).install).toBe(true)
  })

  // 18: choice 2, daemon never comes up
  it('choice 2 gives up after the wait timeout', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx({ fetch: makeFetch([{ status: 500 }]).fn })
    script({ select: '2' })
    const pending = stepOllamaDiscovery(ctx)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(await pending).toEqual({ url: DEFAULT_URL, skip: true, install: true })
    expect(ctx.ollamaSkip).toBe(true)
    expect(ctx.ollamaInstall).toBe(true)
  })

  // 19: choice 3
  it('choice 3 continues without Ollama', async () => {
    const ctx = makeCtx({ fetch: makeFetch([{ status: 500 }]).fn })
    script({ select: '3' })
    expect(await stepOllamaDiscovery(ctx)).toEqual({ url: DEFAULT_URL, skip: true, install: false })
    expect(ctx.ollamaSkip).toBe(true)
    expect(ctx.ollamaInstall).toBe(false)
    expect(ctx.shell.run).not.toHaveBeenCalled()
  })

  // 20
  it('follows the active locale for the menu', async () => {
    initLocale('en')
    const ctx = makeCtx({ fetch: makeFetch([{ status: 500 }]).fn })
    const rec = script({ select: '3' })
    await stepOllamaDiscovery(ctx)
    expect(rec.selects[0]!.message).toBe('No Ollama available. What next?')
    initLocale('hu')
  })
})
