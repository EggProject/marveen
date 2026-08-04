// Chalk colour presets for the installer UI.
//
// Each preset returns a fresh chalk chain based on the global colour
// setting -- we honour NO_COLOR and the `--no-color` commander flag by
// forcing chalk.Level.None when colours are disabled, so tests that strip
// ANSI get deterministic output regardless of the host terminal.

import chalk, { type ChalkInstance } from 'chalk'

export type ColorPreset = 'primary' | 'success' | 'warn' | 'error' | 'dim' | 'muted' | 'bold'

let colorsEnabled = true

export function setColorsEnabled(enabled: boolean): void {
  colorsEnabled = enabled
  chalk.level = enabled ? 3 : 0
}

export function areColorsEnabled(): boolean {
  return colorsEnabled
}

const presets: Readonly<Record<ColorPreset, (text: string) => string>> = {
  primary: (t) => colorsEnabled ? chalk.cyan(t) : t,
  success: (t) => colorsEnabled ? chalk.green(t) : t,
  warn: (t) => colorsEnabled ? chalk.yellow(t) : t,
  error: (t) => colorsEnabled ? chalk.red(t) : t,
  dim: (t) => colorsEnabled ? chalk.gray(t) : t,
  muted: (t) => colorsEnabled ? chalk.dim(t) : t,
  bold: (t) => colorsEnabled ? chalk.bold(t) : t,
}

export function color(preset: ColorPreset, text: string): string {
  return presets[preset](text)
}

export function getChalk(): ChalkInstance {
  return chalk
}