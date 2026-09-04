/**
 * Shared type guards for muhely Claude Code hooks.
 */

/** Narrows an unknown value to a plain object record. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrows an unknown value to a string. */
export function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** Narrows an unknown value to a boolean. */
export function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

/** Narrows an unknown value to a number. */
export function isNumber(v: unknown): v is number {
  return typeof v === "number";
}

/** Narrows an unknown error value to one carrying a string `code`, like Node's ErrnoException. */
export function hasErrorCode(v: unknown): v is { code: string } {
  return isRecord(v) && isString(v.code);
}

/** Session ids are used to build a state file path; only allow safe characters. */
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** True when a session id is safe to embed in a filesystem path. */
export function isSafeSessionId(v: string): boolean {
  return SAFE_SESSION_ID_PATTERN.test(v);
}
