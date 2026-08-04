import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderTable, statusRow, setTableImpl, resetTableImpl } from '../../ui/table.js'
import { setColorsEnabled } from '../../ui/theme.js'

beforeEach(() => { setColorsEnabled(false) })
afterEach(() => { resetTableImpl() })

describe('ui/table', () => {
  it('renders the header row and every data row', () => {
    const out = renderTable({
      head: ['Check', 'Status', 'Detail'],
      rows: [['Bun', 'OK', '1.2.0'], ['Claude', 'HIBA', 'missing']],
    })
    expect(out).toContain('Check')
    expect(out).toContain('Status')
    expect(out).toContain('Detail')
    expect(out).toContain('Bun')
    expect(out).toContain('1.2.0')
    expect(out).toContain('Claude')
    expect(out).toContain('missing')
  })

  it('renders an empty body when there are no rows', () => {
    const out = renderTable({ head: ['A'], rows: [] })
    expect(out).toContain('A')
  })

  it('passes colWidths through to cli-table3', () => {
    const ctor = vi.fn(() => ({ push: vi.fn(), toString: () => 'fake' }))
    setTableImpl(ctor as never)
    renderTable({ head: ['A'], rows: [['x']], colWidths: [10] })
    expect(ctor).toHaveBeenCalledWith({
      head: ['A'],
      style: { head: [], border: [] },
      wordWrap: true,
      colWidths: [10],
    })
  })

  it('omits colWidths when not specified and honours wordWrap: false', () => {
    const ctor = vi.fn(() => ({ push: vi.fn(), toString: () => 'fake' }))
    setTableImpl(ctor as never)
    renderTable({ head: ['A'], rows: [], wordWrap: false })
    expect(ctor).toHaveBeenCalledWith({
      head: ['A'],
      style: { head: [], border: [] },
      wordWrap: false,
    })
  })

  it('pushes each row into the injected table instance', () => {
    const push = vi.fn()
    setTableImpl(vi.fn(() => ({ push, toString: () => 'fake' })) as never)
    const out = renderTable({ head: ['A'], rows: [['1'], ['2']] })
    expect(push).toHaveBeenNthCalledWith(1, ['1'])
    expect(push).toHaveBeenNthCalledWith(2, ['2'])
    expect(out).toBe('fake')
  })

  it('resetTableImpl restores the real cli-table3 constructor', () => {
    setTableImpl(vi.fn(() => ({ push: vi.fn(), toString: () => 'fake' })) as never)
    resetTableImpl()
    expect(renderTable({ head: ['A'], rows: [['1']] })).toContain('1')
  })

  it('statusRow renders OK for a passing check', () => {
    expect(statusRow('Bun', true, '1.2.0')).toEqual(['Bun', 'OK', '1.2.0'])
  })

  it('statusRow renders HIBA for a failing check', () => {
    expect(statusRow('Bun', false)).toEqual(['Bun', 'HIBA', ''])
  })

  it('colourises the head and the status cell when colours are enabled', () => {
    setColorsEnabled(true)
    const row = statusRow('Bun', true)
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(row[1]!)).toBe(true)
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(renderTable({ head: ['A'], rows: [] }))).toBe(true)
    setColorsEnabled(false)
  })
})
