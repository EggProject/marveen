import { describe, it, expect } from 'vitest'
import {
  PortLockAcquirer,
  PidfileLockAcquirer,
  DeferToPeerError,
  type ProcessLockContext,
  type PidfileLockContext,
  type SignalOutcome,
} from '../process-lock.js'

// Direct contract tests for the PortLockAcquirer + PidfileLockAcquirer
// classes. The wrappers in process-lock.test.ts already cover the
// free-function shapes; this file pins the public class API as the future
// migration path (E.3+) will consume it. Compact inline ctx literals -- the
// full process-table mock from process-lock.test.ts is overkill for this
// surface area.

const noop = (): undefined => undefined
const noopAsync = async (): Promise<void> => { await Promise.resolve() }
const noopLog = { info: noop, warn: noop, error: noop, debug: noop }

function buildPortCtx(opts: {
  currentPid?: number
  uid?: number | null
  portHolders?: number[]
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
    signal: opts.signal ?? ((): SignalOutcome => 'sent'),
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
    // Build the ctx inline so getProcessCommand returns a real value: the
    // buildPortCtx defaults return null command which would skip every
    // candidate and reduce this test to a no-op (the result would be []
    // regardless of what listPortHolders returned). Set up: 7 is currentPid
    // (skipped), 11 is foreign-UID (skipped), 13 is own-UID node (kept).
    const seenPorts: number[] = []
    const ctx: ProcessLockContext = {
      currentPid: 7,
      uid: 42,
      listPortHolders(port) {
        seenPorts.push(port)
        return [7, 11, 13]
      },
      listOwnProcessesMatching: () => [],
      getProcessCommand: (pid) => pid === 11 ? null : 'node',
      getProcessUid: (pid) => pid === 11 ? 999 : 42,
      signal: () => 'sent',
      sleep: noopAsync,
      log: noopLog,
    }
    const acquirer = new PortLockAcquirer(ctx)
    const result = acquirer.findOwnNodeHolders(3420)
    expect(result).toEqual([13])
    expect(seenPorts).toEqual([3420])
    // Pin that findOwnNodeHolders does NOT take a ctx parameter:
    expect(acquirer.findOwnNodeHolders.length).toBe(1)
  })

  it('findOwnBinaryMatches delegates to ctx.listOwnProcessesMatching + the filter', () => {
    // Build inline so getProcessCommand can return a real value: buildPortCtx
    // defaults return null which would filter every candidate out, making
    // the test a no-op. listOwnProcessesMatching returns [11, 13, 7]; 7 is
    // currentPid (skipped), 11 is foreign-UID (skipped), 13 is own-UID node
    // (kept). Verify both delegation AND filter outcome.
    const seen: RegExp[] = []
    const ctx: ProcessLockContext = {
      currentPid: 7,
      uid: 42,
      listPortHolders: () => [],
      listOwnProcessesMatching(pattern) {
        seen.push(pattern)
        return [7, 11, 13]
      },
      getProcessCommand: (pid) => pid === 11 ? null : 'node',
      getProcessUid: (pid) => pid === 11 ? 999 : 42,
      signal: () => 'sent',
      sleep: noopAsync,
      log: noopLog,
    }
    const acquirer = new PortLockAcquirer(ctx)
    const result = acquirer.findOwnBinaryMatches(/dashboard/)
    expect(result).toEqual([13])
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
    // Build the ctx inline (not via buildPortCtx) so getProcessCommand
    // returns 'node' and the default graceMs/drainMs branches actually run
    // -- the buildPortCtx defaults return null command which would skip
    // every holder and trigger the early return before any `opts.*` field
    // is accessed.
    const holdersByPort: Record<number, number[]> = {
      3420: [200],
      3421: [300],
    }
    const seenPorts: number[] = []
    const sleptFor: number[] = []
    const ctx: ProcessLockContext = {
      currentPid: 1000,
      uid: 501,
      listPortHolders(port) {
        seenPorts.push(port)
        return holdersByPort[port] ?? []
      },
      listOwnProcessesMatching: () => [],
      getProcessCommand: () => 'node',
      getProcessUid: () => 501,
      signal: () => 'sent',
      sleep: async (ms) => { sleptFor.push(ms) },
      log: noopLog,
    }
    const acquirer = new PortLockAcquirer(ctx)
    await acquirer.acquire(3420)
    await acquirer.acquire(3421)
    expect(seenPorts).toContain(3420)
    expect(seenPorts).toContain(3421)
    // Default graceMs (1500) and postKillDrainMs (2000) actually applied
    // because victims were non-empty. drainMs + pollMs > 0 short-circuit is
    // the first branch we want to confirm exercises the body past the
    // early-return. The first sleep should be graceMs (1500); the drain
    // polls are 100 each until either the port frees or drainMs elapses.
    expect(sleptFor[0]).toBe(1500)
    // Signature: only port is positional, opts is the default.
    expect(acquirer.acquire.length).toBe(1)
  })

  it('acquire(port, { binaryPattern }) integrates findOwnBinaryMatches into victim selection', async () => {
    // Direct class-path test for the `opts.binaryPattern` ternary on
    // process-lock.ts:179 -- not just findOwnBinaryMatches in isolation.
    // The port is empty (no listeners) but a binary-pattern match picks up
    // the zombie process that already lost the port. Without binaryPattern,
    // acquire would return early with no victims.
    const signalCalls: { pid: number; sig: string }[] = []
    const ctx: ProcessLockContext = {
      currentPid: 1000,
      uid: 501,
      listPortHolders: () => [],
      listOwnProcessesMatching: () => [200],
      getProcessCommand: () => 'node',
      getProcessUid: () => 501,
      signal: (pid, sig) => {
        signalCalls.push({ pid, sig: String(sig) })
        return 'sent'
      },
      sleep: noopAsync,
      log: noopLog,
    }
    await new PortLockAcquirer(ctx).acquire(3420, {
      graceMs: 5,
      binaryPattern: /dist\/index\.js/,
      postKillDrainMs: 0,
    })
    expect(signalCalls.some(c => c.pid === 200 && c.sig === 'SIGTERM')).toBe(true)
  })

  it('acquire polls listPortHolders during the post-kill drain window', async () => {
    // Direct class-path test for the drain loop on process-lock.ts:191-196.
    // listPortHolders returns the holder for the first 3 polls, then drops
    // it. Drain budget is 4 polls * 25ms = 100ms; the holder clears at poll
    // 3 (waited=75ms) so the loop must return at the top of the next iter
    // without logging the "still held" warning.
    const polls: number[] = []
    let pollCount = 0
    const ctx: ProcessLockContext = {
      currentPid: 1000,
      uid: 501,
      listPortHolders() {
        polls.push(Date.now())
        pollCount += 1
        return pollCount > 3 ? [] : [200]
      },
      listOwnProcessesMatching: () => [],
      getProcessCommand: () => 'node',
      getProcessUid: () => 501,
      signal: () => 'sent',
      sleep: noopAsync,
      log: noopLog,
    }
    await new PortLockAcquirer(ctx).acquire(3420, {
      graceMs: 5,
      postKillDrainMs: 100,
      postKillPollMs: 25,
    })
    // At least 3 drain polls happened (the third returns empty and exits).
    expect(pollCount).toBeGreaterThanOrEqual(3)
  })
})

describe('PidfileLockAcquirer', () => {
  it('acquire(path, selfPid) opts nélkül -- default ág, létrehozza a pidfile-t', async () => {
    // Pin that the class method defaults the options object just like the
    // free function did, and that `this.ctx.tryCreateExclusive` is called.
    const files = new Map<string, number>()
    const ctx = buildPidfileCtx({ files })
    const acquirer = new PidfileLockAcquirer(ctx)
    await acquirer.acquire('/tmp/test.pid', 42)
    expect(files.get('/tmp/test.pid')).toBe(42)
    // Signature pins: no positional opts.
    expect(acquirer.acquire.length).toBe(2)
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

describe('PidfileLockAcquirer.release', () => {
  it('unlinks when recorded === selfPid', () => {
    // Pin the happy path: when the pidfile still records our PID, release()
    // must call ctx.unlinkIfMatches with the recorded PID so the file is
    // dropped. If the impl skips unlinkIfMatches or passes a different
    // value, the buildPidfileCtx helper's `if (cur !== expected) return`
    // guard leaves the file intact and this assertion catches the drift.
    const files = new Map<string, number>([['/tmp/test.pid', 42]])
    const ctx = buildPidfileCtx({ files })
    new PidfileLockAcquirer(ctx).release('/tmp/test.pid', 42)
    expect(files.has('/tmp/test.pid')).toBe(false)
  })

  it('is a no-op when recorded !== selfPid', () => {
    // PID recycling scenario: a successor already overwrote the pidfile
    // with its own PID. release() must NOT delete the file (the guard
    // `recorded !== selfPid` returns early before any unlink). Pin both:
    // the file survives, AND unlinkIfMatches was never invoked.
    const files = new Map<string, number>([['/tmp/test.pid', 99]])
    let unlinkCalls = 0
    const ctx: PidfileLockContext = {
      ...buildPidfileCtx({ files }),
      unlinkIfMatches(path, expected) {
        unlinkCalls += 1
        const cur = files.get(path)
        if (expected === null) { if (cur === undefined) files.delete(path); return }
        if (cur !== expected) return
        files.delete(path)
      },
    }
    new PidfileLockAcquirer(ctx).release('/tmp/test.pid', 42)
    expect(files.get('/tmp/test.pid')).toBe(99)
    expect(unlinkCalls).toBe(0)
  })

  it('is a no-op when recorded is null (corrupt pidfile)', () => {
    // Corrupt-pidfile case: file exists but readRecordedPid returns null
    // (truncated write, garbage content). release() must early-return
    // before unlinkIfMatches -- the slot may belong to a concurrent peer
    // mid-write. Pin the file is untouched AND unlinkIfMatches never ran.
    const files = new Map<string, number>([['/tmp/test.pid', 999]])
    let unlinkCalls = 0
    const ctx: PidfileLockContext = {
      ...buildPidfileCtx({ files }),
      readRecordedPid: () => null,
      unlinkIfMatches(path, expected) {
        unlinkCalls += 1
        const cur = files.get(path)
        if (expected === null) { if (cur === undefined) files.delete(path); return }
        if (cur !== expected) return
        files.delete(path)
      },
    }
    new PidfileLockAcquirer(ctx).release('/tmp/test.pid', 42)
    expect(files.get('/tmp/test.pid')).toBe(999)
    expect(unlinkCalls).toBe(0)
  })
})
