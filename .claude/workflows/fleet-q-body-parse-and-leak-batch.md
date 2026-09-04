// Workflow: fleet-q body-parse + 404-roster-leak batch
// Fixes two needs-to-be-fix items in src/web/routes/fleet-q.ts:
//   A) routes-fleet-q-body-parse-uncaught   (readBody + JSON.parse unguarded)
//   B) routes-fleet-q-404-leaks-roster      (404 message enumerates agents)
// All work stays on test/baseline. No new branch. No push.
export const meta = {
  name: 'fleet-q-body-parse-and-leak-batch',
  description: 'Close routes-fleet-q-body-parse-uncaught + routes-fleet-q-404-leaks-roster on test/baseline',
  phases: [
    { title: 'Verify-baseline' },
    { title: 'Fix' },
    { title: 'Test-invert' },
    { title: 'Docs' },
    { title: 'Verify-final' },
  ],
}

phase('Verify-baseline')

const baseline = await agent(
  [
    'Capture the starting state on test/baseline before any edits:',
    '1. Run `bun --bun vitest run src/__tests__/fleet-q-routes.test.ts` and report pass/fail counts.',
    '2. Run `bun --bun tsc --noEmit 2>&1 | wc -l` and report the error count.',
    '3. Run `git status --short` and report whether working tree is clean.',
    '4. Run `git log -1 --oneline` and report HEAD SHA.',
    '5. Run `git rev-parse --abbrev-ref HEAD` and confirm branch is test/baseline.',
    'Return a JSON object: { vitest_pass, vitest_fail, tsc_count, working_tree_clean, head_sha, branch }',
    'Do NOT modify any files. Read-only verification only.',
  ].join('\n'),
  { label: 'baseline-snapshot', phase: 'Verify-baseline', schema: {
    type: 'object',
    properties: {
      vitest_pass: { type: 'number' },
      vitest_fail: { type: 'number' },
      tsc_count: { type: 'number' },
      working_tree_clean: { type: 'boolean' },
      head_sha: { type: 'string' },
      branch: { type: 'string' },
    },
    required: ['vitest_pass','vitest_fail','tsc_count','working_tree_clean','head_sha','branch'],
  }},
)

if (!baseline.working_tree_clean) {
  throw new Error('Working tree is not clean — abort. Resolve any uncommitted changes first.')
}
if (baseline.branch !== 'test/baseline') {
  throw new Error('Not on test/baseline branch — abort.')
}

phase('Fix')

const fixResult = await agent(
  [
    'You are fixing two bugs in src/web/routes/fleet-q.ts on the current branch (test/baseline).',
    '',
    '## STRICT RULES — VIOLATING ANY OF THESE MEANS YOU FAILED',
    '1. Edit ONLY src/web/routes/fleet-q.ts. Do NOT touch any other file.',
    '2. Do NOT add, remove, rename, or reorder imports. Do NOT change existing types.',
    '3. Do NOT refactor surrounding code. Do NOT rename variables. Do NOT reformat.',
    '4. Do NOT add Array.isArray / typeguard fallbacks anywhere new — the fix is purely a try/catch wrap + one string change.',
    '5. Do NOT touch the GET branch or any other branch of tryHandleFleetQ.',
    '6. Diff invariant you MUST satisfy: `git diff --shortstat` MUST show insertions >= 5 AND deletions >= 2 AND total lines changed <= 25. If your planned edit does not fit, STOP.',
    '',
    '## Fix A — routes-fleet-q-body-parse-uncaught',
    'The PUT handler at lines 27-37 currently does:',
    '```ts',
    'const body = await readBody(req)',
    'const parsed = JSON.parse(body.toString()) as { capabilities?: unknown }',
    'if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.every((c: unknown) => typeof c === \'string\')) {',
    '  json(res, { error: \'capabilities: string[] required\' }, 400)',
    '  return true',
    '}',
    '```',
    'Wrap the readBody and JSON.parse in try/catch, mirroring the tryHandleFleet pattern in src/web/routes/fleet.ts:48-55.',
    'After the JSON.parse try/catch, add a guard: if parsed === null || typeof parsed !== \'object\' || Array.isArray(parsed), return 400 with `{ error: \'capabilities: object body required\' }`.',
    'Use these error strings verbatim:',
    '- readBody catch:   `error: \`Kérés olvasási hiba: ${(err as Error).message}\``',
    '- JSON.parse catch: `error: \'Érvénytelen JSON törzs.\'`',
    '- non-object guard: `error: \'capabilities: object body required\'`',
    '',
    '## Fix B — routes-fleet-q-404-leaks-roster',
    'On line 28, change the literal string `\'Agent nem található\'` to `\'Not found\'` to close the roster-enumeration info leak.',
    '',
    '## Verification you MUST run before declaring done',
    '1. `git diff --shortstat` — confirm insertions >= 5 AND deletions >= 2 AND total <= 25.',
    '2. `git diff src/web/routes/fleet-q.ts` — eyeball the diff, confirm it touches ONLY lines 27-37.',
    '3. `bun --bun tsc --noEmit 2>&1 | wc -l` — confirm the delta vs baseline.tsc_count is <= +5.',
    '4. `bun --bun vitest run src/__tests__/fleet-q-routes.test.ts 2>&1 | tail -20` — the 3 unhandled-rejection tests will FAIL (because the fix prevents rejection). That is EXPECTED — those will be inverted in the next phase. The array + string body tests should still PASS.',
    '',
    '## Return',
    'A JSON object: { diff_shortstat, files_changed, tsc_count_after, vitest_output_tail }',
    'Do NOT commit. Do NOT push. Do NOT edit test files.',
  ].join('\n'),
  { label: 'fix-fleet-q', phase: 'Fix', schema: {
    type: 'object',
    properties: {
      diff_shortstat: { type: 'string' },
      files_changed: { type: 'array', items: { type: 'string' } },
      tsc_count_after: { type: 'number' },
      vitest_output_tail: { type: 'string' },
    },
    required: ['diff_shortstat','files_changed','tsc_count_after','vitest_output_tail'],
  }},
)

// Strict invariant enforcement
const m = fixResult.diff_shortstat.match(/(\d+) insertion.*?(\d+) deletion/)
if (!m) {
  throw new Error('Could not parse diff shortstat: ' + fixResult.diff_shortstat)
}
const insertions = Number(m[1])
const deletions = Number(m[2])
if (insertions < 5) {
  throw new Error('Insertions below safe-edit floor: ' + fixResult.diff_shortstat)
}
if (deletions < 2) {
  throw new Error('Deletions below safe-edit floor: ' + fixResult.diff_shortstat)
}
if (fixResult.files_changed.length !== 1 || !fixResult.files_changed[0].endsWith('src/web/routes/fleet-q.ts')) {
  throw new Error('Files changed is not exactly src/web/routes/fleet-q.ts: ' + JSON.stringify(fixResult.files_changed))
}

phase('Test-invert')

const testResult = await agent(
  [
    'You are inverting 4 pinning assertions in src/__tests__/fleet-q-routes.test.ts on test/baseline.',
    '',
    '## STRICT RULES',
    '1. Edit ONLY src/__tests__/fleet-q-routes.test.ts. Do NOT touch any other file.',
    '2. Do NOT add new tests. Do NOT remove tests. Do NOT refactor. Do NOT reformat.',
    '3. Diff invariant: insertions >= 3, deletions >= 3, total <= 30.',
    '',
    '## Inversion 1 — readBody error',
    'Current test (around line 505): `propagates readBody errors as an unhandled rejection (defect: no try/catch)`.',
    'The body uses `bodyError: new Error(\'socket reset\')`. After the fix, the handler returns 400 with `{ error: \`Kérés olvasási hiba: socket reset\` }`.',
    'Rewrite this test to assert: `handled === true`, `res.statusCode === 400`, `json()` matches the expected error object, AND `H.writeAgentCapabilities` was not called.',
    'Rename the test title to: `returns 400 with Kérés olvasási hiba when readBody rejects`.',
    '',
    '## Inversion 2 — malformed JSON',
    'Current test (around line 516): `throws JSON.parse SyntaxError when the body is malformed (defect: unguarded JSON.parse)`.',
    'Body is `\'{not valid json\'`. After the fix, the handler returns 400 with `{ error: \'Érvénytelen JSON törzs.\' }`.',
    'Rewrite to assert 400 + the structured error + writeAgentCapabilities not called.',
    'Rename title to: `returns 400 with Érvénytelen JSON törzs when the body is malformed`.',
    '',
    '## Inversion 3 — null JSON body',
    'Current test (around line 527): `throws when the body is valid JSON but not an object (defect: capabilities access on null)`.',
    'Body is `\'null\'`. After the fix, the handler returns 400 with `{ error: \'capabilities: object body required\' }`.',
    'Rewrite to assert 400 + structured error + writeAgentCapabilities not called.',
    'Rename title to: `returns 400 with object body required when the body parses to null`.',
    '',
    '## Inversion 4 — 404 message (Fix B)',
    'Current test (around line 289-303): `returns 404 with a Hungarian error message when isKnownAgent is false`.',
    'Asserts `json()` equals `{ error: \'Agent nem található\' }`. After Fix B, this string is `\'Not found\'`.',
    'Update only the assertion to: `expect(json()).toEqual({ error: \'Not found\' })`. Update the title to: `returns 404 with generic Not found when isKnownAgent is false`.',
    '',
    '## Also update the section comment block',
    'Around line 494-498, the comment says `These tests pin the behavior: the rejection IS thrown, which proves the defect rather than hiding it.` Update to: `These tests pin the FIXED behavior: the handler now returns a structured 400 instead of propagating the rejection, which proves the fix.`',
    '',
    '## Verification',
    '1. `git diff --shortstat` — confirm insertions >= 3 AND deletions >= 3 AND total <= 30.',
    '2. `git diff src/__tests__/fleet-q-routes.test.ts | head -150` — eyeball, confirm only the 4 tests + section comment changed.',
    '3. `bun --bun vitest run src/__tests__/fleet-q-routes.test.ts 2>&1 | tail -20` — all 4 inverted tests must PASS, the existing array/string body tests must still PASS. Report the count.',
    '',
    '## Return',
    'A JSON object: { diff_shortstat, files_changed, vitest_pass, vitest_fail }',
    'Do NOT commit. Do NOT push.',
  ].join('\n'),
  { label: 'test-invert', phase: 'Test-invert', schema: {
    type: 'object',
    properties: {
      diff_shortstat: { type: 'string' },
      files_changed: { type: 'array', items: { type: 'string' } },
      vitest_pass: { type: 'number' },
      vitest_fail: { type: 'number' },
    },
    required: ['diff_shortstat','files_changed','vitest_pass','vitest_fail'],
  }},
)

const tm = testResult.diff_shortstat.match(/(\d+) insertion.*?(\d+) deletion/)
if (!tm || Number(tm[1]) < 3 || Number(tm[2]) < 3) {
  throw new Error('Test-invert diff out of safe-edit bounds: ' + testResult.diff_shortstat)
}
if (testResult.files_changed.length !== 1 || !testResult.files_changed[0].endsWith('src/__tests__/fleet-q-routes.test.ts')) {
  throw new Error('Test-invert touched files outside the test file')
}
if (testResult.vitest_fail > 0) {
  throw new Error('Test-invert left failing tests: ' + testResult.vitest_fail)
}

phase('Docs')

const docsResult = await agent(
  [
    'You are creating the two commit-stack docs commits on test/baseline.',
    '',
    '## STRICT RULES',
    '1. Commit ONLY docs/needs-to-be-fix/routes-fleet-q-body-parse-uncaught.md AND docs/needs-to-be-fix/routes-fleet-q-404-leaks-roster.md.',
    '2. Use TWO separate commits in this order:',
    '   a. Stage only the body-parse MD, commit message: `docs(needs-to-be-fix): mark routes-fleet-q-body-parse-uncaught resolved`',
    '   b. Stage only the 404-leak MD, commit message: `docs(needs-to-be-fix): mark routes-fleet-q-404-leaks-roster resolved`',
    '3. Each MD edit must add a single line at the bottom of the `## Status / Resolved` table or the closing metadata block: `Resolved: 2026-08-18 <first-7-of-fix-sha>` for the body-parse MD and `Resolved: 2026-08-18 <first-7-of-other-fix-sha>` for the 404 MD. The first-7 SHA is the SHORT SHA of the fix commit (the one that touched src/web/routes/fleet-q.ts).',
    '4. Read each MD first to find where the resolved metadata lives. If there is no `Resolved` line yet, add one at the bottom of the document with the format above.',
    '5. Do NOT modify any other MD file. Do NOT modify any source file. Do NOT touch INDEX.md.',
    '6. Do NOT push. Do NOT force anything.',
    '',
    '## How to find the SHAs',
    'Run `git log --oneline -5` BEFORE staging — you need the SHA of the fix commit (the one whose message contains `wrap readBody + JSON.parse in try/catch`) for the body-parse docs commit, and the SHA of the OTHER fix commit (the one whose message contains `close roster-enumeration leak`) for the 404 docs commit. Both fixes live in a single commit since the agent did them together. In that case use the SAME SHA on both docs lines.',
    '',
    '## Verification',
    'After both commits:',
    '1. `git log --oneline -5` — confirm 2 new docs commits on top of the existing stack.',
    '2. `git diff HEAD~2 -- docs/needs-to-be-fix/` — confirm ONLY the 2 specified MDs changed.',
    '3. `git status --short` — confirm clean.',
    '',
    '## Return',
    'A JSON object: { body_parse_docs_sha, leak_docs_sha, md_files_changed, working_tree_clean }',
  ].join('\n'),
  { label: 'docs-commit', phase: 'Docs', schema: {
    type: 'object',
    properties: {
      body_parse_docs_sha: { type: 'string' },
      leak_docs_sha: { type: 'string' },
      md_files_changed: { type: 'array', items: { type: 'string' } },
      working_tree_clean: { type: 'boolean' },
    },
    required: ['body_parse_docs_sha','leak_docs_sha','md_files_changed','working_tree_clean'],
  }},
)

if (!docsResult.working_tree_clean) {
  throw new Error('Docs phase left working tree dirty')
}
if (docsResult.md_files_changed.length !== 2 ||
    !docsResult.md_files_changed.some(f => f.endsWith('docs/needs-to-be-fix/routes-fleet-q-body-parse-uncaught.md')) ||
    !docsResult.md_files_changed.some(f => f.endsWith('docs/needs-to-be-fix/routes-fleet-q-404-leaks-roster.md'))) {
  throw new Error('Docs phase touched the wrong MD files: ' + JSON.stringify(docsResult.md_files_changed))
}

phase('Verify-final')

const final = await agent(
  [
    'Run the final verification battery on test/baseline after the fleet-q batch.',
    '',
    '1. `git log --oneline -10` — show the full commit stack added by this batch.',
    '2. `git status --short` — must be clean.',
    '3. `git rev-parse --abbrev-ref HEAD` — must be test/baseline.',
    '4. `bun --bun vitest run src/__tests__/fleet-q-routes.test.ts 2>&1 | tail -10` — all tests must PASS.',
    '5. `bun --bun vitest run 2>&1 | tail -5` — full suite must PASS, capture total test count.',
    '6. `bun --bun tsc --noEmit 2>&1 | wc -l` — capture error count. The delta vs the baseline of ' + baseline.tsc_count + ' must be <= +5. If it is higher, the fix introduced too many new TS errors.',
    '7. `git diff HEAD~5 --stat` — show files changed across the batch.',
    '',
    'Return a JSON object: { head_sha, branch, working_tree_clean, fleet_q_pass, fleet_q_fail, suite_pass, suite_fail, suite_total, tsc_count, tsc_delta, files_changed, commit_stack }',
    'commit_stack is an array of strings, one per log line.',
  ].join('\n'),
  { label: 'verify-final', phase: 'Verify-final', schema: {
    type: 'object',
    properties: {
      head_sha: { type: 'string' },
      branch: { type: 'string' },
      working_tree_clean: { type: 'boolean' },
      fleet_q_pass: { type: 'number' },
      fleet_q_fail: { type: 'number' },
      suite_pass: { type: 'number' },
      suite_fail: { type: 'number' },
      suite_total: { type: 'number' },
      tsc_count: { type: 'number' },
      tsc_delta: { type: 'number' },
      files_changed: { type: 'array', items: { type: 'string' } },
      commit_stack: { type: 'array', items: { type: 'string' } },
    },
    required: ['head_sha','branch','working_tree_clean','fleet_q_pass','fleet_q_fail','suite_pass','suite_fail','suite_total','tsc_count','tsc_delta','files_changed','commit_stack'],
  }},
)

if (final.branch !== 'test/baseline') throw new Error('Final branch is not test/baseline')
if (!final.working_tree_clean) throw new Error('Final working tree is dirty')
if (final.fleet_q_fail > 0) throw new Error('Final fleet-q tests have failures')
if (final.suite_fail > 0) throw new Error('Final full suite has failures')
if (final.tsc_delta > 5) throw new Error('Final tsc delta exceeds +5 tolerance: ' + final.tsc_delta)

return {
  status: 'ok',
  baseline: baseline,
  fix: fixResult,
  test: testResult,
  docs: docsResult,
  final: final,
}
