import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSpinner, setSpinnerImpl, resetSpinnerImpl } from '../../ui/spinner.js'
import { setColorsEnabled } from '../../ui/theme.js'

interface FakeOra {
  text: string
  isSpinning: boolean
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  succeed: ReturnType<typeof vi.fn>
  fail: ReturnType<typeof vi.fn>
}

function installFakeOra(): { instances: FakeOra[]; opts: unknown[] } {
  const instances: FakeOra[] = []
  const opts: unknown[] = []
  setSpinnerImpl(((o: unknown) => {
    opts.push(o)
    const inst: FakeOra = {
      text: '',
      isSpinning: false,
      start: vi.fn(function (this: FakeOra) { inst.isSpinning = true; return inst }),
      stop: vi.fn(function () { inst.isSpinning = false; return inst }),
      succeed: vi.fn(() => inst),
      fail: vi.fn(() => inst),
    }
    instances.push(inst)
    return inst
  }) as never)
  return { instances, opts }
}

afterEach(() => {
  resetSpinnerImpl()
  setColorsEnabled(false)
})

describe('ui/spinner', () => {
  it('animated mode starts the ora spinner', () => {
    setColorsEnabled(false)
    const { instances, opts } = installFakeOra()
    const sp = createSpinner('animated')
    expect(sp.isSpinning).toBe(false)
    expect(sp.start('dolgozom')).toBe(sp)
    expect(instances[0]!.start).toHaveBeenCalledTimes(1)
    expect(opts[0]).toEqual({ text: 'dolgozom', color: 'cyan', isEnabled: true })
    expect(sp.isSpinning).toBe(true)
  })

  it('defaults to animated mode', () => {
    const { instances } = installFakeOra()
    createSpinner().start('x')
    expect(instances[0]!.start).toHaveBeenCalled()
  })

  it('persistent mode sets the text instead of starting frames', () => {
    const { instances, opts } = installFakeOra()
    const sp = createSpinner('persistent')
    sp.start('statikus')
    expect(instances[0]!.start).not.toHaveBeenCalled()
    expect(instances[0]!.text).toBe('statikus')
    expect(opts[0]).toEqual({ text: 'statikus', color: 'cyan', isEnabled: false })
    expect(sp.isSpinning).toBe(true)
  })

  it('reuses the same ora instance across restarts', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('animated')
    sp.start('egy')
    sp.start('ketto')
    expect(instances).toHaveLength(1)
    expect(instances[0]!.start).toHaveBeenCalledTimes(2)
  })

  it('update rewrites the text after start', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('animated')
    sp.start('egy')
    expect(sp.update('ketto')).toBe(sp)
    expect(instances[0]!.text).toBe('ketto')
  })

  it('update is a no-op before start', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('animated')
    expect(sp.update('x')).toBe(sp)
    expect(instances).toHaveLength(0)
  })

  it('succeed forwards the coloured text and clears isSpinning', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('animated')
    sp.start('x')
    sp.succeed('kesz')
    expect(instances[0]!.succeed).toHaveBeenCalledWith('kesz')
    expect(sp.isSpinning).toBe(false)
  })

  it('succeed without text forwards undefined', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('animated')
    sp.start('x')
    sp.succeed()
    expect(instances[0]!.succeed).toHaveBeenCalledWith(undefined)
  })

  it('succeed is a no-op before start', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('animated')
    sp.succeed('kesz')
    expect(instances).toHaveLength(0)
    expect(sp.isSpinning).toBe(false)
  })

  it('fail forwards the coloured text and clears isSpinning', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('animated')
    sp.start('x')
    sp.fail('hiba')
    expect(instances[0]!.fail).toHaveBeenCalledWith('hiba')
    expect(sp.isSpinning).toBe(false)
  })

  it('fail without text forwards undefined', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('animated')
    sp.start('x')
    sp.fail()
    expect(instances[0]!.fail).toHaveBeenCalledWith(undefined)
  })

  it('fail is a no-op before start', () => {
    const { instances } = installFakeOra()
    createSpinner('animated').fail('hiba')
    expect(instances).toHaveLength(0)
  })

  it('stop halts a spinning instance', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('animated')
    sp.start('x')
    sp.stop()
    expect(instances[0]!.stop).toHaveBeenCalledTimes(1)
    expect(sp.isSpinning).toBe(false)
  })

  it('stop does not call ora when the instance is not spinning', () => {
    const { instances } = installFakeOra()
    const sp = createSpinner('persistent')
    sp.start('x')
    sp.stop()
    expect(instances[0]!.stop).not.toHaveBeenCalled()
  })

  it('stop is a no-op before start', () => {
    const { instances } = installFakeOra()
    createSpinner('animated').stop()
    expect(instances).toHaveLength(0)
  })

  it('resetSpinnerImpl restores the real ora factory', () => {
    installFakeOra()
    resetSpinnerImpl()
    const sp = createSpinner('persistent')
    sp.start('valodi ora')
    expect(sp.isSpinning).toBe(true)
    sp.stop()
  })

  it('colourises the text when colours are enabled', () => {
    setColorsEnabled(true)
    const { instances } = installFakeOra()
    const sp = createSpinner('persistent')
    sp.start('szines')
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(instances[0]!.text)).toBe(true)
  })
})
