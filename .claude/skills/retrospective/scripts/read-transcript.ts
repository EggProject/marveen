#!/usr/bin/env node
/**
 * CLI entry for the retrospective skill's transcript reader: a transcript
 * path in, the report on stdout, run as `node <this file> <transcript.jsonl>`.
 * Node reads TypeScript directly, the same way the hooks under
 * `.claude/hooks/` are run.
 */
import { readFileSync } from "node:fs";

import { buildReport, formatReport } from "./transcript-report.ts";

const [transcriptPath] = process.argv.slice(2);

if (transcriptPath === undefined) {
  process.stderr.write(
    "usage: node read-transcript.ts <path to session transcript .jsonl>\n",
  );
  process.exit(2);
}

let transcript: string;
try {
  transcript = readFileSync(transcriptPath, "utf8");
} catch (error) {
  process.stderr.write(`cannot read ${transcriptPath}: ${String(error)}\n`);
  process.exit(1);
}

process.stdout.write(formatReport(buildReport(transcript)));
