import { describe, it, expect, afterEach, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import {
  hashPassword,
  verifyPassword,
  assertPasswordPolicy,
  PasswordPolicyError,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from '../web/password-hash.js'

// The "Bun" runtime surface is consulted at verifyPassword call time, NOT at
// module load. To exercise the argon2-via-Bun branch without a real Bun
// runtime we monkey-patch globalThis.Bun per test and restore it in afterEach.
type BunLike = {
  password?: { verify?: (pw: string, hash: string) => Promise<boolean> }
}
const ORIGINAL_BUN = (globalThis as { Bun?: BunLike }).Bun
afterEach(() => {
  if (ORIGINAL_BUN === undefined) delete (globalThis as { Bun?: BunLike }).Bun
  else (globalThis as { Bun?: BunLike }).Bun = ORIGINAL_BUN
})

describe('hashPassword / verifyPassword', () => {
  it('produces a PHC scrypt string and round-trips', async () => {
    const phc = await hashPassword('correct horse battery')
    expect(phc).toMatch(/^\$scrypt\$ln=16,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(await verifyPassword('correct horse battery', phc)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const phc = await hashPassword('correct horse battery')
    expect(await verifyPassword('Correct horse battery', phc)).toBe(false)
    expect(await verifyPassword('', phc)).toBe(false)
  })

  it('uses a unique salt per hash (no deterministic output)', async () => {
    const a = await hashPassword('same-password-here')
    const b = await hashPassword('same-password-here')
    expect(a).not.toBe(b)
    expect(await verifyPassword('same-password-here', a)).toBe(true)
    expect(await verifyPassword('same-password-here', b)).toBe(true)
  })

  it('verifies against the STORED params, not the current defaults', async () => {
    // A hash minted with a different (valid) work factor must still verify: the
    // verifier must read ln/r/p from the PHC string. Hand-craft a low-cost hash.
    const { scryptSync } = await import('node:crypto')
    const salt = Buffer.from('0123456789abcdef')
    const key = scryptSync('legacy-pass-01', salt, 32, { N: 2 ** 14, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
    const phc = `$scrypt$ln=14,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`
    expect(await verifyPassword('legacy-pass-01', phc)).toBe(true)
    expect(await verifyPassword('nope', phc)).toBe(false)
  })

  it('returns false (no throw) for malformed or unknown-prefix hashes', async () => {
    expect(await verifyPassword('x', '')).toBe(false)
    expect(await verifyPassword('x', 'not-a-phc')).toBe(false)
    expect(await verifyPassword('x', '$scrypt$ln=16$onlytwo')).toBe(false)
    expect(await verifyPassword('x', '$scrypt$ln=16,r=8,p=1$@@@$@@@')).toBe(false)
    // argon2 prefix under node (no Bun) -> false, no throw
    expect(await verifyPassword('x', '$argon2id$v=19$m=65536,t=2,p=1$abc$def')).toBe(false)
  })

  it('rejects out-of-range ln params (guards against OOM/hang)', async () => {
    expect(await verifyPassword('x', '$scrypt$ln=99,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
    // ln=0 fails the positive-integer guard inside parseScryptParams.
    expect(await verifyPassword('x', '$scrypt$ln=0,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
  })

  it('rejects an unknown key inside the params segment', async () => {
    // The 'foo=' arm in parseScryptParams is the only path that returns null
    // *after* a valid integer is seen; without this case the third-branch
    // coverage on line 81 stays uncovered.
    expect(await verifyPassword('x', '$scrypt$foo=16,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
    // Trailing unknown key on a 4-tuple.
    expect(await verifyPassword('x', '$scrypt$ln=16,r=8,p=1,zz=1$c2FsdA==$a2V5')).toBe(false)
  })

  it('rejects a missing required key inside the params segment', async () => {
    // parseScryptParams requires ln, r and p; omitting one yields null.
    expect(await verifyPassword('x', '$scrypt$ln=16,r=8$c2FsdA==$a2V5')).toBe(false)
    expect(await verifyPassword('x', '$scrypt$ln=16,p=1$c2FsdA==$a2V5')).toBe(false)
    expect(await verifyPassword('x', '$scrypt$r=8,p=1$c2FsdA==$a2V5')).toBe(false)
    // Non-integer value is rejected by the integer guard.
    expect(await verifyPassword('x', '$scrypt$ln=abc,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
    expect(await verifyPassword('x', '$scrypt$ln=1.5,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
    expect(await verifyPassword('x', '$scrypt$ln=-1,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
  })

  it('rejects a 5-part hash whose algorithm segment is not "scrypt"', async () => {
    // The `parts.length !== 5 || parts[1] !== 'scrypt'` guard on line 92 has
    // two halves; only the length-half was exercised by the existing suite.
    expect(await verifyPassword('x', '$other$ln=16,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
    // Six-part hash (length guard) and the 5-part with a stray trailing $.
    expect(await verifyPassword('x', '$scrypt$ln=16$extra$abc$def$ghi')).toBe(false)
  })

  it('returns false (no throw) when scrypt itself rejects the stored params', async () => {
    // ln=17 still satisfies parseScryptParams (ln in [1,20]) but requires
    // maxmem > 128 MiB; node's scrypt then throws and the catch on line 110
    // converts that to a clean `false`.
    expect(await verifyPassword('x', '$scrypt$ln=17,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
    expect(await verifyPassword('x', '$scrypt$ln=20,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
  })

  it('rejects non-string inputs without throwing', async () => {
    // verifyPassword's first guard: typeof checks on pw and phc.
    expect(await verifyPassword(undefined as unknown as string, '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
    expect(await verifyPassword(null as unknown as string, '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
    expect(await verifyPassword('x', undefined as unknown as string)).toBe(false)
    expect(await verifyPassword('x', null as unknown as string)).toBe(false)
  })

  it('routes argon2 hashes through Bun.password.verify when Bun is present', async () => {
    const verify = vi.fn(async (_pw: string, hash: string) => hash === '$argon2id$good')
    ;(globalThis as { Bun?: BunLike }).Bun = { password: { verify } }
    // Success path: Bun returns true.
    expect(await verifyPassword('any-pw-here', '$argon2id$good')).toBe(true)
    expect(verify).toHaveBeenCalledWith('any-pw-here', '$argon2id$good')
    // False path: Bun returns false (still under the try, so the catch is not taken).
    expect(await verifyPassword('any-pw-here', '$argon2id$bad')).toBe(false)
    // Throwing path: the try/catch on lines 126-129 converts the throw to false.
    verify.mockRejectedValueOnce(new Error('boom'))
    expect(await verifyPassword('any-pw-here', '$argon2id$throws')).toBe(false)
  })

  it('routes argon2 hashes through Bun.password.verify when only the function is set', async () => {
    // Optional-chaining guard: password is the object, verify is undefined -> false.
    ;(globalThis as { Bun?: BunLike }).Bun = { password: {} }
    expect(await verifyPassword('any-pw-here', '$argon2id$v=19$m=65536,t=2,p=1$abc$def')).toBe(false)
  })

  it('swallows a synchronous throw from Buffer.from inside the base64 try', async () => {
    // The catch on lines 100-102 is a defensive fallback -- in practice
    // `Buffer.from(string, 'base64')` never throws on a string input. To pin
    // the catch branch we briefly wrap Buffer.from so the first base64 call
    // throws; the verifier must convert the throw into a clean `false`.
    const spy = vi.spyOn(Buffer, 'from').mockImplementationOnce(() => {
      throw new TypeError('forced: simulated Buffer.from failure')
    })
    try {
      expect(
        await verifyPassword('x', '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5'),
      ).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('returns false when scrypt produces a derived key whose length differs from the stored key', async () => {
    // Line 112 (`if (derived.length !== expected.length) return false`) is
    // unreachable in production: scrypt always returns a buffer of exactly
    // the requested keylen, and `expected.length` IS the keylen used. To pin
    // the guard we re-import the module with a fake scrypt that returns a
    // wrong-length buffer; the verifier must NOT call timingSafeEqual with
    // mismatched buffers and must surface a clean `false`.
    const realMod = await import('../web/password-hash.js')
    const phc = await realMod.hashPassword('correct horse battery')
    vi.doMock('node:crypto', async () => {
      const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
      return {
        ...actual,
        default: actual,
        scrypt: ((
          _pw: unknown,
          _salt: unknown,
          keylen: number,
          _opts: unknown,
          cb: (err: Error | null, out: Buffer) => void,
        ) => {
          cb(null, Buffer.alloc(keylen + 1))
        }) as typeof actual.scrypt,
      }
    })
    vi.resetModules()
    try {
      const mocked = await import('../web/password-hash.js')
      expect(await mocked.verifyPassword('correct horse battery', phc)).toBe(false)
    } finally {
      vi.doUnmock('node:crypto')
      vi.resetModules()
    }
  })
})

describe('assertPasswordPolicy', () => {
  it('accepts a length within bounds', () => {
    expect(() => assertPasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow()
    expect(() => assertPasswordPolicy('x'.repeat(MAX_PASSWORD_LENGTH))).not.toThrow()
  })
  it('rejects too-short and too-long passwords', () => {
    expect(() => assertPasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(PasswordPolicyError)
    expect(() => assertPasswordPolicy('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(PasswordPolicyError)
  })
  it('rejects a non-string', () => {
    expect(() => assertPasswordPolicy(undefined as unknown)).toThrow(PasswordPolicyError)
    expect(() => assertPasswordPolicy(null as unknown)).toThrow(PasswordPolicyError)
    expect(() => assertPasswordPolicy(42 as unknown)).toThrow(PasswordPolicyError)
    expect(() => assertPasswordPolicy({} as unknown)).toThrow(PasswordPolicyError)
  })
  it('hashPassword enforces the policy', async () => {
    await expect(hashPassword('short')).rejects.toBeInstanceOf(PasswordPolicyError)
    await expect(hashPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toBeInstanceOf(PasswordPolicyError)
    await expect(hashPassword(undefined as unknown as string)).rejects.toBeInstanceOf(PasswordPolicyError)
  })
})
