import { describe, it, expect } from 'vitest'
import {
  findOwnNodeHolders,
  findOwnBinaryMatches,
  terminateProcesses,
  acquirePortLock,
  acquirePidfileLock,
  writeBufferFully,
  DeferToPeerError,
  type ProcessLockContext,
  type PidfileLockContext,
} from '../process-lock.js'

// Build a mock context backed by a mutable process table. Tests drive the
// table directly so we can simulate PIDs dying at specific points, foreign
// UIDs, non-node commands, etc. without ever touching real processes.

interface MockProc { pid: number; uid: number; cmd: string; args?: string; alive: boolean }

interface MockOptions {
  currentPid?: number
  uid?: number | null
  procs?: MockProc[]
  portHolders?: Record<number, number[]>
  /** signal-probe override so tests can simulate EPERM etc. */
  signalOverride?: ProcessLockContext['signal']
}

function makeCtx(options: MockOptions): {
  ctx: ProcessLockContext
  table: Map<number, MockProc>
  sleptFor: number[]
  logs: Array<{ level: string; msg: string; obj: Record<string, unknown> }>
  signalCalls: Array<{ pid: number; sig: string }>
} {
  const table = new Map<number, MockProc>()
  for (const p of options.procs ?? []) table.set(p.pid, { ...p })
  const sleptFor: number[] = []
  const logs: Array<{ level: string; msg: string; obj: Record<string, unknown> }> = []
  const signalCalls: Array<{ pid: number; sig: string }> = []
  const log = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    logs.push({ level, msg: msg ?? '', obj })
  }
  const currentPid = options.currentPid ?? 100
  const uid = options.uid === undefined ? 501 : options.uid
  const defaultSignal: ProcessLockContext['signal'] = (pid, sig) => {
    const p = table.get(pid)
    if (!p || !p.alive) return 'gone'
    if (sig === 0) return 'sent'
    p.alive = false
    return 'sent'
  }
  const ctx: ProcessLockContext = {
    currentPid,
    uid,
    listPortHolders: (port: number) => options.portHolders?.[port] ?? [],
    listOwnProcessesMatching: (pattern: RegExp) => {
      const out: number[] = []
      for (const p of table.values()) {
        if (!p.alive) continue
        if (p.pid === currentPid) continue
        if (uid != null && p.uid !== uid) continue
        const argv = p.args ?? p.cmd
        if (pattern.test(argv)) out.push(p.pid)
      }
      return out
    },
    getProcessCommand: (pid: number) => table.get(pid)?.cmd ?? null,
    getProcessUid: (pid: number) => {
      const p = table.get(pid)
      return p ? p.uid : null
    },
    signal: (pid, sig) => {
      signalCalls.push({ pid, sig: String(sig) })
      if (options.signalOverride) return options.signalOverride(pid, sig)
      return defaultSignal(pid, sig)
    },
    sleep: async (ms: number) => {
      sleptFor.push(ms)
    },
    log: { info: log('info'), warn: log('warn'), error: log('error') },
  }
  return { ctx, table, sleptFor, logs, signalCalls }
}

describe('findOwnNodeHolders', () => {
  it('returns an empty list when no one holds the port', () => {
    const { ctx } = makeCtx({ portHolders: { 3420: [] } })
    expect(findOwnNodeHolders(3420, ctx)).toEqual([])
  })

  it('excludes the current PID even if it appears in the holder list', () => {
    const procs: MockProc[] = [
      { pid: 100, uid: 501, cmd: 'node', alive: true },
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    const { ctx } = makeCtx({ currentPid: 100, procs, portHolders: { 3420: [100, 200] } })
    expect(findOwnNodeHolders(3420, ctx)).toEqual([200])
  })

  it('excludes processes owned by a different UID', () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 502, cmd: 'node', alive: true },
      { pid: 300, uid: 501, cmd: 'node', alive: true },
    ]
    const { ctx, logs } = makeCtx({ uid: 501, procs, portHolders: { 3420: [200, 300] } })
    expect(findOwnNodeHolders(3420, ctx)).toEqual([300])
    expect(logs.some(l => l.level === 'warn' && /different UID/.test(l.msg))).toBe(true)
  })

  it('excludes non-node commands', () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'nginx', alive: true },
      { pid: 300, uid: 501, cmd: 'node', alive: true },
      { pid: 400, uid: 501, cmd: 'tsx', alive: true },
    ]
    const { ctx, logs } = makeCtx({ procs, portHolders: { 3420: [200, 300, 400] } })
    expect(findOwnNodeHolders(3420, ctx)).toEqual([300, 400])
    expect(logs.some(l => l.level === 'warn' && /not a node\/tsx/.test(l.msg))).toBe(true)
  })

  it('skips PIDs that are gone between lsof and ps', () => {
    const procs: MockProc[] = [
      { pid: 300, uid: 501, cmd: 'node', alive: true },
    ]
    const { ctx } = makeCtx({ procs, portHolders: { 3420: [200, 300] } })
    expect(findOwnNodeHolders(3420, ctx)).toEqual([300])
  })

  it('skips non-positive or non-finite PIDs defensively', () => {
    const { ctx } = makeCtx({ portHolders: { 3420: [0, -1, NaN as unknown as number] } })
    expect(findOwnNodeHolders(3420, ctx)).toEqual([])
  })

  it('skips UID check when the platform has no getuid (uid=null)', () => {
    const procs: MockProc[] = [
      { pid: 300, uid: 0, cmd: 'node', alive: true },
    ]
    const { ctx } = makeCtx({ uid: null, procs, portHolders: { 3420: [300] } })
    expect(findOwnNodeHolders(3420, ctx)).toEqual([300])
  })

  it('deduplicates PIDs that appear twice in the holder list', () => {
    const procs: MockProc[] = [
      { pid: 300, uid: 501, cmd: 'node', alive: true },
    ]
    const { ctx } = makeCtx({ procs, portHolders: { 3420: [300, 300] } })
    expect(findOwnNodeHolders(3420, ctx)).toEqual([300])
  })

  it('skips a PID whose owning UID lookup returns null (process gone between ps and stat)', () => {
    // Pins line 105: the ctx.uid != null guard enables a UID equality check;
    // when getProcessUid returns null the helper must `continue` and leave
    // the PID alone rather than treating it as a candidate. Simulate the
    // race where the PID was alive when lsof listed it but died before ps.
    const { ctx } = makeCtx({
      uid: 501,
      procs: [{ pid: 300, uid: 501, cmd: 'node', alive: true }],
      portHolders: { 3420: [300] },
    })
    ctx.getProcessUid = () => null // process vanished between ps and stat
    expect(findOwnNodeHolders(3420, ctx)).toEqual([])
  })
})

describe('findOwnBinaryMatches', () => {
  it('returns own-UID node processes matching the argv pattern', () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', args: 'node dist/index.js', alive: true },
      { pid: 300, uid: 501, cmd: 'node', args: 'node other.js', alive: true },
    ]
    const { ctx } = makeCtx({ procs })
    expect(findOwnBinaryMatches(/dist\/index\.js/, ctx)).toEqual([200])
  })

  it('excludes the current PID even if its argv matches', () => {
    const procs: MockProc[] = [
      { pid: 100, uid: 501, cmd: 'node', args: 'node dist/index.js', alive: true },
      { pid: 200, uid: 501, cmd: 'node', args: 'node dist/index.js', alive: true },
    ]
    const { ctx } = makeCtx({ currentPid: 100, procs })
    expect(findOwnBinaryMatches(/dist\/index\.js/, ctx)).toEqual([200])
  })

  it('excludes foreign-UID processes even with matching argv', () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 999, cmd: 'node', args: 'node dist/index.js', alive: true },
    ]
    const { ctx } = makeCtx({ uid: 501, procs })
    expect(findOwnBinaryMatches(/dist\/index\.js/, ctx)).toEqual([])
  })
})

describe('terminateProcesses', () => {
  it('is a no-op on empty input', async () => {
    const { ctx, sleptFor } = makeCtx({})
    await terminateProcesses([], ctx, { graceMs: 1500 })
    expect(sleptFor).toEqual([])
  })

  it('sends SIGTERM, waits the grace window, does not escalate if process died', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    const { ctx, table, sleptFor, signalCalls } = makeCtx({ procs })
    await terminateProcesses([200], ctx, { graceMs: 1500 })
    expect(sleptFor).toEqual([1500])
    expect(table.get(200)!.alive).toBe(false)
    expect(signalCalls.filter(c => c.sig === 'SIGKILL')).toEqual([])
  })

  it('escalates to SIGKILL if SIGTERM did not kill the process', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    const signalOverride: ProcessLockContext['signal'] = (pid, sig) => {
      const p = procs.find(x => x.pid === pid)!
      if (sig === 'SIGTERM') return 'sent' // no-op (hung process)
      if (sig === 0) return p.alive ? 'sent' : 'gone'
      if (sig === 'SIGKILL') { p.alive = false; return 'sent' }
      return 'gone'
    }
    const { ctx, signalCalls } = makeCtx({ procs, signalOverride })
    await terminateProcesses([200], ctx, { graceMs: 10 })
    expect(signalCalls.map(c => c.sig)).toEqual(['SIGTERM', '0', 'SIGKILL'])
  })

  it('escalates to SIGKILL when signal(0) throws EPERM (process alive, we just cannot probe)', async () => {
    // The process table still shows alive, but the liveness probe throws.
    // The real ctx rethrows anything that isn't ESRCH. We must treat that as
    // "still alive" and escalate, otherwise a zombie we can't probe would
    // survive startup.
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    const signalOverride: ProcessLockContext['signal'] = (pid, sig) => {
      const p = procs.find(x => x.pid === pid)!
      if (sig === 'SIGTERM') return 'sent' // ignored
      if (sig === 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      if (sig === 'SIGKILL') { p.alive = false; return 'sent' }
      return 'gone'
    }
    const { ctx, signalCalls } = makeCtx({ procs, signalOverride })
    await terminateProcesses([200], ctx, { graceMs: 10 })
    expect(signalCalls.map(c => c.sig)).toEqual(['SIGTERM', '0', 'SIGKILL'])
  })

  it('does not escalate when signal(0) returns gone (ESRCH)', async () => {
    const signalOverride: ProcessLockContext['signal'] = (_pid, sig) => {
      if (sig === 'SIGTERM') return 'sent'
      if (sig === 0) return 'gone'
      return 'sent'
    }
    const { ctx, signalCalls } = makeCtx({ signalOverride })
    await terminateProcesses([200], ctx, { graceMs: 10 })
    expect(signalCalls.filter(c => c.sig === 'SIGKILL')).toEqual([])
  })

  it('handles several victims in parallel -- all get SIGTERM before the grace wait', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
      { pid: 300, uid: 501, cmd: 'node', alive: true },
      { pid: 400, uid: 501, cmd: 'node', alive: true },
    ]
    const { ctx, table, signalCalls } = makeCtx({ procs })
    await terminateProcesses([200, 300, 400], ctx, { graceMs: 10 })
    expect(signalCalls.slice(0, 3)).toEqual([
      { pid: 200, sig: 'SIGTERM' },
      { pid: 300, sig: 'SIGTERM' },
      { pid: 400, sig: 'SIGTERM' },
    ])
    expect(table.get(200)!.alive).toBe(false)
    expect(table.get(300)!.alive).toBe(false)
    expect(table.get(400)!.alive).toBe(false)
  })

  it('SIGTERM failure does not block SIGKILL escalation', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    const signalOverride: ProcessLockContext['signal'] = (pid, sig) => {
      const p = procs.find(x => x.pid === pid)!
      if (sig === 'SIGTERM') throw new Error('kaboom')
      if (sig === 0) return p.alive ? 'sent' : 'gone'
      if (sig === 'SIGKILL') { p.alive = false; return 'sent' }
      return 'gone'
    }
    const { ctx, signalCalls } = makeCtx({ procs, signalOverride })
    await terminateProcesses([200], ctx, { graceMs: 10 })
    expect(signalCalls.find(c => c.sig === 'SIGKILL')).toBeTruthy()
  })

  it('logs an error and swallows SIGKILL failure (best-effort escalation)', async () => {
    // The escalate-to-SIGKILL block has a try/catch around ctx.signal(SIGKILL).
    // When SIGKILL throws (EPERM, EACCES, or a process that refuses SIGKILL
    // entirely on a hardened kernel) the helper must log ctx.log.error and
    // continue to the next PID rather than crash the loop. Pin the previously-
    // missed line 158 branch (`SIGKILL failed`).
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    const signalOverride: ProcessLockContext['signal'] = (pid, sig) => {
      const p = procs.find(x => x.pid === pid)!
      if (sig === 'SIGTERM') return 'sent' // no-op (hung process)
      if (sig === 0) return p.alive ? 'sent' : 'gone' // still alive
      if (sig === 'SIGKILL') throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return 'gone'
    }
    const { ctx, logs } = makeCtx({ procs, signalOverride })
    await expect(terminateProcesses([200], ctx, { graceMs: 10 })).resolves.toBeUndefined()
    expect(logs.some(l => l.level === 'error' && /SIGKILL failed/.test(l.msg))).toBe(true)
  })

  it('does not log "SIGTERM sent" when signal returns "gone" (process-lock.ts:136 branch[1])', async () => {
    // A \`signal(pid, 'SIGTERM')\` hivasa csak akkor ter vissza 'gone'-nal
    // (es nem dob), ha a process mar nem letezik EPPEN a kill elott. Ez a
    // boundary case kihagyja az `if (out === 'sent')` info-log sort -- az
    // eddigi tesztek mind a 'sent' agat exercise-elték (100% branch[0]).
    const signalOverride: ProcessLockContext['signal'] = (_pid, sig) => {
      if (sig === 'SIGTERM') return 'gone'
      if (sig === 0) return 'gone'
      return 'sent'
    }
    const { ctx, logs } = makeCtx({ signalOverride })
    await terminateProcesses([200], ctx, { graceMs: 10 })
    expect(logs.some(l => l.level === 'info' && /SIGTERM sent to previous instance/.test(l.msg))).toBe(false)
    // A grace utan a signal(0) is 'gone' volt, tehat nem eskalalunk -- de a
    // SIGTERM-et sem logoltuk, mert a signal() mondta hogy 'gone'.
    expect(logs.some(l => l.level === 'warn' && /escalating to SIGKILL/.test(l.msg))).toBe(false)
  })
})

describe('acquirePortLock', () => {
  it('returns immediately if no one holds the port and no binary pattern is given', async () => {
    const { ctx, sleptFor } = makeCtx({ portHolders: { 3420: [] } })
    await acquirePortLock(3420, ctx)
    expect(sleptFor).toEqual([])
  })

  it('returns immediately if the only holder is the current PID', async () => {
    const procs: MockProc[] = [
      { pid: 100, uid: 501, cmd: 'node', alive: true },
    ]
    const { ctx, sleptFor } = makeCtx({ currentPid: 100, procs, portHolders: { 3420: [100] } })
    await acquirePortLock(3420, ctx)
    expect(sleptFor).toEqual([])
  })

  it('kills an old dashboard instance holding the port', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    const { ctx, table } = makeCtx({ procs, portHolders: { 3420: [200] } })
    await acquirePortLock(3420, ctx, { graceMs: 10 })
    expect(table.get(200)!.alive).toBe(false)
  })

  it('kills a zombie that lost the port but still runs the binary', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', args: 'node dist/index.js', alive: true },
    ]
    const { ctx, table } = makeCtx({ procs, portHolders: { 3420: [] } })
    await acquirePortLock(3420, ctx, { graceMs: 10, binaryPattern: /dist\/index\.js/ })
    expect(table.get(200)!.alive).toBe(false)
  })

  it('deduplicates a zombie that both holds the port AND matches the binary', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', args: 'node dist/index.js', alive: true },
    ]
    const { ctx, signalCalls } = makeCtx({ procs, portHolders: { 3420: [200] } })
    await acquirePortLock(3420, ctx, { graceMs: 10, binaryPattern: /dist\/index\.js/ })
    // SIGTERM should only be sent once per victim, not twice
    expect(signalCalls.filter(c => c.sig === 'SIGTERM' && c.pid === 200)).toHaveLength(1)
  })

  it('kills multiple zombie instances in one pass', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
      { pid: 300, uid: 501, cmd: 'node', alive: true },
    ]
    const { ctx, table } = makeCtx({ procs, portHolders: { 3420: [200, 300] } })
    await acquirePortLock(3420, ctx, { graceMs: 10 })
    expect(table.get(200)!.alive).toBe(false)
    expect(table.get(300)!.alive).toBe(false)
  })

  it('leaves a foreign-UID process alone and does not sleep', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 999, cmd: 'node', alive: true },
    ]
    const { ctx, table, sleptFor } = makeCtx({ uid: 501, procs, portHolders: { 3420: [200] } })
    await acquirePortLock(3420, ctx, { graceMs: 10, postKillDrainMs: 0 })
    expect(table.get(200)!.alive).toBe(true)
    expect(sleptFor).toEqual([])
  })

  it('polls listPortHolders after kill until the port is free (drain)', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    // Port holder list reflects the mutable table -- once 200 dies, it
    // "drops" off the port. Simulate this by wiring listPortHolders to
    // return 200 only while alive.
    const portHolders: Record<number, number[]> = { 3420: [200] }
    const { ctx, table } = makeCtx({ procs, portHolders })
    // Override listPortHolders to reflect alive-ness dynamically.
    const liveOnly: ProcessLockContext = {
      ...ctx,
      listPortHolders(port: number) {
        const holders = portHolders[port] ?? []
        return holders.filter(pid => table.get(pid)?.alive)
      },
    }
    await acquirePortLock(3420, liveOnly, { graceMs: 10, postKillDrainMs: 200, postKillPollMs: 10 })
    expect(table.get(200)!.alive).toBe(false)
  })

  it('logs a warning if the port stays held past the drain window', async () => {
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    const portHolders: Record<number, number[]> = { 3420: [200] }
    // signal() marks the proc dead, but listPortHolders keeps returning
    // 200 -- simulates kernel still holding the socket in TIME_WAIT.
    const { ctx, logs } = makeCtx({ procs, portHolders })
    const stickyPort: ProcessLockContext = {
      ...ctx,
      listPortHolders() { return [200] },
    }
    await acquirePortLock(3420, stickyPort, { graceMs: 10, postKillDrainMs: 30, postKillPollMs: 10 })
    expect(logs.some(l => l.level === 'warn' && /still held after drain/.test(l.msg))).toBe(true)
  })

  it('skips the post-kill drain polling when pollMs <= 0 even if drainMs > 0', async () => {
    // Pins the `pollMs <= 0` right arm of the `if (drainMs <= 0 || pollMs <= 0)`
    // short-circuit on line 183. The left arm (drainMs <= 0) is exercised by
    // `postKillDrainMs: 0` cases; the right arm requires postKillPollMs: 0
    // while postKillDrainMs > 0. The expected behaviour is to skip the
    // drain-poll loop entirely -- the helper returns immediately after the
    // SIGKILL escalation, and the "still held after drain" warning MUST NOT
    // fire (we never polled, so we cannot know whether the port is held).
    const procs: MockProc[] = [
      { pid: 200, uid: 501, cmd: 'node', alive: true },
    ]
    const portHolders: Record<number, number[]> = { 3420: [200] }
    const { ctx, logs } = makeCtx({ procs, portHolders })
    const stickyPort: ProcessLockContext = {
      ...ctx,
      listPortHolders() { return [200] }, // would otherwise trip the drain warn
    }
    await acquirePortLock(3420, stickyPort, { graceMs: 10, postKillDrainMs: 30, postKillPollMs: 0 })
    expect(logs.some(l => l.level === 'warn' && /still held after drain/.test(l.msg))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// acquirePidfileLock

interface PidfileState {
  path: string
  files: Map<string, number>
  livePids: Set<number>
  legitimatePids: Set<number>
  termed: number[]
  unlinks: string[]
  sleptFor: number[]
  logs: Array<{ level: string; msg: string; obj: Record<string, unknown> }>
  probeAliveOverride?: (pid: number) => boolean
}

function makePidfileCtx(state: PidfileState): PidfileLockContext {
  const log = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    state.logs.push({ level, msg: msg ?? '', obj })
  }
  return {
    tryCreateExclusive(path, pid) {
      if (state.files.has(path)) return 'exists'
      state.files.set(path, pid)
      return 'created'
    },
    readRecordedPid(path) {
      return state.files.get(path) ?? null
    },
    unlinkIfMatches(path, expected) {
      const raw = state.files.get(path)
      // The mock only stores numeric PIDs; for the "non-parseable" file
      // case (recorded === null) we encode it as undefined in the map and
      // treat `expected === null` as "file content is still unparseable"
      // -- in that case, unlink unconditionally.
      const current = raw === undefined ? undefined : raw
      if (expected === null) {
        if (current === undefined) {
          state.unlinks.push(path)
          state.files.delete(path)
        }
        return
      }
      if (current !== expected) return
      state.unlinks.push(path)
      state.files.delete(path)
    },
    probeAlive(pid) {
      if (state.probeAliveOverride) return state.probeAliveOverride(pid)
      return state.livePids.has(pid)
    },
    sendTerm(pid) {
      state.termed.push(pid)
      state.livePids.delete(pid)
    },
    isLegitimatePredecessor(pid) {
      return state.legitimatePids.has(pid)
    },
    sleep: async (ms) => { state.sleptFor.push(ms) },
    log: { info: log('info'), warn: log('warn'), error: log('error') },
  }
}

function baseState(): PidfileState {
  return {
    path: '/tmp/test.pid',
    files: new Map(),
    livePids: new Set(),
    legitimatePids: new Set(),
    termed: [],
    unlinks: [],
    sleptFor: [],
    logs: [],
  }
}

describe('acquirePidfileLock', () => {
  it('creates the pidfile atomically when the path is free', async () => {
    const state = baseState()
    const ctx = makePidfileCtx(state)
    await acquirePidfileLock(state.path, 100, ctx)
    expect(state.files.get(state.path)).toBe(100)
    expect(state.termed).toEqual([])
    expect(state.unlinks).toEqual([])
  })

  it('unlinks a stale file whose recorded PID is gone, then retries', async () => {
    const state = baseState()
    state.files.set(state.path, 999) // stale, 999 is not in livePids
    const ctx = makePidfileCtx(state)
    await acquirePidfileLock(state.path, 100, ctx, { graceMs: 10 })
    expect(state.unlinks).toEqual([state.path])
    expect(state.files.get(state.path)).toBe(100)
    expect(state.termed).toEqual([])
  })

  it('SIGTERMs a live, legitimate predecessor and retries', async () => {
    const state = baseState()
    state.files.set(state.path, 999)
    state.livePids.add(999)
    state.legitimatePids.add(999)
    const ctx = makePidfileCtx(state)
    await acquirePidfileLock(state.path, 100, ctx, { graceMs: 20 })
    expect(state.termed).toEqual([999])
    expect(state.sleptFor).toEqual([20])
    expect(state.unlinks).toEqual([state.path])
    expect(state.files.get(state.path)).toBe(100)
  })

  it('does NOT SIGTERM a live but illegitimate PID (PID was recycled)', async () => {
    // Stale pidfile with PID=999, but PID 999 has been recycled to some
    // unrelated program (e.g. a shell). We must not kill it.
    const state = baseState()
    state.files.set(state.path, 999)
    state.livePids.add(999)
    // legitimatePids EMPTY -- not a dashboard process
    const ctx = makePidfileCtx(state)
    await acquirePidfileLock(state.path, 100, ctx, { graceMs: 10 })
    expect(state.termed).toEqual([])
    expect(state.files.get(state.path)).toBe(100)
    expect(state.logs.some(l => /not a dashboard process/.test(l.msg))).toBe(true)
  })

  it('unlinks a self-recorded file (recorded === selfPid) and retries', async () => {
    const state = baseState()
    state.files.set(state.path, 100) // our own PID somehow already in there
    const ctx = makePidfileCtx(state)
    await acquirePidfileLock(state.path, 100, ctx, { graceMs: 10 })
    expect(state.unlinks).toEqual([state.path])
    expect(state.files.get(state.path)).toBe(100)
  })

  it('gives up after maxAttempts if every attempt keeps seeing EEXIST', async () => {
    const state = baseState()
    // Override tryCreateExclusive to always fail; a concurrent writer keeps
    // recreating the file immediately after each unlink.
    state.files.set(state.path, 999)
    state.livePids.add(999)
    state.legitimatePids.add(999)
    const ctx = makePidfileCtx(state)
    // Monkey-patch: every successful unlink immediately replaces the
    // file, simulating a pathological writer that never relents.
    const origUnlinkIfMatches = ctx.unlinkIfMatches
    ctx.unlinkIfMatches = (path, expected) => {
      const before = state.files.get(path)
      origUnlinkIfMatches(path, expected)
      const after = state.files.get(path)
      if (before !== undefined && after === undefined) {
        state.files.set(path, 999)
        state.livePids.add(999)
      }
    }
    await expect(
      acquirePidfileLock(state.path, 100, ctx, { graceMs: 5, maxAttempts: 3 }),
    ).rejects.toThrow(/Failed to acquire pidfile lock/)
    expect(state.logs).toContainEqual(expect.objectContaining({
      level: 'error',
      msg: 'Failed to acquire pidfile lock after 3 attempts',
      obj: expect.objectContaining({ path: state.path, maxAttempts: 3, selfPid: 100 }),
    }))
  })

  it('treats a probeAlive throw as "still alive" (conservative)', async () => {
    const state = baseState()
    state.files.set(state.path, 999)
    state.legitimatePids.add(999)
    state.probeAliveOverride = () => { throw new Error('EPERM') }
    const ctx = makePidfileCtx(state)
    await acquirePidfileLock(state.path, 100, ctx, { graceMs: 10 })
    // Because probeAlive threw, we assumed alive, SIGTERMed, waited, then
    // unlinked.
    expect(state.termed).toEqual([999])
    expect(state.files.get(state.path)).toBe(100)
  })

  it('throws DeferToPeerError when onLiveLegitimate=defer and peer is alive-legit', async () => {
    const state = baseState()
    state.files.set(state.path, 999)
    state.livePids.add(999)
    state.legitimatePids.add(999)
    const ctx = makePidfileCtx(state)
    await expect(
      acquirePidfileLock(state.path, 100, ctx, { graceMs: 10, onLiveLegitimate: 'defer' }),
    ).rejects.toBeInstanceOf(DeferToPeerError)
    // Defer MUST NOT SIGTERM the winner
    expect(state.termed).toEqual([])
  })

  it('defer mode still unlinks stale (dead) entries', async () => {
    const state = baseState()
    state.files.set(state.path, 999) // recorded pid, but not alive
    const ctx = makePidfileCtx(state)
    await acquirePidfileLock(state.path, 100, ctx, { graceMs: 10, onLiveLegitimate: 'defer' })
    expect(state.files.get(state.path)).toBe(100)
  })

  it('does NOT unlink a third peer that took the slot during our SIGTERM-wait', async () => {
    // Regression for round-8 finding: a third startup can write its own
    // PID between our SIGTERM and our post-sleep unlink. An unconditional
    // unlink would erase it and let two dashboards run concurrently.
    const state = baseState()
    state.files.set(state.path, 999) // predecessor
    state.livePids.add(999)
    state.legitimatePids.add(999)
    const ctx = makePidfileCtx(state)
    // During the SIGTERM-wait in attempt 1, predecessor 999 cleanly exits
    // (releaseLock'd its own pidfile) and a third startup (PID 777) wins
    // the O_EXCL race with its own lock. The post-sleep unlinkIfMatches
    // must NOT erase 777's file even though we went in expecting to
    // remove 999.
    const origSleep = ctx.sleep
    ctx.sleep = async (ms) => {
      await origSleep(ms)
      state.files.delete(state.path)
      state.livePids.delete(999)
      state.files.set(state.path, 777)
      state.livePids.add(777)
      state.legitimatePids.add(777)
    }
    // Cap at 1 attempt so the test isolates the first-iteration
    // unlinkIfMatches behavior. With maxAttempts=1, acquirePidfileLock
    // throws "Failed to acquire" after a single SIGTERM + sleep pass.
    await expect(
      acquirePidfileLock(state.path, 100, ctx, { graceMs: 5, maxAttempts: 1 }),
    ).rejects.toThrow(/Failed to acquire pidfile lock/)
    // The third peer's file MUST still be intact.
    expect(state.files.get(state.path)).toBe(777)
  })

  it('defer mode still unlinks illegitimate (recycled) PIDs', async () => {
    const state = baseState()
    state.files.set(state.path, 999)
    state.livePids.add(999) // alive but NOT legitimate
    const ctx = makePidfileCtx(state)
    await acquirePidfileLock(state.path, 100, ctx, { graceMs: 10, onLiveLegitimate: 'defer' })
    expect(state.files.get(state.path)).toBe(100)
    expect(state.termed).toEqual([])
  })

  it('unlinks a non-parseable file (recorded === null) and retries', async () => {
    // Pins lines 310-311: when tryCreateExclusive returns 'exists' but
    // readRecordedPid returns null (file exists with truncated/corrupt
    // content that doesn't parse to a number), the helper must call
    // unlinkIfMatches(path, null) and continue to the next attempt.
    // Use a custom ctx whose readRecordedPid signals "exists but corrupt"
    // by returning null on the first read, then a parseable PID on the
    // retry (after the corrupt-file branch has run).
    const state = baseState()
    // Pre-populate the file with an unparseable value so tryCreateExclusive
    // returns 'exists' on the first attempt.
    state.files.set(state.path, undefined as unknown as number)
    let calls = 0
    const ctx = makePidfileCtx(state)
    const baseReadRecordedPid = ctx.readRecordedPid
    ctx.readRecordedPid = (path) => {
      calls += 1
      if (calls === 1) return null // first read: corrupt
      return baseReadRecordedPid(path) // subsequent reads: real mock
    }
    await acquirePidfileLock(state.path, 100, ctx, { graceMs: 10 })
    // The lock is eventually acquired on the retry.
    expect(state.files.get(state.path)).toBe(100)
  })

  it('logs a warning when sendTerm throws and continues with the retry', async () => {
    // Pins line 352: when ctx.sendTerm(recorded) throws, the helper must
    // log ctx.log.warn('SIGTERM to predecessor failed') and still proceed
    // to the grace sleep + retry cycle. A failed SIGTERM on one attempt
    // does NOT abort the loop.
    const state = baseState()
    state.files.set(state.path, 999)
    state.livePids.add(999)
    state.legitimatePids.add(999)
    const ctx = makePidfileCtx(state)
    ctx.sendTerm = (pid) => { state.termed.push(pid); throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
    await acquirePidfileLock(state.path, 100, ctx, { graceMs: 10 })
    expect(state.logs.some(l => l.level === 'warn' && /SIGTERM to predecessor failed/.test(l.msg))).toBe(true)
    // Eventually the predecessor is gone (the mock delete livePids before
    // throwing), so the lock is acquired on the next iteration.
    expect(state.files.get(state.path)).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// DASHBOARD_BINARY_PATTERN correctness
//
// Regression: the first version used `/\b(dist\/index\.js|src\/index\.ts)\b/`,
// which false-positive matched `dist/index.js.map`, `dist/index.js.bak`,
// `dist/index.js.old`, etc. because `\b` after `.js` boundaries between the
// 's' word-char and the next non-word '.'. The tightened form requires the
// dashboard filename to be followed by whitespace or end-of-string so
// editors/bundlers/watchers opening sibling files don't get SIGKILLed.

const DASHBOARD_BINARY_PATTERN = /(?:^|[\s/])(?:dist\/index\.js|src\/index\.ts)(?:\s|$)/

describe('writeBufferFully', () => {
  it('writes the whole buffer in a single shot when the writer accepts it all', () => {
    const chunks: Array<{ off: number; len: number }> = []
    const buf = Buffer.from('12345')
    writeBufferFully((_b, off, len) => { chunks.push({ off, len }); return len }, buf)
    expect(chunks).toEqual([{ off: 0, len: 5 }])
  })

  it('loops through short writes until the buffer is drained', () => {
    const chunks: number[] = []
    const buf = Buffer.from('12345')
    const sequence = [2, 1, 2] // simulate three short writes summing to 5
    let call = 0
    writeBufferFully((_b, off, len) => {
      const n = Math.min(sequence[call++], len)
      chunks.push(n)
      return n
    }, buf)
    expect(chunks).toEqual([2, 1, 2])
  })

  it('throws if the writer returns 0', () => {
    expect(() =>
      writeBufferFully(() => 0, Buffer.from('x')),
    ).toThrow(/returned 0/)
  })

  it('throws if the writer returns a negative number', () => {
    expect(() =>
      writeBufferFully(() => -1, Buffer.from('x')),
    ).toThrow(/returned -1/)
  })

  it('throws if the writer returns NaN', () => {
    expect(() =>
      writeBufferFully(() => NaN, Buffer.from('x')),
    ).toThrow(/returned NaN/)
  })

  it('handles an empty buffer without calling the writer', () => {
    let called = false
    writeBufferFully(() => { called = true; return 0 }, Buffer.alloc(0))
    expect(called).toBe(false)
  })
})

describe('DASHBOARD_BINARY_PATTERN', () => {
  it.each([
    'node dist/index.js',
    '/usr/local/bin/node /opt/repo/dist/index.js',
    'node --inspect dist/index.js',
    'tsx src/index.ts',
    'node dist/index.js --flag',
  ])('matches the canonical dashboard argv: %s', (argv) => {
    expect(DASHBOARD_BINARY_PATTERN.test(argv)).toBe(true)
  })

  it.each([
    'vim dist/index.js.bak',
    'node dist/index.js.map',
    'tail dist/index.js.old',
    'grep dist/index.jsx',
    'sh -c "cp dist/index.js.tmp dist/index.js.staged"',
    'prettier --write src/index.tsx',
  ])('does NOT match unrelated argvs that merely contain the name as a prefix: %s', (argv) => {
    expect(DASHBOARD_BINARY_PATTERN.test(argv)).toBe(false)
  })
})
