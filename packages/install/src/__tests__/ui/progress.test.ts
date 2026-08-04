import { describe, it, expect, vi, afterEach } from 'vitest'
import { createProgress, setProgressImpl, resetProgressImpl } from '../../ui/progress.js'
import { setColorsEnabled } from '../../ui/theme.js'
import { captureOutput } from '../_helpers.js'

interface FakeBar {
  isActive: boolean
  start: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  increment: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

function installFakeMulti(): {
  createOpts: unknown[]
  barArgs: unknown[][]
  bars: FakeBar[]
  multiStop: ReturnType<typeof vi.fn>
} {
  const createOpts: unknown[] = []
  const barArgs: unknown[][] = []
  const bars: FakeBar[] = []
  const multiStop = vi.fn()
  setProgressImpl({
    create: (options: unknown) => {
      createOpts.push(options)
      return {
        create: (...args: unknown[]) => {
          barArgs.push(args)
          const bar: FakeBar = {
            isActive: false,
            start: vi.fn(),
            update: vi.fn(),
            increment: vi.fn(),
            stop: vi.fn(),
          }
          bars.push(bar)
          return bar
        },
        stop: multiStop,
      }
    },
  } as never)
  return { createOpts, barArgs, bars, multiStop }
}

afterEach(() => {
  resetProgressImpl()
  setColorsEnabled(false)
})

describe('ui/progress', () => {
  it('creates a MultiBar with the default format', () => {
    setColorsEnabled(false)
    const { createOpts } = installFakeMulti()
    createProgress()
    expect(createOpts[0]).toEqual({
      clearOnComplete: false,
      hideCursor: true,
      autopadding: true,
      format: '{bar} | {percentage}% | {label} | {value}/{total}',
    })
  })

  it('honours an explicit format string', () => {
    const { createOpts } = installFakeMulti()
    createProgress('{bar} egyedi')
    expect((createOpts[0] as { format: string }).format).toBe('{bar} egyedi')
  })

  it('add creates a bar with total, start value and label payload', () => {
    const { barArgs } = installFakeMulti()
    const session = createProgress()
    session.add(100, 'npm install')
    expect(barArgs[0]).toEqual([100, 0, { label: 'npm install' }])
  })

  it('add honours an explicit start value', () => {
    const { barArgs } = installFakeMulti()
    createProgress().add(50, 'build', 10)
    expect(barArgs[0]).toEqual([50, 10, { label: 'build' }])
  })

  it('bar start/update/increment/stop delegate to cli-progress', () => {
    const { bars } = installFakeMulti()
    const bar = createProgress().add(10, 'x')
    bar.start(10)
    bar.update(5, { label: 'fele' })
    bar.increment(1, { label: 'meg egy' })
    bar.increment()
    bar.stop()
    expect(bars[0]!.start).toHaveBeenCalledWith(10, 0)
    expect(bars[0]!.update).toHaveBeenCalledWith(5, { label: 'fele' })
    expect(bars[0]!.increment).toHaveBeenNthCalledWith(1, 1, { label: 'meg egy' })
    expect(bars[0]!.increment).toHaveBeenNthCalledWith(2, undefined, undefined)
    expect(bars[0]!.stop).toHaveBeenCalledTimes(1)
  })

  it('isActive mirrors the underlying bar flag', () => {
    const { bars } = installFakeMulti()
    const bar = createProgress().add(10, 'x')
    expect(bar.isActive).toBe(false)
    bars[0]!.isActive = true
    expect(bar.isActive).toBe(true)
  })

  it('session stop stops the MultiBar', () => {
    const { multiStop } = installFakeMulti()
    const session = createProgress()
    session.add(1, 'a')
    session.add(2, 'b')
    session.stop()
    expect(multiStop).toHaveBeenCalledTimes(1)
  })

  it('colourises the label when colours are enabled', () => {
    setColorsEnabled(true)
    const { barArgs } = installFakeMulti()
    createProgress().add(1, 'szines')
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test((barArgs[0]![2] as { label: string }).label)).toBe(true)
  })

  it('resetProgressImpl restores the real cli-progress MultiBar factory', async () => {
    installFakeMulti()
    resetProgressImpl()
    await captureOutput(() => {
      const session = createProgress()
      session.stop()
    })
  })
})
