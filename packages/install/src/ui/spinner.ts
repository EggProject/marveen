// Spinner wrapper around ora with two modes:
//   - animated: shows the default ora spinner frames while a task runs
//   - persistent: clears the spinner once the line is logged and never
//     starts it again (for status tables and post-summary footers)
//
// Tests inject a fake ora implementation through `setSpinnerImpl` so
// they can assert on start/stop/succeed calls without touching a real
// TTY.

import ora, { type Ora } from 'ora'
import { color } from './theme.js'

export type SpinnerMode = 'animated' | 'persistent'

export interface SpinnerHandle {
  start(text: string): SpinnerHandle
  update(text: string): SpinnerHandle
  succeed(text?: string): void
  fail(text?: string): void
  stop(): void
  isSpinning: boolean
}

type OraFactory = (opts: { text: string; color?: string; isEnabled?: boolean }) => Ora

let factory: OraFactory = ora

export function setSpinnerImpl(impl: OraFactory): void {
  factory = impl
}

export function resetSpinnerImpl(): void {
  factory = ora
}

export function createSpinner(mode: SpinnerMode = 'animated'): SpinnerHandle {
  let inner: Ora | null = null
  let spinning = false
  const enabled = mode === 'animated'

  const ensure = (text: string): Ora => {
    if (inner === null) {
      inner = factory({ text, color: 'cyan', isEnabled: enabled })
    }
    return inner
  }

  return {
    start(text) {
      const sp = ensure(text)
      if (enabled) sp.start()
      else sp.text = color('primary', text)
      spinning = true
      return this
    },
    update(text) {
      if (inner !== null) {
        inner.text = color('primary', text)
      }
      return this
    },
    succeed(text) {
      if (inner !== null) {
        inner.succeed(text === undefined ? undefined : color('success', text))
      }
      spinning = false
    },
    fail(text) {
      if (inner !== null) {
        inner.fail(text === undefined ? undefined : color('error', text))
      }
      spinning = false
    },
    stop() {
      if (inner !== null && inner.isSpinning) inner.stop()
      spinning = false
    },
    get isSpinning(): boolean {
      return spinning
    },
  }
}