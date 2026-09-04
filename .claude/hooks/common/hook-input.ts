/**
 * Stdin JSON parsing and hook-input type guards for muhely Claude Code hooks.
 */
import { isBoolean, isRecord, isString } from "./typeguards.ts";

/** Common fields present on every Claude Code hook input payload. */
export interface HookInput<TEvent extends string> {
  readonly hookEventName: TEvent;
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
}

/** Stop hook input: the common fields plus whether the stop hook already fired. */
export interface StopHookInput extends HookInput<"Stop"> {
  readonly stopHookActive: boolean;
}

/** SessionStart hook input: the common fields plus the session start source. */
export interface SessionStartHookInput extends HookInput<"SessionStart"> {
  readonly source: string;
}

/** Reads all of stdin and parses it as JSON. Empty input or a parse failure yields `{}`. */
export async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Parses the common snake_case hook-input fields, verifying `hook_event_name` matches `event`. */
export function parseHookInput<TEvent extends string>(
  raw: unknown,
  event: TEvent,
): HookInput<TEvent> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { hook_event_name, session_id, transcript_path, cwd } = raw;
  if (
    !isString(hook_event_name) ||
    hook_event_name !== event ||
    !isString(session_id) ||
    !isString(transcript_path) ||
    !isString(cwd)
  ) {
    return undefined;
  }
  return {
    hookEventName: event,
    sessionId: session_id,
    transcriptPath: transcript_path,
    cwd,
  };
}

/** Parses a Stop hook input payload; `stop_hook_active` defaults to `false` when absent. */
export function parseStopHookInput(raw: unknown): StopHookInput | undefined {
  const base = parseHookInput(raw, "Stop");
  if (!base || !isRecord(raw)) {
    return undefined;
  }
  const { stop_hook_active } = raw;
  const stopHookActive =
    stop_hook_active === undefined ? false : stop_hook_active;
  if (!isBoolean(stopHookActive)) {
    return undefined;
  }
  return { ...base, stopHookActive };
}

/** Parses a SessionStart hook input payload; `source` defaults to `"startup"` when absent. */
export function parseSessionStartHookInput(
  raw: unknown,
): SessionStartHookInput | undefined {
  const base = parseHookInput(raw, "SessionStart");
  if (!base || !isRecord(raw)) {
    return undefined;
  }
  const { source } = raw;
  const resolvedSource = source === undefined ? "startup" : source;
  if (!isString(resolvedSource)) {
    return undefined;
  }
  return { ...base, source: resolvedSource };
}
