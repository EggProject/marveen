// execa wrapper that returns a normalised ShellResult. The wrapper keeps
// two thin entry points:
//   - exec(file, args, opts): run a binary directly with arg array
//   - run(cmd, opts):        run a shell string (for curl|bash bun install)
// All callers go through the ShellAdapter (see types.ts) so tests can
// inject a deterministic stand-in. The default factory creates a real
// execa-backed adapter; tests override it with setShellFactory.

import { execa as execaImpl, type ExecaMethod, type Options as ExecaOptions } from 'execa'
import type { ShellAdapter, ShellExecOptions, ShellResult } from '../types.js'

type ExecaFn = (file: string, args?: readonly string[], opts?: ExecaOptions) => ExecaMethod

let execa: ExecaFn = execaImpl as unknown as ExecaFn

export function setExecaImpl(fn: ExecaFn): void {
  execa = fn
}

export function resetExecaImpl(): void {
  execa = execaImpl as unknown as ExecaFn
}

function toOptions(opts: ShellExecOptions | undefined): ExecaOptions {
  const result: ExecaOptions = {}
  if (opts?.cwd !== undefined) result.cwd = opts.cwd
  if (opts?.env !== undefined) result.env = opts.env as Record<string, string>
  if (opts?.stdio !== undefined) {
    result.stdio = opts.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe']
  }
  return result
}

async function toResult(p: Awaited<ReturnType<ExecaFn>>): Promise<ShellResult> {
  return {
    exitCode: p.exitCode ?? 0,
    stdout: typeof p.stdout === 'string' ? p.stdout : '',
    stderr: typeof p.stderr === 'string' ? p.stderr : '',
  }
}

export const defaultShell: ShellAdapter = {
  async exec(file, args, opts) {
    try {
      const p = await execa(file, args, toOptions(opts))
      return await toResult(p)
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'exitCode' in err) {
        const e = err as { exitCode?: number; stdout?: string; stderr?: string }
        return {
          exitCode: e.exitCode ?? 1,
          stdout: typeof e.stdout === 'string' ? e.stdout : '',
          stderr: typeof e.stderr === 'string' ? e.stderr : '',
        }
      }
      throw err
    }
  },

  async run(cmd, opts) {
    try {
      const p = await execa(cmd, [], { ...toOptions(opts), shell: true })
      return await toResult(p)
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'exitCode' in err) {
        const e = err as { exitCode?: number; stdout?: string; stderr?: string }
        return {
          exitCode: e.exitCode ?? 1,
          stdout: typeof e.stdout === 'string' ? e.stdout : '',
          stderr: typeof e.stderr === 'string' ? e.stderr : '',
        }
      }
      throw err
    }
  },

  async which(name) {
    const result = await execa('which', [name], { reject: false })
    if (result.exitCode !== 0) return null
    const out = typeof result.stdout === 'string' ? result.stdout : ''
    const first = out.split('\n', 1).join('').trim()
    return first.length > 0 ? first : null
  },
}

export function setShellFactory(fn: () => ShellAdapter): void {
  defaultShellFactory = fn
}

export function resetShellFactory(): void {
  defaultShellFactory = () => defaultShell
}

let defaultShellFactory: () => ShellAdapter = () => defaultShell

export function createShell(): ShellAdapter {
  return defaultShellFactory()
}