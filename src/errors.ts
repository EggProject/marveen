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
// throws. The runtime guard is required because @ts-ignore / `as any` bypass
// the TS2511 compile-time check. ErrorOptions is forwarded to super so
// `{ cause }` flows through, and `this.name = new.target.name` is required
// because the Error base class sets `.name` from the constructor context, not
// from the concrete subclass.
//
// Pre-existing subclasses (DeferToPeerError, RemoteEnrollError, TelegramApi-
// Error, KeychainUnavailableError, PasswordPolicyError, UserFacingError,
// FederationPollInternalError) continue to extend Error directly; the AppError
// base class is not retroactively applied to them.

export abstract class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    if (new.target === AppError) {
      throw new TypeError('AppError is abstract and cannot be instantiated directly; extend it instead.')
    }
    super(message, options)
    this.name = new.target.name
  }
}
