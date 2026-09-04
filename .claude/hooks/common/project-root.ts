/**
 * Shared filesystem roots for muhely Claude Code hooks.
 */
import { join, resolve } from "node:path";

/**
 * The workspace project root. This file lives at
 * `<project>/.claude/hooks/common`, three levels below the repo root.
 */
export const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** Directory holding per-session Stop-hook guard state. */
export const HOOK_STATE_DIR = join(PROJECT_ROOT, ".claude", "hooks", ".state");

/** Directory holding retrospective marker and report files. */
export const RETROSPECTIVES_DIR = join(
  PROJECT_ROOT,
  ".claude",
  "retrospectives",
);

/** Directory holding the shared memory index and topic files. */
export const SHARED_MEMORY_DIR = join(PROJECT_ROOT, ".claude", "shared-memory");
