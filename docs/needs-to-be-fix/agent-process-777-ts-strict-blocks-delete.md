# agent-process.ts:777 - runTmux timeout required-delete blocked

## Safe-delete attempted

Tighten `runTmux` opts from `{ timeout?: number } = {}` (with `?? (host ? 8000 : 3000)` fallback) to required `{ timeout: number }` and drop the fallback in the body.

## Why ts-strict blocked it

TypeScript flags a new `error TS2554: Expected 3 arguments, but got 2` at line 978:

```
src/web/agent-process.ts(978,7): error TS2554: Expected 3 arguments, but got 2.
```

Caller at line 978 invokes `runTmux` positionally without the `opts` arg:

```ts
runTmux(null, ['kill-session', '-t', session])
```

Other ~20 call sites in the file already pass `{ timeout: 5000 }` (or `10000`) explicitly — see `grep -rn "runTmux(" src/`. Line 978 is the only orphan.

## Fix path (pick one, then re-run the safe-delete)

1. **Add explicit timeout at line 978** — smallest diff, preserves the intent of the other callers (`5000` matches the surrounding `execSync('sleep 3', { timeout: 5000 })` immediately below):
   ```ts
   runTmux(null, ['kill-session', '-t', session], { timeout: 5000 })
   ```
2. **Audit whether kill-session really wants a timeout at all** — local kill-session is ~instant. Could argue for keeping the `opts.timeout` fallback and only tightening the signature for callers that already opt in. In that case the safe-delete premise (make required) doesn't hold; revert and leave the ternary.

## Verification

After applying option 1:

```
bun run typecheck 2>&1 | grep -c "error TS"
```

Must equal the baseline (1703 at HEAD `c2b4ea2`). Then re-apply the safe-delete on line 777.
