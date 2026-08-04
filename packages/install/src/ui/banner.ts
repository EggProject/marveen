// Banner renderer: prints a centred boxen panel with a cyan title and an
// optional dim subtitle. Used for the install welcome banner, the
// summary block, and the uninstall confirmation. Width/padding come
// from the boxen defaults so a 60-column terminal gets the same look
// as a wide CI log.

import boxen, { type Options as BoxenOptions } from 'boxen'
import { color } from './theme.js'

export interface BannerOptions {
  title: string
  subtitle?: string
  width?: number
  padding?: number
  margin?: number
  borderStyle?: BoxenOptions['borderStyle']
  borderColor?: BoxenOptions['borderColor']
}

export function banner(opts: BannerOptions): string {
  const title = color('bold', color('primary', opts.title))
  const subtitle = opts.subtitle !== undefined ? '\n' + color('dim', opts.subtitle) : ''
  const body = title + subtitle
  return boxen(body, {
    padding: opts.padding ?? 1,
    margin: opts.margin ?? 1,
    borderStyle: opts.borderStyle ?? 'round',
    borderColor: opts.borderColor ?? 'cyan',
    textAlignment: 'center',
    width: opts.width,
  })
}

export function boxed(text: string, options: BoxenOptions = {}): string {
  return boxen(text, options)
}