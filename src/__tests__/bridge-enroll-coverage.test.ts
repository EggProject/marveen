// 100% coverage for src/web/bridge-enroll.ts.
//
// This file closes the three branch-coverage gaps that remained after
// bridge-enroll.test.ts and bridge-enroll-host.test.ts:
//   - line 113: `err ? null : stdout` inside the default keyscan -- both
//     branches of the ternary need a controlled execFile callback.
//   - line 147: `ifaces[name] ?? []` inside selectEnrollHost -- the
//     `?? []` fallback is dead until an interface value is undefined.
//   - line 198: `input.host ?? primaryIPv4() ?? hostname()` -- the
//     explicit-host precedence branch (input.host set) and the
//     hostname()-fallback branch (primaryIPv4 returns null) need both
//     paths driven.
//
// All SUT collaborators are mocked so the suite stays in os.tmpdir() and
// never touches ~/.ssh, the host network, or the live store.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')

  // Sandbox for any fs work the SUT still wants to do (defaultBridgeEnrollDeps
  // readFileSync for ssh host key files).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-enroll-coverage-'))

  return {
    tmp,
    // execFile behaviour the test controls: by default success with stdout,
    // tests can flip to an err to exercise line 113.
    execFileErr: null as Error | null,
    execFileStdout: '127.0.0.1 ssh-ed25519 AAAA',
    // networkInterfaces stub: tests can flip to {} to exercise the
    // hostname() fallback on line 198.
    ifaces: {} as Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>,
    loggerWarn: vi.fn(),
    loggerInfo: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),
  }
})

vi.mock('node:child_process', () => ({
  // execFile used by defaultBridgeEnrollDeps().keyscan -- the only consumer
  // in bridge-enroll.ts. The callback form means we must invoke the
  // callback synchronously to keep the keyscan() promise's timing simple
  // for the test.
  execFile: vi.fn(
    (
      _cmd: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string) => void,
    ) => {
      if (H.execFileErr) cb(H.execFileErr, '')
      else cb(null, H.execFileStdout)
    },
  ),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return {
    ...actual,
    // homedir is used by defaultBridgeEnrollDeps (resolveSshDir -> join(homedir(), '.ssh')).
    // Point it inside the sandbox so readFile for ~/.ssh/... stays in tmp.
    homedir: () => H.tmp,
    // networkInterfaces is what primaryIPv4() ultimately reads; tests flip
    // H.ifaces to control which "interface" the selector sees.
    networkInterfaces: () => H.ifaces,
  }
})

vi.mock('../logger.js', () => ({
  logger: { warn: H.loggerWarn, info: H.loggerInfo, error: H.loggerError, debug: H.loggerDebug },
}))

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    WEB_PORT: 3420,
  }
})

// Stub the FS collaborators bridge-enroll.ts talks to so the suite never
// reaches the live ~/.ssh, the live authorized_keys, the live device-key DB,
// or the live remote-enroll-fs file writer.
vi.mock('../remote-enroll-fs.js', () => ({
  enrollAuthorizedKey: vi.fn(async () => ({ action: 'added', warnings: [] })),
  removeEnrolledKey: vi.fn(async () => ({ removed: true })),
}))

// Stub remote-enroll-core's host-key resolver so bridgeEnroll's "resolve host
// key FIRST" path always succeeds with the body key we control.
const HOST_KEY_BODY = 'A'.repeat(64)
vi.mock('../remote-enroll-core.js', async (orig) => {
  const real = await orig<typeof import('../remote-enroll-core.js')>()
  return {
    ...real,
    resolveHostKey: vi.fn(({ keyscan }: { keyscan: () => string | null }) => {
      // Mirror the real resolver: if the keyscan callback returns null
      // (e.g. execFile failed), we have no host key to embed. Otherwise
      // hand back a body key the tests control.
      const k = keyscan()
      if (k === null) return null
      return { body: HOST_KEY_BODY, source: 'test' }
    }),
  }
})

const { initDatabase, getDb } = await import('../db.js')
const bridgeMod = await import('../web/bridge-enroll.js')
const bridgeEnroll = bridgeMod.bridgeEnroll
const defaultBridgeEnrollDeps = bridgeMod.defaultBridgeEnrollDeps
const selectEnrollHost = bridgeMod.selectEnrollHost
const sshDirOverride = bridgeMod.sshDirOverride
const removeBridgeSshAccess = bridgeMod.removeBridgeSshAccess
const RemoteEnrollError = bridgeMod.RemoteEnrollError
type BridgeEnrollDeps = NonNullable<Parameters<typeof bridgeEnroll>[1]>

// --- helpers ----------------------------------------------------------------

/** Build a VALID `ssh-ed25519 <base64> marveen-remote:<uuid>` line. */
function makeKeyLine(installId = randomUUID()): string {
  const type = Buffer.from('ssh-ed25519', 'utf8')
  const key = randomBytes(32)
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]), type,
    Buffer.from([0, 0, 0, 32]), key,
  ])
  return `ssh-ed25519 ${blob.toString('base64')} marveen-remote:${installId}`
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  H.execFileErr = null
  H.execFileStdout = '127.0.0.1 ssh-ed25519 AAAA'
  H.ifaces = {}
  H.loggerWarn.mockReset()
  H.loggerInfo.mockReset()
  H.loggerError.mockReset()
  H.loggerDebug.mockReset()
  getDb().prepare('DELETE FROM device_keys').run()
  getDb().prepare('DELETE FROM config_change_log').run()
})

afterEach(() => {
  delete process.env.MARVEEN_SSH_DIR
})

// --- sshDirOverride() -------------------------------------------------------

describe('sshDirOverride', () => {
  it('returns null when the env var is not set', () => {
    delete process.env.MARVEEN_SSH_DIR
    expect(sshDirOverride()).toBe(null)
  })

  it('returns the env var value when set', () => {
    process.env.MARVEEN_SSH_DIR = '/some/path'
    expect(sshDirOverride()).toBe('/some/path')
  })
})

// --- defaultBridgeEnrollDeps() readFile + keyscan --------------------------

describe('defaultBridgeEnrollDeps().readFile', () => {
  it('returns the file contents on success', () => {
    const p = join(H.tmp, 'ssh_host_ed25519_key')
    writeFileSync(p, 'pubkey contents')
    const deps = defaultBridgeEnrollDeps()
    expect(deps.readFile(p)).toBe('pubkey contents')
  })

  it('returns null when the file is missing (ENOENT)', () => {
    const deps = defaultBridgeEnrollDeps()
    expect(deps.readFile(join(H.tmp, 'does-not-exist'))).toBe(null)
  })
})

describe('defaultBridgeEnrollDeps().keyscan', () => {
  it('resolves with the execFile stdout when execFile succeeds (line 113 err=false branch)', async () => {
    H.execFileStdout = '127.0.0.1 ssh-ed25519 AAAAsuccess'
    H.execFileErr = null
    const deps = defaultBridgeEnrollDeps()
    await expect(deps.keyscan()).resolves.toBe('127.0.0.1 ssh-ed25519 AAAAsuccess')
  })

  it('resolves with null when execFile reports an error (line 113 err=true branch)', async () => {
    H.execFileErr = new Error('ssh-keyscan not found')
    const deps = defaultBridgeEnrollDeps()
    await expect(deps.keyscan()).resolves.toBe(null)
  })
})

// --- selectEnrollHost: ifaces[name] ?? [] branch (line 147) ---------------

describe('selectEnrollHost', () => {
  it('skips a name whose ifaces[name] is undefined (drives the ?? [] fallback)', () => {
    // en0 maps to undefined -- the loop must NOT throw on it. A second
    // interface supplies the actual answer, so we can observe the
    // iteration order survived the gap.
    const host = selectEnrollHost({
      en0: undefined,
      utun4: [{ address: '100.115.9.11', family: 'IPv4', internal: false }],
    })
    expect(host).toBe('100.115.9.11')
  })

  it('returns null when the only entry is undefined', () => {
    expect(selectEnrollHost({ en0: undefined })).toBe(null)
  })

  it('treats an undefined entry inside a multi-entry map as a no-op', () => {
    const host = selectEnrollHost({
      en0: undefined,
      en1: [{ address: '192.168.1.5', family: 'IPv4', internal: false }],
    })
    expect(host).toBe('192.168.1.5')
  })
})

// --- bridgeEnroll: input.host precedence (line 198) -----------------------

describe('bridgeEnroll host selection (input.host precedence)', () => {
  it('uses input.host when set, skipping primaryIPv4() entirely', async () => {
    // Even though networkInterfaces has a perfectly good tailnet address,
    // the explicit input.host must win.
    H.ifaces = {
      utun4: [{ address: '100.115.9.11', family: 'IPv4', internal: false }],
    }
    const deps: BridgeEnrollDeps = {
      sshDir: H.tmp,
      readFile: () => null,
      keyscan: async () => '127.0.0.1 ssh-ed25519 AAAA',
    }
    const outcome = await bridgeEnroll(
      { keyLine: makeKeyLine(), name: 'explicit-host', host: '198.51.100.7' },
      deps,
    )
    expect(outcome.host).toBe('198.51.100.7')
  })

  it('falls back to hostname() when input.host is unset and primaryIPv4() returns null', async () => {
    // Empty interface map -> primaryIPv4() returns null. With input.host
    // unset, the chain falls through to hostname(). The default keyscan
    // path is bypassed because the deps override sets it to null -- that
    // makes resolveHostKey() return null and we DON'T reach the bundle
    // construction (which is the line we want to exercise). To exercise
    // the actual line-198 fallback, we need a successful keyscan.
    H.ifaces = {}
    const deps: BridgeEnrollDeps = {
      sshDir: H.tmp,
      readFile: () => null,
      keyscan: async () => '127.0.0.1 ssh-ed25519 AAAA',
    }
    const outcome = await bridgeEnroll(
      { keyLine: makeKeyLine(), name: 'no-net-ifaces' },
      deps,
    )
    expect(outcome.host).not.toBe(null)
    expect(outcome.host).not.toBe('')
    // The fallback for an empty networkInterfaces() must be the hostname.
    const { hostname } = await import('node:os')
    expect(outcome.host).toBe(hostname())
  })

  it('uses the first tailnet address from primaryIPv4() when input.host is unset', async () => {
    H.ifaces = {
      en0: [{ address: '192.168.0.10', family: 'IPv4', internal: false }],
      utun4: [{ address: '100.115.9.11', family: 'IPv4', internal: false }],
    }
    const deps: BridgeEnrollDeps = {
      sshDir: H.tmp,
      readFile: () => null,
      keyscan: async () => '127.0.0.1 ssh-ed25519 AAAA',
    }
    const outcome = await bridgeEnroll(
      { keyLine: makeKeyLine(), name: 'auto-host' },
      deps,
    )
    expect(outcome.host).toBe('100.115.9.11')
  })
})

// --- removeBridgeSshAccess (deps branch) -----------------------------------

describe('removeBridgeSshAccess with deps.sshDir override', () => {
  it('uses the provided sshDir from deps instead of the env-based resolution', async () => {
    // Build a fake sshDir that has an authorized_keys file with a target line.
    const sshDir = mkdtempSync(join(tmpdir(), 'bridge-rm-'))
    try {
      const installId = randomUUID()
      const type = Buffer.from('ssh-ed25519', 'utf8')
      const blob = Buffer.concat([
        Buffer.from([0, 0, 0, type.length]), type,
        Buffer.from([0, 0, 0, 32]), randomBytes(32),
      ])
      const line = `ssh-ed25519 ${blob.toString('base64')} marveen-remote:${installId}`
      mkdirSync(sshDir, { recursive: true })
      writeFileSync(join(sshDir, 'authorized_keys'), `${line}\n`)

      // The remote-enroll-fs mock above always reports removed: true; this
      // pins the deps.sshDir branch of removeBridgeSshAccess -- the
      // function returns the boolean from the underlying call.
      const removed = await removeBridgeSshAccess(installId, { sshDir })
      expect(removed).toBe(true)
    } finally {
      rmSync(sshDir, { recursive: true, force: true })
    }
  })
})

// --- smoke: default deps end-to-end (real execFile err path integration) ---

describe('bridgeEnroll with default deps and an execFile err', () => {
  it('throws RemoteEnrollError without side effects when the default keyscan fails', async () => {
    // Force the default keyscan to resolve null through the err branch.
    H.execFileErr = new Error('ENOENT ssh-keyscan')
    // The real bridge-enroll.ts resolveSshDir() reads ~/.ssh via homedir()
    // (mocked to H.tmp); the mocked remote-enroll-fs.enrollAuthorizedKey is
    // a no-op so this test does NOT touch the filesystem at all.
    await expect(
      bridgeEnroll({ keyLine: makeKeyLine(), name: 'no-keyscan' }),
    ).rejects.toBeInstanceOf(RemoteEnrollError)
    // No device key should have been minted.
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM device_keys').get() as { c: number }).c).toBe(0)
  })
})