import { describe, it, expect } from 'vitest'
import hu from '../../locale/hu.js'
import en from '../../locale/en.js'

const huKeys = Object.keys(hu).sort()
const enKeys = Object.keys(en).sort()

describe('locale parity', () => {
  it('hu and en have the EXACT same key set', () => {
    expect(huKeys).toEqual(enKeys)
  })

  it('no key is missing from en', () => {
    expect(huKeys.filter((k) => !enKeys.includes(k))).toEqual([])
  })

  it('no key is missing from hu', () => {
    expect(enKeys.filter((k) => !huKeys.includes(k))).toEqual([])
  })

  it('the same keys are declared in the same order', () => {
    expect(Object.keys(hu)).toEqual(Object.keys(en))
  })

  it('placeholder counts match key by key', () => {
    for (const key of huKeys) {
      const huCount = (hu[key as keyof typeof hu].match(/%s/g) ?? []).length
      const enCount = (en[key as keyof typeof en].match(/%s/g) ?? []).length
      expect(enCount, key).toBe(huCount)
    }
  })
})
