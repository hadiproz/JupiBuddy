#!/usr/bin/env bun
// JupiBuddy lightweight supervisor (S3): spawns the real server as a child,
// restarts it on unexpected exit, and forwards SIGTERM/SIGINT to that child.
//
//   bun src/supervise.ts --port <N> --entry <abs path to index.ts>
//
// Contract with src/cli.ts:
//   - ~/.jupibuddy/jupibuddy.pid holds THIS (wrapper) pid.
//   - ~/.jupibuddy/jupibuddy.supervisor.json holds the child pid + restart count.
//   - SIGTERM/SIGINT: SIGTERM the child, wait up to 3s, SIGKILL it, remove the
//     pidfile if it still points at us, exit 0.
//
// Plain TypeScript, zero deps — no Effect, no external supervisor.

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isPidAlive,
  logPath,
  pidPath,
  supervisorStatePath,
  type ServiceState,
} from "./daemon";

/** Give up after this many restarts inside RAPID_WINDOW_MS. */
const MAX_RAPID_RESTARTS = 5;
const RAPID_WINDOW_MS = 60_000;
/** A child that stayed healthy this long earns a fresh budget (run crash). */
const STABLE_AFTER_MS = 30_000;
const HEALTH_INTERVAL_MS = 1000;
const RESTART_DELAY_MS = 500;
const STOP_GRACE_MS = 3000;

function flag(name: string): string | null {
  const argv = Bun.argv.slice(2);
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1] !== undefined) return argv[idx + 1];
  const eq = argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
}

const port = Number(flag("--port") ?? "");
if (!Number.isFinite(port) || port <= 0) {
  console.error("[supervisor] usage: bun src/supervise.ts --port <N> --entry <index.ts>");
  process.exit(2);
}
const entry = flag("--entry") ?? join(import.meta.dir, "index.ts");
const url = `http://127.0.0.1:${port}`;

let childPid: number | null = null;
/** When the current child first answered /healthz (null = not yet healthy). */
let healthySince: number | null = null;
let restarts = 0;
let stopping = false;
/** Timestamps of recent restarts, pruned to RAPID_WINDOW_MS. */
let rapid: number[] = [];

function writeState(state: ServiceState["state"]): void {
  const payload: ServiceState = {
    wrapperPid: process.pid,
    port,
    childPid,
    restarts,
    state,
    updatedAt: Date.now(),
  };
  try {
    writeFileSync(supervisorStatePath(), JSON.stringify(payload), "utf-8");
  } catch {
    // Status degrades to "pid only" — never fatal.
  }
}

function claimPidfile(): boolean {
  try {
    mkdirSync(join(homedir(), ".jupibuddy"), { recursive: true });
  } catch {}
  try {
    writeFileSync(pidPath(), String(process.pid), "utf-8");
    return true;
  } catch (e) {
    console.error(`[supervisor] failed to write pidfile ${pidPath()}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function releasePidfile(): void {
  try {
    if (readFileSync(pidPath(), "utf-8").trim() === String(process.pid)) unlinkSync(pidPath());
  } catch {}
}

function giveUp(reason: string): never {
  console.error(`[supervisor] giving up: ${reason} — server keeps dying. See ${logPath()}`);
  childPid = null;
  writeState("stopped");
  releasePidfile();
  process.exit(1);
}

async function runChildOnce(): Promise<number | null> {
  let fd: number;
  try {
    fd = openSync(logPath(), "a");
  } catch (e) {
    console.error(`[supervisor] failed to open log ${logPath()}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bun", entry, "--port", String(port)], {
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
  } finally {
    try { closeSync(fd); } catch {}
  }
  childPid = proc.pid;
  healthySince = null;
  console.log(`[supervisor] server started (pid ${childPid}) on port ${port}`);
  writeState("running");
  const code = await proc.exited;
  childPid = null;
  return code;
}

async function superviseLoop(): Promise<void> {
  for (;;) {
    if (stopping) return;
    const startedAt = Date.now();
    let code: number | null = null;
    try {
      code = await runChildOnce();
    } catch (e) {
      console.error(`[supervisor] spawn error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (stopping) return;
    const ranFor = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[supervisor] server child exited (code ${code}) after ${ranFor}s`);

    const now = Date.now();
    // A run that stayed healthy is a run crash, not a boot crash: fresh budget.
    if (healthySince !== null && now - healthySince >= STABLE_AFTER_MS) rapid = [];
    healthySince = null;
    rapid = rapid.filter((t) => now - t < RAPID_WINDOW_MS);
    if (rapid.length >= MAX_RAPID_RESTARTS) {
      giveUp(`${rapid.length} restarts within ${RAPID_WINDOW_MS / 1000}s`);
    }
    rapid.push(now);
    restarts += 1;
    writeState("restarting");
    console.error(`[supervisor] restarting server (restart ${restarts}) in ${RESTART_DELAY_MS}ms`);
    await Bun.sleep(RESTART_DELAY_MS);
  }
}

async function monitorHealth(): Promise<void> {
  for (;;) {
    await Bun.sleep(HEALTH_INTERVAL_MS);
    if (stopping) return;
    const pid = childPid;
    // Only trust /healthz while OUR child is alive — a foreign listener on the
    // same port must not look like a healthy child.
    if (pid === null || !isPidAlive(pid)) continue;
    let ok = false;
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(HEALTH_INTERVAL_MS) });
      ok = res.ok;
    } catch {}
    if (ok && healthySince === null) {
      healthySince = Date.now();
      console.log(`[supervisor] server pid ${pid} healthy on ${url}`);
      writeState("running");
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  const pid = childPid;
  console.log(`[supervisor] ${signal} received — stopping${pid !== null ? ` server pid ${pid}` : ""}`);
  if (pid !== null && isPidAlive(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    const start = Date.now();
    // Async sleep: Bun must get a turn to reap the child, otherwise kill(pid, 0)
    // keeps succeeding on the zombie and we wait out the whole grace period.
    while (Date.now() - start < STOP_GRACE_MS && isPidAlive(pid)) {
      await Bun.sleep(100);
    }
    if (isPidAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await Bun.sleep(200);
    }
  }
  writeState("stopped");
  releasePidfile();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
// Detached from a terminal: ignore SIGHUP so closing the shell keeps the service.
process.on("SIGHUP", () => {});

if (!claimPidfile()) process.exit(1);
writeState("running");
void monitorHealth();
void superviseLoop();
