// Base class for project-defined errors (introduced in H.4).
//
// Convention: any new error class in src/ should extend AppError rather than
// Error directly. AppError centralises the post-construction
// `this.name = new.target.name` assignment so individual subclasses no longer
// need to hand-set `this.name`. Existing instanceof<X> answers on concrete
// subclasses stay byte-identical: the new AppError prototype sits between the
// concrete subclass and Error in the prototype chain.
//
// AppError is abstract -- subclasses must extend it; direct `new AppError(...)`
// throws. There is no code field (per 03-class-boundaries.md §C3 -- it would
// collide with Node errno names) and no method beyond the constructor.
//
// Pre-existing subclasses (DeferToPeerError, RemoteEnrollError, TelegramApi-
// Error, KeychainUnavailableError, PasswordPolicyError, UserFacingError,
// FederationPollInternalError) continue to `extends Error` and migrate in
// later, non-H.4 phases.
//
// See docs/refactor-to-classbase/h-cross-cutting/05-refactor-roadmap.md §H.4
// and 06-risks-and-mitigations.md §HR6.

export abstract class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    if (new.target === AppError) {
      throw new TypeError('AppError is abstract and cannot be instantiated directly; extend it instead.')
    }
    super(message, options)
    this.name = new.target.name
  }
}
