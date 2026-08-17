// PINNING (resolved 2026-08-17) -- syntax-check-executes-web-bundle
//
// `bun --check` is not a Bun flag: Bun ignores it and treats every following
// argument as an entrypoint to execute. `web/app.js` is a browser bundle, so
// `bun --check web/app.js web/sw.js` dies in `ReferenceError: window is not
// defined` before `web/sw.js` is ever looked at. The script has been a
// permanently-red CI gate since it was introduced in a61ff74.
//
// Fix (package.json:20): shell out to `node --check`, which parses without
// executing. `node --check` takes one file per invocation, so the two real
// bundles get checked separately. This test mirrors that and pins a negative
// case so the gate cannot silently degenerate again.

import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Under `bun --bun vitest`, the `node` on PATH is a Bun shim that ignores
// `--check` and treats the file as an entrypoint to run (the exact failure
// the source fix removes). Strip the bun-shim entries so the system `node`
// wins; on a plain `vitest run` the filter is a no-op because no such
// entry exists.
const spawnEnv = {
  ...process.env,
  PATH: (process.env.PATH ?? '')
    .split(':')
    .filter((entry) => !entry.includes('bun-node-'))
    .join(':'),
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'syntax-check-'))

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('package.json syntax-check script', () => {
  it('parses web/app.js cleanly', () => {
    const result = spawnSync('node', ['--check', 'web/app.js'], {
      cwd: process.cwd(),
      env: spawnEnv,
    })

    expect(result.status).toBe(0)
  })

  it('parses web/sw.js cleanly', () => {
    const result = spawnSync('node', ['--check', 'web/sw.js'], {
      cwd: process.cwd(),
      env: spawnEnv,
    })

    expect(result.status).toBe(0)
  })

  it('rejects a file with a deliberate syntax error', () => {
    const brokenPath = join(tmpRoot, 'broken.js')
    writeFileSync(brokenPath, 'const x = ;\n', 'utf8')

    const result = spawnSync('node', ['--check', brokenPath], {
      cwd: process.cwd(),
      env: spawnEnv,
    })

    expect(result.status).not.toBe(0)
  })
})
