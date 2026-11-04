import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function pidPath(): string {
  return join(homedir(), ".jupibuddy", "jupibuddy.pid");
}

export function logPath(): string {
  return join(homedir(), ".jupibuddy", "jupibuddy.log");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Supervisor state, written by src/supervise.ts. The pidfile holds the
 * supervisor (wrapper) pid; this file carries the server child pid so
 * `service status` can tell "healthy" from "wrapper alive, child restarting".
 */
export interface ServiceState {
  /** Wrapper pid — must equal the pidfile value before this record is trusted. */
  wrapperPid: number;
  /** Port this supervisor serves — one service per machine (single pidfile). */
  port: number;
  /** Current server child pid, or null between restarts. */
  childPid: number | null;
  /** Restarts performed by this supervisor so far. */
  restarts: number;
  state: "running" | "restarting" | "stopped";
  updatedAt: number;
}

export function supervisorStatePath(): string {
  return join(homedir(), ".jupibuddy", "jupibuddy.supervisor.json");
}

export function readServiceState(): ServiceState | null {
  try {
    const raw = readFileSync(supervisorStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ServiceState>;
    if (typeof parsed.wrapperPid !== "number") return null;
    return {
      wrapperPid: parsed.wrapperPid,
      port: typeof parsed.port === "number" ? parsed.port : 0,
      childPid: typeof parsed.childPid === "number" ? parsed.childPid : null,
      restarts: typeof parsed.restarts === "number" ? parsed.restarts : 0,
      state:
        parsed.state === "restarting" || parsed.state === "stopped"
          ? parsed.state
          : "running",
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}
