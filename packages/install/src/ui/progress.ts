// cli-progress MultiBar wrapper for the long-running install steps
// (npm install, tsc build). The installer drives a single MultiBar and
// spawns bars per phase, calling `update(payload)` as work progresses
// and `stop()` once the phase finishes. The factory is mockable so
// tests don't need a real TTY.

import cliProgress, { type MultiBar } from 'cli-progress'
import { color } from './theme.js'

interface MultiBarFactory {
  create(options: cliProgress.Options): MultiBar
}

const defaultMultiFactory: MultiBarFactory = {
  create: (options) => new cliProgress.MultiBar(options, cliProgress.Presets.shades_classic),
}

let multiFactory: MultiBarFactory = defaultMultiFactory

export function setProgressImpl(multi: MultiBarFactory): void {
  multiFactory = multi
}

export function resetProgressImpl(): void {
  multiFactory = defaultMultiFactory
}

export interface ProgressBar {
  start(total: number, startValue?: number): void
  update(value: number, payload?: Record<string, unknown>): void
  increment(delta?: number, payload?: Record<string, unknown>): void
  stop(): void
  get isActive(): boolean
}

export interface ProgressSession {
  add(total: number, label: string, startValue?: number): ProgressBar
  stop(): void
}

export function createProgress(format?: string): ProgressSession {
  const multibar = multiFactory.create({
    clearOnComplete: false,
    hideCursor: true,
    autopadding: true,
    format: format ?? color('primary', '{bar}') + ' | {percentage}% | {label} | {value}/{total}',
  })

  const bars: ProgressBar[] = []

  return {
    add(total, label, startValue = 0) {
      const bar = multibar.create(total, startValue, { label: color('dim', label) })
      const handle: ProgressBar = {
        start(value) { bar.start(value, 0) },
        update(value, payload) { bar.update(value, payload) },
        increment(delta, payload) { bar.increment(delta, payload) },
        stop() { bar.stop() },
        get isActive(): boolean { return (bar as unknown as { isActive?: boolean }).isActive === true },
      }
      bars.push(handle)
      return handle
    },
    stop() {
      multibar.stop()
    },
  }
}