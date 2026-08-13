# syntax-check-executes-web-bundle

**Filed:** 2026-08-13
**Severity:** medium (a CI gate that has never checked anything and can never pass)
**Status:** open, fix proposed but not applied

## What

`package.json` script:

```
"syntax-check": "bun --check web/app.js web/sw.js"
```

`--check` is **not a Bun flag.** Bun ignores it and treats both paths as entrypoints to *execute*. `web/app.js`
is a browser bundle, so it dies immediately in the server runtime:

```
$ bun run syntax-check
24 |   window._brandTokens = window._brandTokens || { brand: 'Marveen', ... }
       ^
ReferenceError: window is not defined
      at <anonymous> (web/app.js:24:3)
error: script "syntax-check" exited with code 1
```

Confirmed against Bun 1.3.14: `bun --help` lists no `--check` flag.

So the script has two defects at once:

1. It **never performs a syntax check** — nothing parses the files as a gate.
2. It **always exits 1**, so it cannot be used in CI or a pre-commit hook. Any caller that treats it as a gate
   is permanently red for a reason unrelated to syntax.

Introduced in `a61ff74` — *feat(ci): frontend smoke-test + syntax-gate (#423)* — i.e. it was added specifically
as a CI gate and has been non-functional since.

## Impact

`.github/workflows/ci.yml` deliberately does **not** call it (there is a comment at the omission point). If it
were wired in, the `lint` job would report a failure that says nothing about the code.

## Fix

Node has a real syntax-only check that parses without executing:

```
"syntax-check": "node --check web/app.js && node --check web/sw.js"
```

Verified working: both files report clean parses. Note `node --check` takes **one file per invocation** —
passing two paths silently checks only the first, which is its own trap.

Bun-native alternatives, if staying on Bun matters more than the one-liner:

- `bun build --target=browser web/app.js --outfile=/dev/null` — parses and bundles, no execution. Heavier, and
  it resolves imports (a behaviour change if the files ever gain any).
- Add the two files to ESLint instead of a separate script. They are currently inside the `web/**` global ignore
  because the bundle is generated and ~732KB; linting it would be slow and noisy. A dedicated parse gate is the
  cheaper answer.

Recommended: the `node --check` two-invocation form, then wire the step back into the `lint` job in
`.github/workflows/ci.yml`.

## Pinning test

No unit test exists for package.json script behaviour. When fixing, add a check that asserts the script exits 0
on the current `web/app.js` and `web/sw.js`, and non-zero on a file with a deliberate syntax error — otherwise
the same class of silent no-op gate can return.

## Reproduce

```
bun run syntax-check          # exits 1, ReferenceError: window is not defined
bun --help | grep -- --check  # no such flag
node --check web/app.js       # exits 0, the check that actually works
```
