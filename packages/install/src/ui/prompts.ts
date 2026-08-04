// Wrapper around @inquirer/prompts with Hungarian validate messages and
// process.exit handling for Ctrl+C.
//
// The validate functions in this module return the canonical hu.ts
// strings (a parallel English set lives in en.ts -- both are reached
// through `t(...)` based on the active locale). The wrapper catches
// ExitPromptError from @inquirer/prompts and turns it into a graceful
// exit with code 130, matching the previous bash installer's contract.
//
// All prompt types are injected so unit tests can substitute scripted
// responses via `setPromptImpls`.

import {
  select as inquirerSelect,
  input as inquirerInput,
  password as inquirerPassword,
  confirm as inquirerConfirm,
} from '@inquirer/prompts'
import { t } from '../locale/index.js'

export const EXIT_CODES = {
  OK: 0,
  CANCEL: 130,
  ERROR: 1,
} as const

type SelectFn = typeof inquirerSelect
type InputFn = typeof inquirerInput
type PasswordFn = typeof inquirerPassword
type ConfirmFn = typeof inquirerConfirm

let selectImpl: SelectFn = inquirerSelect
let inputImpl: InputFn = inquirerInput
let passwordImpl: PasswordFn = inquirerPassword
let confirmImpl: ConfirmFn = inquirerConfirm

export function setPromptImpls(impls: {
  select?: SelectFn
  input?: InputFn
  password?: PasswordFn
  confirm?: ConfirmFn
}): void {
  if (impls.select) selectImpl = impls.select
  if (impls.input) inputImpl = impls.input
  if (impls.password) passwordImpl = impls.password
  if (impls.confirm) confirmImpl = impls.confirm
}

export function resetPromptImpls(): void {
  selectImpl = inquirerSelect
  inputImpl = inquirerInput
  passwordImpl = inquirerPassword
  confirmImpl = inquirerConfirm
}

export interface SelectChoice<V extends string> {
  name: string
  value: V
}

export async function select<V extends string>(
  message: string,
  choices: readonly SelectChoice<V>[],
): Promise<V> {
  try {
    return await selectImpl<V>({
      message,
      choices: choices.map((c) => ({ name: c.name, value: c.value })),
    })
  } catch (err: unknown) {
    handlePromptError(err)
  }
}

export interface InputOptions {
  defaultValue?: string
  validate?: (value: string) => true | string
  password?: boolean
}

export async function input(message: string, opts: InputOptions = {}): Promise<string> {
  try {
    return await inputImpl({
      message,
      default: opts.defaultValue,
      validate: opts.validate,
      ...(opts.password !== undefined ? { mask: '*' } : {}),
    })
  } catch (err: unknown) {
    handlePromptError(err)
  }
}

export async function password(message: string, opts: { validate?: (value: string) => true | string } = {}): Promise<string> {
  try {
    return await passwordImpl({
      message,
      validate: opts.validate,
      mask: '*',
    })
  } catch (err: unknown) {
    handlePromptError(err)
  }
}

export async function confirm(message: string, defaultValue = false): Promise<boolean> {
  try {
    return await confirmImpl({ message, default: defaultValue })
  } catch (err: unknown) {
    handlePromptError(err)
  }
}

// --- Validators -------------------------------------------------------------

export function validateRequired(value: string): true | string {
  if (value.trim().length === 0) return t('prompt.required')
  return true
}

export function validateInteger(value: string): true | string {
  if (!/^-?\d+$/.test(value)) return t('prompt.integer')
  return true
}

export function validatePort(value: string): true | string {
  const check = validateInteger(value)
  if (check !== true) return check
  const n = Number(value)
  if (n < 1 || n > 65535) return t('prompt.port-range')
  return true
}

export function validateMinLength20(value: string): true | string {
  if (value.length < 20) return t('prompt.min-length-20')
  return true
}

export function validateUrl(value: string): true | string {
  if (!/^https?:\/\//i.test(value)) return t('prompt.url')
  return true
}

export function validateChoice123(value: string): true | string {
  if (value !== '1' && value !== '2' && value !== '3') return t('prompt.choice-1-2-3')
  return true
}

export function validateYesNo(value: string): true | string {
  const v = value.trim().toLowerCase()
  if (v !== 'igen' && v !== 'nem' && v !== 'yes' && v !== 'no' && v !== 'y' && v !== 'n') {
    return t('prompt.yes-no')
  }
  return true
}

function handlePromptError(err: unknown): never {
  if (err instanceof Error && (err.name === 'ExitPromptError' || /ExitPrompt/.test(err.message))) {
    process.stderr.write(t('prompt.cancelled') + '\n')
    process.exit(EXIT_CODES.CANCEL)
  }
  throw err
}