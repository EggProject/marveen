// Shared test doubles for the installer unit tests.
//
// Every adapter in InstallerContext (shell, fs, platform, fetch) has a
// deterministic in-memory stand-in here so no test touches a real
// process, socket or file.

import { vi } from 'vitest'
import type {
  FsAdapter,
  InstallerContext,
  PlatformProvider,
  ProviderMode,
  ShellAdapter,
  ShellResult,
} from '../types.js'

export function shellResult(over: Partial<ShellResult> = {}): ShellResult {
  return { exitCode: 0, stdout: '', stderr: '', ...over }
}

export interface FakeShell extends ShellAdapter {
  exec: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  which: ReturnType<typeof vi.fn>
}

export function makeShell(over: Partial<Record<'exec' | 'run' | 'which', unknown>> = {}): FakeShell {
  return {
    exec: vi.fn(async () => shellResult()),
    run: vi.fn(async () => shellResult()),
    which: vi.fn(async () => '/usr/bin/x'),
    ...over,
  } as FakeShell
}

export interface FakeFs extends FsAdapter {
  atomicWrite: ReturnType<typeof vi.fn>
  ensureDir: ReturnType<typeof vi.fn>
  readFile: ReturnType<typeof vi.fn>
  exists: ReturnType<typeof vi.fn>
  files: Map<string, string>
}

export function makeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(initial))
  return {
    files,
    atomicWrite: vi.fn(async (p: string, c: string) => { files.set(p, c) }),
    ensureDir: vi.fn(async () => undefined),
    readFile: vi.fn(async (p: string) => files.get(p) ?? ''),
    exists: vi.fn(async (p: string) => files.has(p)),
  } as unknown as FakeFs
}

export interface FakePlatform extends PlatformProvider {
  installPrerequisites: ReturnType<typeof vi.fn>
  installBun: ReturnType<typeof vi.fn>
  installClaudeCli: ReturnType<typeof vi.fn>
  writeServiceUnit: ReturnType<typeof vi.fn>
  enableAndStart: ReturnType<typeof vi.fn>
  disableAndStop: ReturnType<typeof vi.fn>
  readServiceStatus: ReturnType<typeof vi.fn>
  uninstall: ReturnType<typeof vi.fn>
  serviceUnitPath: ReturnType<typeof vi.fn>
}

export function makePlatform(kind: 'linux' | 'macos' = 'linux'): FakePlatform {
  return {
    kind,
    installPrerequisites: vi.fn(async () => undefined),
    installBun: vi.fn(async () => undefined),
    installClaudeCli: vi.fn(async () => undefined),
    writeServiceUnit: vi.fn(async (spec: { name: string }) => ({ path: `/units/${spec.name}` })),
    enableAndStart: vi.fn(async () => undefined),
    disableAndStop: vi.fn(async () => undefined),
    readServiceStatus: vi.fn(async (name: string) => ({ name, state: 'active' as const })),
    uninstall: vi.fn(async () => undefined),
    serviceUnitPath: vi.fn((name: string) => `/units/${name}`),
  } as unknown as FakePlatform
}

/** fetch stub returning a scripted queue of responses (or throwing). */
export function makeFetch(script: Array<{ ok?: boolean; status?: number; body?: string } | Error>): {
  fn: typeof fetch
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) })
    const entry = script[Math.min(i, script.length - 1)]
    i += 1
    if (entry instanceof Error) throw entry
    const status = entry?.status ?? 200
    return {
      ok: entry?.ok ?? (status >= 200 && status < 300),
      status,
      text: async () => entry?.body ?? '',
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

export interface CtxOverrides extends Partial<InstallerContext> {
  shell?: FakeShell
  fs?: FakeFs
  platform?: FakePlatform
}

export function makeCtx(over: CtxOverrides = {}): InstallerContext & {
  shell: FakeShell
  fs: FakeFs
  platform: FakePlatform
} {
  const base = {
    port: 8787,
    webPort: 3420,
    lang: 'hu' as const,
    nonInteractive: false,
    skipUpdate: false,
    bunInstalled: false,
    claudeInstalled: false,
    botName: '',
    brandName: '',
    ownerName: '',
    dashboardToken: 'tok',
    ollamaUrl: '',
    ollamaSkip: false,
    ollamaInstall: false,
    platform: makePlatform(),
    shell: makeShell(),
    fs: makeFs(),
    fetch: makeFetch([{ ok: true }]).fn,
    cwd: '/proj',
  }
  return { ...base, ...over } as InstallerContext & {
    shell: FakeShell
    fs: FakeFs
    platform: FakePlatform
  }
}

export const ALL_PROVIDERS: readonly ProviderMode[] = [
  'anthropic', 'minimax', 'deepseek', 'openrouter', 'ollama', 'skip',
]

/** Captures process.stdout/stderr writes for the duration of `fn`. */
export async function captureOutput(fn: () => Promise<void> | void): Promise<{ stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk)
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk)
    return true
  })
  try {
    await fn()
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
  }
  return { stdout, stderr }
}
