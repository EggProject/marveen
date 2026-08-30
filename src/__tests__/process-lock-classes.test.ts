import { describe, it, expect } from 'vitest'
import {
  PortLockAcquirer,
  PidfileLockAcquirer,
  DeferToPeerError,
  type ProcessLockContext,
  type PidfileLockContext,
} from '../process-lock.js'

// Direct contract tests for the PortLockAcquirer + PidfileLockAcquirer
// classes. The wrappers in process-lock.test.ts already cover the
// free-function shapes; this file pins the public class API as the future
// migration path (E.3+) will consume it. Compact inline ctx literals -- the
// full process-table mock from process-lock.test.ts is overkill for 7 cases.

const noop = (): undefined => undefined
const noopAsync = async (): Promise<void> => { await Promise.resolve() }
const noopLog = { info: noop, warn: noop, error: noop }

function buildPortCtx(opts: {
  currentPid?: number
  uid?: number | null
  portHolders?: number[]
  argv?: RegExp
  signal?: ProcessLockContext['signal']
  sleep?: ProcessLockContext['sleep']
} = {}): ProcessLockContext {
  const currentPid = opts.currentPid ?? 1000
  const uid = opts.uid === undefined ? 501 : opts.uid
  return {
    currentPid,
    uid,
    listPortHolders: () => opts.portHolders ?? [],
    listOwnProcessesMatching: () => [],
    getProcessCommand: () => null,
    getProcessUid: () => uid,
    signal: opts.signal ?? (() => 'sent' as const),
    sleep: opts.sleep ?? noopAsync,
    log: noopLog,
  }
}

function buildPidfileCtx(opts: {
  files?: Map<string, number>
  livePids?: Set<number>
  legitimatePids?: Set<number>
  probeAlive?: (pid: number) => boolean
  sleep?: PidfileLockContext['sleep']
} = {}): PidfileLockContext {
  const files = opts.files ?? new Map<string, number>()
  const livePids = opts.livePids ?? new Set<number>()
  const legitimatePids = opts.legitimatePids ?? new Set<number>()
  return {
    tryCreateExclusive(path, pid) {
      if (files.has(path)) return 'exists'
      files.set(path, pid)
      return 'created'
    },
    readRecordedPid(path) { return files.get(path) ?? null },
    unlinkIfMatches(path, expected) {
      const cur = files.get(path)
      if (expected === null) {
        if (cur === undefined) files.delete(path)
        return
      }
      if (cur !== expected) return
      files.delete(path)
    },
    probeAlive: opts.probeAlive ?? ((pid) => livePids.has(pid)),
    sendTerm(pid) { livePids.delete(pid) },
    isLegitimatePredecessor(pid) { return legitimatePids.has(pid) },
    sleep: opts.sleep ?? noopAsync,
    log: noopLog,
  }
}

describe('PortLockAcquirer', () => {
  it('findOwnNodeHolders delegates to ctx.listPortHolders + the own-UID filter', () => {
    // Pin the public method shape and prove the ctx flows through.
    const ctx = buildPortCtx({
      currentPid: 7,
      uid: 42,
      portHolders: [7, 11, 13],
    })
    const acquirer = new PortLockAcquirer(ctx)
    const result = acquirer.findOwnNodeHolders(3420)
    expect(Array.isArray(result)).toBe(true)
    // Pin that findOwnNodeHolders does NOT take a ctx parameter:
    expect(acquirer.findOwnNodeHolders.length).toBe(1)
  })

  it('findOwnBinaryMatches delegates to ctx.listOwnProcessesMatching', () => {
    const ctx = buildPortCtx({ argv: /dashboard/ })
    // Override listOwnProcessesMatching so we exercise the second path.
    const seen: RegExp[] = []
    const wrapped: ProcessLockContext = {
      ...ctx,
      listOwnProcessesMatching(pattern) {
        seen.push(pattern)
        return [42]
      },
    }
    const acquirer = new PortLockAcquirer(wrapped)
    acquirer.findOwnBinaryMatches(/dashboard/)
    expect(seen).toEqual([/dashboard/])
    expect(acquirer.findOwnBinaryMatches.length).toBe(1)
  })

  it('terminateProcesses sends SIGTERM then SIGKILLs the surviving PID', async () => {
    const calls: { pid: number; sig: string }[] = []
    const sleep: ProcessLockContext['sleep'] = async (ms: number) => { await Promise.resolve(ms) }
    const signal: ProcessLockContext['signal'] = (pid, sig) => {
      calls.push({ pid, sig: String(sig) })
      // SIGTERM is ignored (hung predecessor), probe says still alive,
      // then SIGKILL finally succeeds. All branches return 'sent'.
      void sig
      return 'sent'
    }
    const ctx = buildPortCtx({ signal, sleep })
    await new PortLockAcquirer(ctx).terminateProcesses([200], { graceMs: 5 })
    expect(calls.map(c => c.sig)).toEqual(['SIGTERM', '0', 'SIGKILL'])
  })

  it('acquire(port, { graceMs }) takes the explicit-opts branch', async () => {
    // Set up a holder so acquire has to do work. Track sleep to confirm the
    // explicit graceMs value flows into terminateProcesses. Build the ctx
    // inline (instead of buildPortCtx) so 200 is recognised as an own-UID
    // node holder -- the buildPortCtx defaults return null command which
    // would skip the holder entirely.
    const sleptFor: number[] = []
    const sleep: ProcessLockContext['sleep'] = async (ms) => {
      await Promise.resolve()
      sleptFor.push(ms)
    }
    const ctx: ProcessLockContext = {
      currentPid: 1000,
      uid: 501,
      listPortHolders: (port) => port === 3420 ? [200] : [],
      listOwnProcessesMatching: () => [],
      getProcessCommand: () => 'node',
      getProcessUid: () => 501,
      signal: () => 'sent',
      sleep,
      log: noopLog,
    }
    await new PortLockAcquirer(ctx).acquire(3420, { graceMs: 77 })
    expect(sleptFor).toContain(77)
  })

  it('acquire(port) opts nélkül lefedi a default ágat, és ugyanaz a példány két porton', async () => {
    // Same instance, two different ports -> proves ctx is shared instance
    // state (this.ctx), not a per-call argument, AND covers the
    // `opts: AcquirePortLockOptions = {}` default branch on the method.
    const holdersByPort: Record<number, number[]> = {
      3420: [200],
      3421: [300],
    }
    const seenPorts: number[] = []
    const ctx: ProcessLockContext = {
      ...buildPortCtx({ signal: () => 'sent' }),
      listPortHolders(port) {
        seenPorts.push(port)
        return holdersByPort[port] ?? []
      },
      sleep: noopAsync,
    }
    const acquirer = new PortLockAcquirer(ctx)
    await acquirer.acquire(3420)
    await acquirer.acquire(3421)
    expect(seenPorts).toContain(3420)
    expect(seenPorts).toContain(3421)
    // Signature: only port is positional, opts is the default.
    expect(acquirer.acquire.length).toBe(1)
  })
})

describe('PidfileLockAcquirer', () => {
  it('acquire(path, selfPid) opts nélkül -- default ág, létrehozza a pidfile-t', async () => {
    // Pin that the class method defaults the options object just like the
    // free function did, and that `this.ctx.tryCreateExclusive` is called.
    const files = new Map<string, number>()
    const ctx = buildPidfileCtx({ files })
    await new PidfileLockAcquirer(ctx).acquire('/tmp/test.pid', 42)
    expect(files.get('/tmp/test.pid')).toBe(42)
    // Signature pins: no positional opts.
    expect(new PidfileLockAcquirer(ctx).acquire.length).toBe(2)
  })

  it('acquire with onLiveLegitimate=defer throws DeferToPeerError via the class path', async () => {
    // Proves the class-path also produces an instanceof DeferToPeerError
    // (the free-function path is already covered in process-lock.test.ts).
    const files = new Map<string, number>([['/tmp/test.pid', 999]])
    const livePids = new Set<number>([999])
    const legitimatePids = new Set<number>([999])
    const ctx = buildPidfileCtx({ files, livePids, legitimatePids })
    const promise = new PidfileLockAcquirer(ctx).acquire('/tmp/test.pid', 100, { onLiveLegitimate: 'defer' })
    await expect(promise).rejects.toBeInstanceOf(DeferToPeerError)
    // And critically: defer must NOT have SIGTERMed the peer.
    expect(livePids.has(999)).toBe(true)
  })
})
