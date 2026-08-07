// Extra branches for src/remote-enroll-core.ts.
//
// The existing remote-enroll-core.test.ts already covers every public path,
// but two defensive branches slipped past:
//
//   * validateEd25519Blob at line 76: the `off + typeLen > buf.length` arm
//     (the check fires when the typeLen field equals ssh-ed25519's length
//     but the buffer is shorter than 4 + 11 bytes for it).
//   * validatePublicKeyLine at line 105: the `typeof rawLine !== 'string'`
//     guard. The function is supposed to take a string, but the runtime
//     guard exists for callers that pass undefined/null/numbers (it would
//     otherwise throw a confusing TypeError on `.trim()`).
//
// This file contains ONLY the missing-branch tests. The existing core tests
// already pin the happy-path and main error paths.

import { describe, it, expect } from 'vitest'
import {
  validatePublicKeyLine,
  removeAuthorizedKey,
  mergeAuthorizedKeys,
  parseHostKeyPub,
  parseKeyscanEd25519,
  RemoteEnrollError,
} from '../remote-enroll-core.js'

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

describe('validateEd25519Blob: typeLen within bounds but buffer too short', () => {
  // OFF + TYPELEN > BUF.LENGTH arm at line 76. The first check (`typeLen !==
  // ACCEPTED_KEY_TYPE.length`) is false: typeLen is exactly 11 (= the
  // 'ssh-ed25519' string length). But the buffer is only 6 bytes total -- so
  // when the offset lands at 4 and typeLen is 11, the read would run past
  // the end. The check at line 76 catches that and throws the
  // 'unexpected type field' error.
  it('declares the "unexpected type field" error when the type LENGTH fits but the buffer is truncated', () => {
    // [u32(11)] + 2 bytes (not 11). Total = 6 bytes.
    const buf = Buffer.concat([u32(11), Buffer.from('ss')])
    const base64 = buf.toString('base64')
    expect(() => validatePublicKeyLine(`ssh-ed25519 ${base64} marveen-remote:3f2504e0-4f89-41d3-9a0c-0305e82c3301`)).toThrow(RemoteEnrollError)
    expect(() => validatePublicKeyLine(`ssh-ed25519 ${base64} marveen-remote:3f2504e0-4f89-41d3-9a0c-0305e82c3301`)).toThrow(/unexpected type field/)
  })
})

describe('validatePublicKeyLine: non-string input', () => {
  // The runtime guard at line 106 must reject undefined / null / numbers /
  // objects with a clean RemoteEnrollError ("public key line is required")
  // rather than letting `.trim()` throw a TypeError.
  it('rejects undefined', () => {
    // Cast: the function signature is `(rawLine: string)` but the guard
    // exists precisely for unsafe callers. We simulate the unsafe call.
    expect(() => validatePublicKeyLine(undefined as unknown as string)).toThrow(RemoteEnrollError)
    expect(() => validatePublicKeyLine(undefined as unknown as string)).toThrow(/required/)
  })

  it('rejects null', () => {
    expect(() => validatePublicKeyLine(null as unknown as string)).toThrow(/required/)
  })

  it('rejects a number', () => {
    expect(() => validatePublicKeyLine(42 as unknown as string)).toThrow(/required/)
  })

  it('rejects an object', () => {
    expect(() => validatePublicKeyLine({} as unknown as string)).toThrow(/required/)
  })
})

// ---------------------------------------------------------------------------
// removeAuthorizedKey -- lines 222-233. The existing test file doesn't
// import this function, so coverage here was 0. These tests pin the
// documented behaviour and reach every branch in the function.
// ---------------------------------------------------------------------------

describe('removeAuthorizedKey', () => {
  const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  const OTHER = '11111111-2222-4333-8444-555555555555'
  const ownLine = `restrict ssh-ed25519 OWN marveen-remote:${UUID}`
  const otherLine = `restrict ssh-ed25519 OTHER marveen-remote:${OTHER}`

  it('returns removed:false on empty content without allocating a trailing newline', () => {
    const r = removeAuthorizedKey('', UUID)
    expect(r).toEqual({ content: '', removed: false })
  })

  it('returns removed:false when the install id is not present', () => {
    const existing = `${otherLine}\n`
    const r = removeAuthorizedKey(existing, UUID)
    expect(r.removed).toBe(false)
    expect(r.content).toBe(existing) // preserving other lines byte-for-byte
  })

  it('removes the matching line and preserves the rest', () => {
    const existing = [`ssh-rsa AAAA someone@host`, ownLine, otherLine].join('\n') + '\n'
    const r = removeAuthorizedKey(existing, UUID)
    expect(r.removed).toBe(true)
    expect(r.content).toBe(`ssh-rsa AAAA someone@host\n${otherLine}\n`)
    expect(r.content).not.toContain('OWN')
  })

  it('handles content without a trailing newline', () => {
    const existing = `${ownLine}`
    const r = removeAuthorizedKey(existing, UUID)
    expect(r.removed).toBe(true)
    expect(r.content).toBe('')
  })

  it('handles a trailing empty line (drops the spurious blank before filtering)', () => {
    // existing ends in '\n' which adds a trailing '' after split. The
    // function must drop that before filtering so it does not match the
    // target and get falsely considered a removal.
    const existing = `${ownLine}\n`
    const r = removeAuthorizedKey(existing, UUID)
    expect(r.removed).toBe(true)
    expect(r.content).toBe('')
  })

  it('detects a removal via the dropped trailing empty line guard (defensive branch)', () => {
    // Two lines, the first is the target to remove, the second is unrelated.
    // No trailing newline. After the trailing-empties guard the lines stay
    // as-is; the filter drops the target, which makes `removed` true.
    const existing = `${ownLine}\n${otherLine}`
    const r = removeAuthorizedKey(existing, UUID)
    expect(r.removed).toBe(true)
    expect(r.content).toBe(`${otherLine}\n`)
  })

  it('does not invent a trailing newline when the result is empty', () => {
    const existing = `${ownLine}\n`
    const r = removeAuthorizedKey(existing, UUID)
    expect(r.content).toBe('') // pinned: empty result stays empty
  })
})

// ---------------------------------------------------------------------------
// validateEd25519Blob: tiny-buffer error paths (lines 73, 86)
//
// The existing core tests build a 51-byte blob; the two early-exit guards
// (buf.length < 4 and off + 4 > buf.length) only fire when the buffer is
// shorter than expected. Each is a separate RemoteEnrollError message and
// both must be exercised.
// ---------------------------------------------------------------------------

describe('validateEd25519Blob: tiny buffer guards', () => {
  const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  it('throws "key blob is too short" when the decoded buffer is < 4 bytes', () => {
    // 3 bytes -> buf.length < 4 -> line 73.
    const buf = Buffer.from([0x00, 0x00, 0x00])
    const base64 = buf.toString('base64')
    expect(() =>
      validatePublicKeyLine(`ssh-ed25519 ${base64} marveen-remote:${UUID}`),
    ).toThrow(RemoteEnrollError)
    expect(() =>
      validatePublicKeyLine(`ssh-ed25519 ${base64} marveen-remote:${UUID}`),
    ).toThrow(/key blob is too short/)
  })

  it('throws "key blob is truncated" when the type field fits but the keyLen uint32 is missing', () => {
    // u32(11) + 11 bytes of "ssh-ed25519" -> 15 bytes total. After off = 15,
    // `15 + 4 > 15` is true -> line 86 throws.
    const type = Buffer.from('ssh-ed25519', 'utf8')
    const buf = Buffer.concat([u32(type.length), type])
    const base64 = buf.toString('base64')
    expect(() =>
      validatePublicKeyLine(`ssh-ed25519 ${base64} marveen-remote:${UUID}`),
    ).toThrow(/key blob is truncated/)
  })
})

// ---------------------------------------------------------------------------
// mergeAuthorizedKeys: trailing newline guard (line 206)
//
// The existing tests add a trailing newline manually. The guard fires when
// the joined result does NOT end with '\n', then appends one. To exercise
// this branch without a trailing newline we need both the trailing-empties
// pop AND an existing string that lacks a trailing newline to actually run
// the endsWith check with a falsy value.
// ---------------------------------------------------------------------------

describe('mergeAuthorizedKeys: trailing-newline guard', () => {
  const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  const restricted = `restrict ssh-ed25519 KEY marveen-remote:${UUID}`

  it('appends a trailing newline when the merged result does not end with one', () => {
    // Start from a single line that lacks a trailing newline. After the
    // trailing-empties pop, the lines array becomes ['line']. The filter
    // pass keeps it. out.push() adds the restricted line. After join(\n)
    // we have 'line\nrestricted' which does NOT end with '\n' -- so the
    // guard at line 206 fires and appends '\n'.
    const existing = 'ssh-rsa AAAA a@h' // no trailing newline
    const { content } = mergeAuthorizedKeys(existing, restricted, UUID)
    expect(content.endsWith('\n')).toBe(true)
    // The guard adds exactly one newline, not two.
    expect(content.endsWith('\n\n')).toBe(false)
  })

  it('skips the trailing-newline append when a leftover empty entry already provides one', () => {
    // existing has TWO trailing newlines, so after the trailing-empties pop
    // (which only pops ONE empty), `lines` still ends with ''. After the
    // matching line is replaced, `out.join('\n')` ends with '\n' (the empty
    // element joins as a trailing separator). The guard at line 206 sees
    // content already ending with '\n' and skips the append -- without this
    // branch the result would have a doubled newline.
    const existing = `ssh-rsa AAAA a@h\n${restricted}\n\n`
    const { content } = mergeAuthorizedKeys(existing, restricted, UUID)
    expect(content.endsWith('\n')).toBe(true)
    expect(content.endsWith('\n\n')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseHostKeyPub: fields.length < 2 branch (line 245)
//
// The existing tests cover the empty input + type-mismatch + non-base64
// branches. The "< 2 fields" guard would only fire on a string with zero
// whitespace -- but the trim+length check already returns null for empty
// input. The path is reachable with a single non-empty token (no spaces).
// ---------------------------------------------------------------------------

describe('parseHostKeyPub: single-field defensive branch', () => {
  it('returns null when the input has fewer than two whitespace fields', () => {
    // No whitespace -> split returns a single element -> fields.length < 2
    // -> line 245 returns null. Pinned here so the guard is covered even
    // though the result is the same as the empty-input path.
    expect(parseHostKeyPub('ssh-ed25519')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseKeyscanEd25519: fields.length < 3 branch (line 275)
//
// The existing tests skip lines whose type is wrong or that are comments.
// The "< 3 fields" guard fires when keyscan output has a host and a type
// but no key body (e.g. an interrupted scan that yielded only "host type").
// ---------------------------------------------------------------------------

describe('parseKeyscanEd25519: < 3 fields branch', () => {
  it('returns null when a keyscan line has fewer than three fields', () => {
    // Host + type with no body -> fields.length < 3 -> line 275 continue.
    expect(parseKeyscanEd25519('127.0.0.1 host-key')).toBeNull()
  })
})
