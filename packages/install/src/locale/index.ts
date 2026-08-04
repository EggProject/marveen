// Locale resolver and printf-style formatter.
//
// `getLocale(lang)` returns the frozen string map. `t(key, ...args)`
// substitutes %s placeholders left-to-right. Calling `t()` with an
// unknown key throws -- the parity test guarantees every key exists in
// both languages, so a missing key is a programmer error not a UX one.

import hu, { type LocaleKey } from './hu.js'
import en from './en.js'

type LocaleMap = Readonly<Record<string, string>>

const LOCALES: Readonly<Record<'hu' | 'en', LocaleMap>> = {
  hu: hu as unknown as LocaleMap,
  en: en as unknown as LocaleMap,
}

let active: 'hu' | 'en' = 'hu'
let activeMap: LocaleMap = hu as unknown as LocaleMap

export function getLocale(lang: 'hu' | 'en'): LocaleMap {
  return LOCALES[lang]
}

export function initLocale(lang: 'hu' | 'en'): void {
  active = lang
  activeMap = LOCALES[lang]
}

export function currentLocale(): 'hu' | 'en' {
  return active
}

export function t(key: LocaleKey | string, ...args: readonly string[]): string {
  const template = activeMap[key]
  if (template === undefined) {
    throw new Error(`Missing locale key: ${key}`)
  }
  if (args.length === 0) return template
  let i = 0
  return template.replace(/%s/g, () => {
    const arg = args[i]
    i += 1
    return arg ?? ''
  })
}