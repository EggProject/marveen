# Classbase refactor — abandoned

The planning documents under `docs/refactor-to-classbase/` are being deleted
by the project owner. They are NOT a stable reference; future sessions must
not propose new class-extract work on the classbase track without explicit
user approval.

## Status of the classbase track items

| Item | Risk | Status |
|---|---|---|
| H.1 LoggerLike | Low | LANDED |
| H.3 LazyBin | Low | LANDED |
| H.4 AppError | Low-Medium | LANDED |
| H.2b logger roll-out | Medium | OPEN — do NOT pick up without explicit user approval |
| H.5 singleton removal | High, irreversible | OPEN — do NOT pick up without explicit user approval |

## Stable class forms (do not modify without careful review)

- `src/errors.ts`: abstract `AppError` base class. Adding new error subclasses
  should extend AppError; do not modify the abstract guard or the
  `new.target.name` plumbing.
- `src/platform.ts`: `LazyBin<TName, TResolved>` class with `makeLazyBinResolver`
  factory. The `resolve(): string` signature throws on missing binaries.
- `src/logger.ts`: `LoggerLike` interface. Used as a DI seam for constructor
  injection across the codebase.

## Why this entry exists

The classbase refactor ran its course and shipped successfully (H.1, H.3,
H.4). The remaining items (H.2b, H.5) are NOT free follow-ups — they are
intentional non-goals for now. Future sessions proposing work on the
classbase track will burn cycles on a deferred backlog unless they check
this entry first.
