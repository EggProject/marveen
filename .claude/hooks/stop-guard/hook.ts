#!/usr/bin/env node
/**
 * Stop hook entrypoint. Blocks the session from stopping when:
 * - The working tree has uncommitted shared-memory or retrospective files,
 *   OR
 * - The working tree has leftover session-created worktrees or merged
 *   branches, OR
 * - The session transcript is missing a Todo task list.
 * Never throws: internal errors are logged to stderr and exit 0.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
  type SessionResourceLeaks,
} from "./core.ts";

const execFileP = promisify(execFile);
const HOME = homedir();

/** Paths scanned for uncommitted memory files, relative to the repo root. */
const UNCOMMITTED_MEMORY_PATHS = [
  ".claude/shared-memory",
  ".claude/retrospectives",
] as const;

/** Session-created worktree path prefixes (paths starting with these are flagged). */
const WORKTREE_PATH_PREFIXES = [
  `${HOME}/claw-`,
  "/tmp/claw-",
] as const;

/** Substring that flags Workflow tool isolation worktrees in the main checkout. */
const WORKTREE_WORKFLOW_ISOLATION_MARKER = "/.claude/worktrees/wf_";

/** Branch considered permanent (not a leak even when merged into it). */
const PERMANENT_BRANCH = "refactor/classbase";

/**
 * Branches that exist in the repo independent of any session's work. They
 * are filtered out of the leftover list so the Stop hook blocks only on
 * session-created resources, not on production branches.
 */
const PERMANENT_PRODUCTION_BRANCHES = new Set([
  PERMANENT_BRANCH,
  "develop",
  "feature/develop",
  "test/baseline",
  "main",
]);

/**
 * Lists untracked `.md` files under the shared-memory or retrospectives
 * directories. Returns relative paths. Empty array on error.
 */
async function detectUncommittedMemoryFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["ls-files", "--others", "--exclude-standard", ...UNCOMMITTED_MEMORY_PATHS],
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

/**
 * Lists session-created worktree paths not yet removed. Filters by path
 * prefix (`$HOME/claw-*`, `/tmp/claw-*`) and by Workflow tool isolation
 * marker. Returns full paths.
 */
async function detectSessionWorktreePaths(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd },
    );
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter((p) =>
        WORKTREE_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
        p.includes(WORKTREE_WORKFLOW_ISOLATION_MARKER)
      );
  } catch {
    return [];
  }
}

/**
 * Lists branches that are merged into the permanent branch but not yet
 * deleted. The permanent branch itself is excluded. Empty array on error.
 */
async function detectMergedLeftoverBranches(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["branch", "--merged", PERMANENT_BRANCH, "--format=%(refname:short)"],
      { cwd },
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !PERMANENT_PRODUCTION_BRANCHES.has(line));
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

  const [
    stats,
    state,
    uncommittedMemoryFiles,
    worktreePaths,
    branchNames,
  ] = await Promise.all([
    scanTranscript(input.transcriptPath),
    store.load(),
    detectUncommittedMemoryFiles(input.cwd),
    detectSessionWorktreePaths(input.cwd),
    detectMergedLeftoverBranches(input.cwd),
  ]);
  const leaks: SessionResourceLeaks = { worktreePaths, branchNames };
  const decision = decideStopAction(stats, state, uncommittedMemoryFiles, leaks);

  await store.save(decision.nextState);

  if (decision.kind === "allow") {
    process.exitCode = 0;
    return;
  }

  process.stderr.write(`${decision.reason}\n`);
  process.exitCode = 2;
}

run().catch((error: unknown) => {
  process.stderr.write(`[stop-guard] internal error: ${String(error)}\n`);
  process.exitCode = 0;
});