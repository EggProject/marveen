#!/usr/bin/env node
/**
 * Stop hook entrypoint. Blocks the session from stopping when:
 * - The working tree has uncommitted shared-memory or retrospective files,
 *   OR
 * - The session transcript is missing a Todo task list.
 * Never throws: internal errors are logged to stderr and exit 0.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { parseStopHookInput, readStdinJson } from "../common/hook-input.ts";
import { HOOK_STATE_DIR } from "../common/project-root.ts";
import { scanTranscript } from "../common/transcript.ts";
import { isSafeSessionId } from "../common/typeguards.ts";
import {
  DEFAULT_SESSION_GUARD_STATE,
  decideStopAction,
  isSessionGuardState,
  type SessionGuardState,
} from "./core.ts";

const execFileP = promisify(execFile);

/** Paths scanned for uncommitted memory files, relative to the repo root. */
const UNCOMMITTED_MEMORY_PATHS = [
  ".claude/shared-memory",
  ".claude/retrospectives",
] as const;

/**
 * Lists untracked `.md` files under the shared-memory or retrospectives
 * directories. Returns relative paths (e.g. `.claude/shared-memory/x.md`).
 * Returns an empty array if cwd is not a git repo, the paths do not exist,
 * or git is not on PATH — the hook degrades to allow-stop in that case
 * because the uncommitted-memory rule is additive, not load-bearing.
 */
async function detectUncommittedMemoryFiles(
  cwd: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      "git",
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        ...UNCOMMITTED_MEMORY_PATHS,
      ],
      { cwd },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Loads and persists per-session guard state as a JSON file on disk. */
class SessionGuardStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Loads the stored state, tolerating a missing or corrupt file. */
  async load(): Promise<SessionGuardState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return isSessionGuardState(parsed) ? parsed : DEFAULT_SESSION_GUARD_STATE;
    } catch {
      return DEFAULT_SESSION_GUARD_STATE;
    }
  }

  /** Persists the given state, creating the parent directory if needed. */
  async save(state: SessionGuardState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state), "utf8");
  }
}

async function run(): Promise<void> {
  const raw = await readStdinJson();
  const input = parseStopHookInput(raw);
  if (!input) {
    process.exitCode = 0;
    return;
  }
  if (input.stopHookActive) {
    process.exitCode = 0;
    return;
  }
  if (!isSafeSessionId(input.sessionId)) {
    process.stderr.write("[stop-guard] invalid session id, skipping\n");
    process.exitCode = 0;
    return;
  }

  const stateFilePath = join(HOOK_STATE_DIR, `${input.sessionId}.json`);
  const store = new SessionGuardStore(stateFilePath);

  const [stats, state, uncommittedMemoryFiles] = await Promise.all([
    scanTranscript(input.transcriptPath),
    store.load(),
    detectUncommittedMemoryFiles(input.cwd),
  ]);
  const decision = decideStopAction(stats, state, uncommittedMemoryFiles);

  if (decision.kind === "allow") {
    process.exitCode = 0;
    return;
  }

  await store.save(decision.nextState);
  process.stderr.write(`${decision.reason}\n`);
  process.exitCode = 2;
}

run().catch((error: unknown) => {
  process.stderr.write(`[stop-guard] internal error: ${String(error)}\n`);
  process.exitCode = 0;
});