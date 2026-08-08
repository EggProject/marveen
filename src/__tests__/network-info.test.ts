import { describe, it, expect, vi } from 'vitest'
import { pickLanIp, isPrivateIpv4, detectLanIp } from '../web/network-info.js'

// Hoisted so vi.mock's factory (which hoists above import statements) can
// reference the same instance. The factory then forwards every other export
// of node:os through `actual` so we only intercept networkInterfaces.
const { mockNetworkInterfaces } = vi.hoisted(() => ({
  mockNetworkInterfaces: vi.fn(),
}))

vi.mock('node:os', () => ({
  default: {
    networkInterfaces: mockNetworkInterfaces,
  },
  networkInterfaces: mockNetworkInterfaces,
}))

// Minimal shape matching os.NetworkInterfaceInfo for the fields pickLanIp reads.
function v4(address: string, internal = false) {
  return { address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null } as any
}
function v6(address: string, internal = false) {
  return { address, family: 'IPv6', internal, netmask: '', mac: '00:00:00:00:00:00', cidr: null, scopeid: 0 } as any
}

describe('isPrivateIpv4', () => {
  it('accepts the three private ranges', () => {
    expect(isPrivateIpv4('10.0.0.5')).toBe(true)
    expect(isPrivateIpv4('192.168.1.50')).toBe(true)
    expect(isPrivateIpv4('172.16.4.4')).toBe(true)
    expect(isPrivateIpv4('172.31.255.1')).toBe(true)
  })
  it('rejects public, link-local, and 172.x outside 16-31', () => {
    expect(isPrivateIpv4('8.8.8.8')).toBe(false)
    expect(isPrivateIpv4('169.254.1.2')).toBe(false) // link-local
    expect(isPrivateIpv4('172.15.0.1')).toBe(false)
    expect(isPrivateIpv4('172.32.0.1')).toBe(false)
  })
})

describe('pickLanIp', () => {
  it('picks the WiFi private IP on a typical macOS host (skips loopback/VPN/awdl)', () => {
    const ifaces = {
      lo0: [v4('127.0.0.1', true), v6('::1', true)],
      en0: [v4('192.168.1.50'), v6('fe80::1')],
      utun3: [v4('10.99.0.2')], // VPN tunnel -- must be skipped despite private range
      awdl0: [v6('fe80::2')],
    }
    expect(pickLanIp(ifaces)).toBe('192.168.1.50')
  })

  it('picks the eth0 private IP on Linux and skips the docker bridge', () => {
    const ifaces = {
      lo: [v4('127.0.0.1', true)],
      eth0: [v4('10.0.0.5')],
      docker0: [v4('172.17.0.1')], // skipped by name
    }
    expect(pickLanIp(ifaces)).toBe('10.0.0.5')
  })

  it('prefers en0 over en1 when both qualify', () => {
    const ifaces = {
      en1: [v4('192.168.1.99')],
      en0: [v4('192.168.1.50')],
    }
    expect(pickLanIp(ifaces)).toBe('192.168.1.50')
  })

  it('returns null when only loopback exists (localhost-only / no LAN)', () => {
    expect(pickLanIp({ lo0: [v4('127.0.0.1', true)] })).toBeNull()
  })

  it('returns null when the only non-internal IPv4 is public (no private LAN addr)', () => {
    expect(pickLanIp({ en0: [v4('203.0.113.7')] })).toBeNull()
  })

  it('ignores IPv6 and internal addresses', () => {
    const ifaces = {
      en0: [v6('2001:db8::1'), v4('192.168.0.10')],
      lo0: [v4('127.0.0.1', true)],
    }
    expect(pickLanIp(ifaces)).toBe('192.168.0.10')
  })

  // Forward-compat branch: Node 20 emits `family: 'IPv4'` (string) but
  // older toolchains / future renumbering may emit the numeric 4. pickLanIp
  // accepts both so dashboard link generation does not silently regress.
  it('treats a numeric family of 4 as IPv4 (forward-compat branch)', () => {
    const ifaces = {
      en0: [{ address: '192.168.1.50', family: 4 as unknown as 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null }],
      lo0: [v4('127.0.0.1', true)],
    }
    expect(pickLanIp(ifaces)).toBe('192.168.1.50')
  })

  // Skip-when-no-addrs branch: a present-but-empty addrs array is treated
  // as nothing-to-consider rather than throwing. The `if (!addrs)` guard
  // on line 35 of network-info.ts.
  it('skips interface entries whose addrs array is undefined', () => {
    const ifaces = {
      en0: undefined as unknown as ReturnType<typeof v4>[],
      en1: [v4('192.168.1.99')],
    }
    expect(pickLanIp(ifaces)).toBe('192.168.1.99')
  })

  // rank() fallback branch (line 29): an interface name outside the
  // PREFERRED list still produces a candidate with rank=99, so it ranks
  // below every PREFERRED entry. bond0 / eth99 are realistic Linux names
  // that do not match PREFERRED or SKIP_IFACE.
  it('ranks non-preferred interface names at 99 (rank() i === -1 branch)', () => {
    const ifaces = {
      lo0: [v4('127.0.0.1', true)],
      en0: [v4('192.168.1.50')], // PREFERRED rank 0
      bond0: [v4('192.168.1.70')], // non-preferred -> rank 99
    }
    expect(pickLanIp(ifaces)).toBe('192.168.1.50')
  })
})

describe('detectLanIp', () => {
  // Line 51: detectLanIp is a thin wrapper that pipes os.networkInterfaces()
  // into pickLanIp. The branch it adds beyond pickLanIp itself is "did the
  // host expose any interfaces at all?" -- exercised below.
  it('returns the best private IPv4 from os.networkInterfaces() (WiFi)', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo0: [v4('127.0.0.1', true)],
      en0: [v4('192.168.1.50'), v6('fe80::1')],
      utun3: [v4('10.99.0.2')], // tunnel -- must be skipped by name
    })
    expect(detectLanIp()).toBe('192.168.1.50')
  })

  it('returns null when os.networkInterfaces() exposes no private IPv4', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo0: [v4('127.0.0.1', true)],
      en0: [v4('203.0.113.7')], // TEST-NET-3, public
    })
    expect(detectLanIp()).toBeNull()
  })

  it('returns null when os.networkInterfaces() returns an empty object', () => {
    mockNetworkInterfaces.mockReturnValue({})
    expect(detectLanIp()).toBeNull()
  })

  it('prefers en0 over en1 via pickLanIp ranking', () => {
    mockNetworkInterfaces.mockReturnValue({
      en1: [v4('192.168.1.99')],
      en0: [v4('192.168.1.50')],
    })
    expect(detectLanIp()).toBe('192.168.1.50')
  })
})
