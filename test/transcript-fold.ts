#!/usr/bin/env bun
// Golden fixtures conformance: fold invariant checker.
// Reads each fixture, runs foldTranscript, asserts summary counters == fold.
// Exits non-zero on mismatch (CI). Tolerance rule is verified separately.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldTranscript } from "../src/transcript";

const fixtures = [
  "test/fixtures/transcripts/native.jsonl",
  "test/fixtures/transcripts/compacted.jsonl",
  "test/fixtures/transcripts/claude-import.jsonl",
];

let allPass = true;

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

for (const rel of fixtures) {
  const abs = join(import.meta.dir, "..", rel);
  // When running from repo root via bun run ./test/transcript-fold.ts, import.meta.dir is .../test
  // Handle both invocation styles: resolve relative to cwd as fallback
  let raw: string;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch {
    raw = readFileSync(join(process.cwd(), rel), "utf-8");
  }
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  const folded = foldTranscript(lines);
  const summary = lines.find((l: Record<string, unknown>) => l.type === "summary") as Record<string, unknown> | undefined;
  if (!summary) {
    console.error(`FAIL ${rel}: no summary line`);
    allPass = false;
    continue;
  }
  const mismatches: string[] = [];
  if (summary.steps !== folded.counters.steps) mismatches.push(`steps summary=${summary.steps} fold=${folded.counters.steps}`);
  if (!deepEqual(summary.effects, folded.counters.effects)) mismatches.push(`effects summary=${JSON.stringify(summary.effects)} fold=${JSON.stringify(folded.counters.effects)}`);
  if (summary.compacted !== folded.counters.compacted) mismatches.push(`compacted summary=${summary.compacted} fold=${folded.counters.compacted}`);
  if (summary.turnsDropped !== folded.counters.turnsDropped) mismatches.push(`turnsDropped summary=${summary.turnsDropped} fold=${folded.counters.turnsDropped}`);
  if (!deepEqual(summary.usage, folded.counters.usage)) mismatches.push(`usage summary=${JSON.stringify(summary.usage)} fold=${JSON.stringify(folded.counters.usage)}`);
  // Also check basic envelope invariants for fixtures
  const seqs = lines.map((l: Record<string, unknown>) => l.seq as number);
  for (let i = 0; i < seqs.length; i++) if (seqs[i] !== i) mismatches.push(`seq monotonic violation at ${i}: got ${seqs[i]}`);
  // parentUuid chain
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1] as Record<string, unknown>;
    const cur = lines[i] as Record<string, unknown>;
    if (cur.parentUuid !== prev.uuid) mismatches.push(`parentUuid chain broken at seq ${cur.seq}: expected ${prev.uuid} got ${cur.parentUuid}`);
  }
  if (mismatches.length) {
    console.error(`FAIL ${rel}:`);
    for (const m of mismatches) console.error(`  - ${m}`);
    console.error(`  folded=${JSON.stringify(folded)}`);
    allPass = false;
  } else {
    console.log(`PASS ${rel}: turns=${folded.turns} toolCalls=${folded.toolCalls} steps=${folded.counters.steps} effects=${JSON.stringify(folded.counters.effects)} compacted=${folded.counters.compacted} turnsDropped=${folded.counters.turnsDropped}`);
  }
}

if (!allPass) {
  console.error("FAIL: one or more fixtures did not match fold invariant");
  process.exit(1);
}
console.log("All 3 fixtures replay identical (fold invariant holds)");
