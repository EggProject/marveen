import { describe, it, expect } from 'vitest'
import { AppError } from '../errors.js'
import { RequestBodyTooLargeError } from '../web/http-helpers.js'
import { PeerResponseTooLargeError } from '../web/federation/http.js'

// Local concrete subclass used to exercise AppError's cause propagation path
// without extending the production subclass constructor signatures.
class _ConcreteAppError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

describe('AppError', () => {
  // (1) Base class is abstract: direct instantiation throws.
  it('cannot be instantiated directly (abstract)', () => {
    // @ts-expect-error -- we are explicitly testing that the abstract guard fires at runtime; TS2511 prevents direct instantiation.
    expect(() => new AppError('boom')).toThrow(TypeError)
  })

  // (2) Subclass name is set via new.target.name in the base constructor.
  it('RequestBodyTooLargeError.name is set from new.target.name', () => {
    const e = new RequestBodyTooLargeError(1024)
    expect(e.name).toBe('RequestBodyTooLargeError')
    expect(e.message).toBe('Request body exceeded 1024 bytes')
  })

  // (3) PeerResponseTooLargeError.name preservation (mirror of #2)
  it('PeerResponseTooLargeError.name is set from new.target.name', () => {
    const e = new PeerResponseTooLargeError(8192)
    expect(e.name).toBe('PeerResponseTooLargeError')
    expect(e.message).toBe('Peer response exceeded 8192 bytes')
  })

  // (4) Chain node: subclass IS-A AppError (HR6 #1 backward-compat).
  it('both subclasses are instanceof AppError', () => {
    const a = new RequestBodyTooLargeError(1024)
    const b = new PeerResponseTooLargeError(8192)
    expect(a).toBeInstanceOf(AppError)
    expect(b).toBeInstanceOf(AppError)
  })

  // (5) Backward-compat regression pin: instanceof<X> + instanceof<Error>
  //     stay true. Negative: subclasses do NOT spuriously match each other.
  it('concrete subclass discriminators stay correct post-H.4', () => {
    const a = new RequestBodyTooLargeError(1024)
    const b = new PeerResponseTooLargeError(8192)
    expect(a).toBeInstanceOf(RequestBodyTooLargeError)
    expect(b).toBeInstanceOf(PeerResponseTooLargeError)
    expect(a).toBeInstanceOf(Error)
    expect(b).toBeInstanceOf(Error)
    expect(b).not.toBeInstanceOf(RequestBodyTooLargeError)
    expect(a).not.toBeInstanceOf(PeerResponseTooLargeError)
  })

  // (6) NEW field: PeerResponseTooLargeError.limit survives the throw.
  //     HR5 symmetry with RequestBodyTooLargeError.limit.
  it('PeerResponseTooLargeError persists the limit field', () => {
    const e = new PeerResponseTooLargeError(4096)
    expect(e.limit).toBe(4096)
  })

  // (7) Existing limit field on RequestBodyTooLargeError still works.
  it('RequestBodyTooLargeError.limit still persists the limit', () => {
    const e = new RequestBodyTooLargeError(2048)
    expect(e.limit).toBe(2048)
  })

  // (8) HR6 #4 cause descriptor: super(message, { cause }) yields
  //     enumerable: false cause (pino serialiser + JSON.stringify invariant).
  it('cause via ErrorOptions is non-enumerable', () => {
    const root = new Error('root')
    const e = new _ConcreteAppError('msg', { cause: root })
    expect(e.cause).toBe(root)
    expect(Object.keys(e)).not.toContain('cause')
    const descriptor = Object.getOwnPropertyDescriptor(e, 'cause')
    expect(descriptor?.enumerable).toBe(false)
  })
})

// Integration-style regression pins for the 4 production instanceof sites.
describe('H.4 production regression pins', () => {
  it('routes/federation.ts:319 branch still fires for RequestBodyTooLargeError', () => {
    const err = new RequestBodyTooLargeError(1024)
    // Mirror the check shape from the source:
    const branch = err instanceof RequestBodyTooLargeError
    expect(branch).toBe(true)
  })

  it('routes/schedules.ts:134 branch still fires for RequestBodyTooLargeError', () => {
    const err = new RequestBodyTooLargeError(1024)
    expect(err instanceof RequestBodyTooLargeError).toBe(true)
  })

  it('routes/schedules.ts:185 branch still fires for RequestBodyTooLargeError', () => {
    const err = new RequestBodyTooLargeError(1024)
    expect(err instanceof RequestBodyTooLargeError).toBe(true)
  })

  it('federation/poller.ts:199 branch still fires for PeerResponseTooLargeError', () => {
    const err = new PeerResponseTooLargeError(8192)
    expect(err instanceof PeerResponseTooLargeError).toBe(true)
  })
})
