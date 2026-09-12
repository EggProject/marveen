// Base class for project-defined errors.
//
// Convention: any new error class in src/ should extend AppError rather than
// Error directly. AppError centralises the post-construction
// `this.name = new.target.name` assignment so individual subclasses no longer
// need to hand-set `this.name`. Existing instanceof<X> answers on concrete
// subclasses stay byte-identical because the new AppError prototype sits
// between the concrete subclass and Error in the prototype chain.
//
// AppError is abstract -- subclasses must extend it; direct `new AppError(...)`
// throws. The runtime guard is required because abstract constructors are
// enforced only at compile time. There is no `code` field, avoiding collisions
// with Node errno names, and no method beyond the constructor. ErrorOptions is
// forwarded to super so `{ cause }` flows through, and assigning
// `this.name = new.target.name` is required so each concrete subclass reports
// its own name instead of inheriting `Error`.
//
// All production error classes extend AppError: MemoryStoreError (db.ts),
// RequestBodyTooLargeError (web/http-helpers.ts), PeerResponseTooLargeError
// (web/federation/http.ts) were the original three; DeferToPeerError,
// RemoteEnrollError, TelegramApiError, KeychainUnavailableError,
// PasswordPolicyError, UserFacingError, FederationPollInternalError
// were migrated in the H.4 cycle. Pre-existing tests' local mock classes
// still extend Error (their own classes, never asserted instanceof AppError).

export abstract class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    if (new.target === AppError) {
      throw new TypeError('AppError is abstract and cannot be instantiated directly; extend it instead.')
    }
    super(message, options)
    this.name = new.target.name
  }
}
