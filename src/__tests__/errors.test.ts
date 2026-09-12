import { describe, it, expect } from 'vitest'
import { AppError } from '../errors.js'
import { RequestBodyTooLargeError } from '../web/http-helpers.js'
import { PeerResponseTooLargeError } from '../web/federation/http.js'
import { DeferToPeerError } from '../process-lock.js'
import { RemoteEnrollError } from '../remote-enroll-core.js'
import { TelegramApiError } from '../channel-coordinator/telegram-client.js'
import { KeychainUnavailableError } from '../web/keychain.js'
import { PasswordPolicyError } from '../web/password-hash.js'
import { UserFacingError } from '../web/fleet-transfer.js'
import { FederationPollInternalError } from '../web/federation/poller.js'

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

  // (4) Chain node: subclass IS-A AppError (backward-compat invariant).
  it('both subclasses are instanceof AppError', () => {
    const a = new RequestBodyTooLargeError(1024)
    const b = new PeerResponseTooLargeError(8192)
    expect(a).toBeInstanceOf(AppError)
    expect(b).toBeInstanceOf(AppError)
  })

  // (5) Backward-compat regression pin: instanceof<X> + instanceof<Error>
  //     stay true. Negative: subclasses do NOT spuriously match each other.
  it('concrete subclass discriminators stay correct', () => {
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
  //     Symmetric with RequestBodyTooLargeError.limit.
  it('PeerResponseTooLargeError persists the limit field', () => {
    const e = new PeerResponseTooLargeError(4096)
    expect(e.limit).toBe(4096)
  })

  // (7) Existing limit field on RequestBodyTooLargeError still works.
  it('RequestBodyTooLargeError.limit still persists the limit', () => {
    const e = new RequestBodyTooLargeError(2048)
    expect(e.limit).toBe(2048)
  })

  // (8) Cause descriptor: super(message, { cause }) yields a non-enumerable
  //     `cause` property (pino serialiser + JSON.stringify invariant -- the
  //     cause must NOT appear in the object's own enumerable keys).
  it('cause via ErrorOptions is non-enumerable', () => {
    const root = new Error('root')
    const e = new _ConcreteAppError('msg', { cause: root })
    expect(e.cause).toBe(root)
    expect(Object.keys(e)).not.toContain('cause')
    const descriptor = Object.getOwnPropertyDescriptor(e, 'cause')
    expect(descriptor?.enumerable).toBe(false)
  })

  // (9) DeferToPeerError
  it('DeferToPeerError extends AppError and sets name via new.target.name', () => {
    const e = new DeferToPeerError(4242)
    expect(e).toBeInstanceOf(DeferToPeerError)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('DeferToPeerError')
    expect(e.message).toBe('Pidfile held by legitimate peer PID 4242')
    expect(e.peerPid).toBe(4242)
  })

  // (10) DeferToPeerError.peerPid survives the throw (parallel to .limit tests above)
  it('DeferToPeerError.peerPid is preserved as 777 through the throw', () => {
    const e = new DeferToPeerError(777)
    expect(e.peerPid).toBe(777)
  })

  // (11) RemoteEnrollError
  it('RemoteEnrollError extends AppError, name + message are set', () => {
    const e = new RemoteEnrollError('key type must be exactly ssh-ed25519')
    expect(e).toBeInstanceOf(RemoteEnrollError)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('RemoteEnrollError')
    expect(e.message).toBe('key type must be exactly ssh-ed25519')
  })

  // (12) TelegramApiError: kind discriminator preserved
  it('TelegramApiError rate_limit carries kind + retryAfterSec', () => {
    const e = new TelegramApiError('rate_limit', '429 too many requests: retry', 30)
    expect(e).toBeInstanceOf(TelegramApiError)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('TelegramApiError')
    expect(e.kind).toBe('rate_limit')
    expect(e.retryAfterSec).toBe(30)
  })

  // (13) TelegramApiError: retryAfterSec is optional. The class-field
  // defineProperty of `public readonly retryAfterSec?: number` creates an own
  // property with value undefined (the parameter property still runs even when
  // the positional arg is omitted), so the assertion checks the VALUE rather
  // than the property's presence.
  it('TelegramApiError transient has retryAfterSec === undefined when omitted', () => {
    const e = new TelegramApiError('transient', 'network error: connect ECONNREFUSED')
    expect(e).toBeInstanceOf(TelegramApiError)
    expect(e.kind).toBe('transient')
    expect(e.retryAfterSec).toBeUndefined()
  })

  // (14) KeychainUnavailableError
  it('KeychainUnavailableError extends AppError with default message', () => {
    const e = new KeychainUnavailableError('keychain add-generic-password failed (status 36): please unlock')
    expect(e).toBeInstanceOf(KeychainUnavailableError)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('KeychainUnavailableError')
    expect(e.message).toBe('keychain add-generic-password failed (status 36): please unlock')
  })

  // (15) PasswordPolicyError
  it('PasswordPolicyError extends AppError, message preserved', () => {
    const e = new PasswordPolicyError('Password must be at least 10 characters')
    expect(e).toBeInstanceOf(PasswordPolicyError)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('PasswordPolicyError')
    expect(e.message).toBe('Password must be at least 10 characters')
  })

  // (16) UserFacingError
  it('UserFacingError extends AppError, name + message preserved', () => {
    const e = new UserFacingError('Titkosítatlan secret az .mcp.json-ban')
    expect(e).toBeInstanceOf(UserFacingError)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('UserFacingError')
    expect(e.message).toBe('Titkosítatlan secret az .mcp.json-ban')
  })

  // (17) FederationPollInternalError: peerId field + cause via ErrorOptions.
  // The constructor does NOT use a `public readonly cause` parameter property
  // (it would emit a class-field defineProperty that overrides ErrorOptions to
  // enumerable:true under useDefineForClassFields semantics), so cause stays
  // non-enumerable per the pino/JSON.stringify invariant that test (8) pins
  // for `_ConcreteAppError`. Both classes now share the same invariant.
  it('FederationPollInternalError carries peerId + cause (non-enumerable), is instanceof AppError', () => {
    const root = new Error('upstream')
    const e = new FederationPollInternalError('teodor', root)
    expect(e).toBeInstanceOf(FederationPollInternalError)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('FederationPollInternalError')
    expect(e.peerId).toBe('teodor')
    expect(e.cause).toBe(root)
    expect(Object.keys(e)).not.toContain('cause')
    expect(Object.getOwnPropertyDescriptor(e, 'cause')?.enumerable).toBe(false)
  })

  // (18) Negative discrimination: subclasses don't collide
  it('error subclass discriminators stay mutually exclusive', () => {
    const d = new DeferToPeerError(1)
    const r = new RemoteEnrollError('x')
    const t = new TelegramApiError('fatal', '401 unauthorized')
    const k = new KeychainUnavailableError('x')
    const p = new PasswordPolicyError('x')
    const u = new UserFacingError('x')
    const f = new FederationPollInternalError('p', new Error('x'))
    for (const e of [d, r, t, k, p, u, f]) {
      expect(e).toBeInstanceOf(Error)
      expect(e).toBeInstanceOf(AppError)
    }
    expect(d).not.toBeInstanceOf(RemoteEnrollError)
    expect(t).not.toBeInstanceOf(UserFacingError)
    expect(u).not.toBeInstanceOf(PasswordPolicyError)
  })
})
