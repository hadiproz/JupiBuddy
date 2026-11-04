#!/usr/bin/env bun
// JupiBuddy entry point — `bunx jupibuddy` lands here.
//
// S2: boots with NotebookService (welcome vs workbench), one kernel per notebook,
//     dual adapters via single core, unresolved-friendly degraded boot.

import { loadConfig } from "./config";
import { pidPath, logPath, isPidAlive } from "./daemon";
import { existsSync, mkdirSync, unlinkSync, openSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { NotebookService } from "./notebook/service";
import { createToolsWithService } from "./mcp/tools";
import { startServer } from "./server";

const rawArgv = Bun.argv.slice(2);
const cfg = loadConfig(rawArgv);

// --- Daemon flag handling ---
if (rawArgv.includes("--daemon")) {
  await handleDaemon(rawArgv, cfg);
}
if (rawArgv.includes("--stop")) {
  await handleStop(cfg);
}
if (rawArgv.includes("--status")) {
  await handleStatus(cfg);
}

// --- Thin CLI dispatch: known subcommands fall through to cli.ts ---
const KNOWN_CLI = new Set(["status", "open", "run", "sessions", "logs", "service"]);
if (rawArgv.some((a) => KNOWN_CLI.has(a))) {
  const { dispatchCli } = await import("./cli");
  await dispatchCli(rawArgv, cfg);
}

// Daemon helpers
async function handleDaemon(argv: string[], cfg: { port: number }): Promise<never> {
  const pidFile = pidPath();
  const logFile = logPath();
  if (existsSync(pidFile)) {
    try {
      const pidStr = readFileSync(pidFile, "utf-8").trim();
      const pid = Number(pidStr);
      if (Number.isFinite(pid) && isPidAlive(pid)) {
        console.error(`already running (pid ${pid}) — pidfile ${pidFile} exists`);
        process.exit(1);
      } else {
        console.warn(`stale pidfile ${pidFile} (pid ${pidStr} not running) — overwriting`);
      }
    } catch {
      console.warn(`stale pidfile ${pidFile} unreadable — overwriting`);
    }
  }
  try { mkdirSync(join(homedir(), ".jupibuddy"), { recursive: true }); } catch {}
  const filtered = argv.filter((a) => a !== "--daemon");
  const script = (Bun.argv[1] ?? process.argv[1] ?? join(import.meta.dir, "index.ts")) as string;
  let fd: number;
  try { fd = openSync(logFile, "a"); } catch (e) {
    console.error(`failed to open log ${logFile}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bun", script, ...filtered], { stdin: "ignore", stdout: fd, stderr: fd });
  } catch (e) {
    console.error(`failed to spawn daemon: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(pidFile, String(proc.pid), "utf-8");
  } catch (e) {
    console.error(`failed to write pidfile ${pidFile}: ${e instanceof Error ? e.message : String(e)}`);
    try { proc.kill(); } catch {}
    process.exit(1);
  }
  try { closeSync(fd); } catch {}
  console.log(`daemon started (pid ${proc.pid}) on port ${cfg.port} — log: ${logFile}`);
  process.exit(0);
}

async function handleStop(cfg: { port: number }): Promise<never> {
  const pidFile = pidPath();
  if (!existsSync(pidFile)) {
    console.error(`not running (no pidfile at ${pidFile})`);
    process.exit(1);
  }
  let pidStr: string;
  try { pidStr = readFileSync(pidFile, "utf-8").trim(); } catch (e) {
    console.error(`failed to read pidfile ${pidFile}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const pid = Number(pidStr);
  if (!Number.isFinite(pid)) {
    console.error(`bad pidfile ${pidFile}: "${pidStr}"`);
    try { unlinkSync(pidFile); } catch {}
    process.exit(1);
  }
  if (!isPidAlive(pid)) {
    console.warn(`stale pidfile ${pidFile} (pid ${pid} not running) — removing`);
    try { unlinkSync(pidFile); } catch {}
    console.log(`not running (stale pid ${pid} removed)`);
    process.exit(0);
  }
  try { process.kill(pid, "SIGTERM"); } catch (e) {
    console.error(`failed to SIGTERM pid ${pid}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const start = Date.now();
  while (Date.now() - start < 5000) {
    await Bun.sleep(100);
    if (!isPidAlive(pid)) break;
  }
  if (isPidAlive(pid)) {
    console.warn(`pid ${pid} still alive after 5s — sending SIGKILL`);
    try { process.kill(pid, "SIGKILL"); } catch {}
    await Bun.sleep(500);
  }
  if (isPidAlive(pid)) {
    console.error(`failed to stop pid ${pid} (still alive)`);
    process.exit(1);
  }
  try { unlinkSync(pidFile); } catch {}
  console.log(`stopped (pid ${pid}) — pidfile ${pidFile} removed, port ${cfg.port} free`);
  process.exit(0);
}

async function handleStatus(cfg: { port: number }): Promise<never> {
  const pidFile = pidPath();
  let pid: number | null = null;
  let pidAlive = false;
  if (existsSync(pidFile)) {
    try {
      const s = readFileSync(pidFile, "utf-8").trim();
      const n = Number(s);
      if (Number.isFinite(n)) { pid = n; pidAlive = isPidAlive(n); }
    } catch {}
  }
  let healthOk = false;
  let workspace: string | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) healthOk = true;
  } catch {}
  if (healthOk) {
    try {
      const r = await fetch(`http://127.0.0.1:${cfg.port}/api/config`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = (await r.json()) as { workspaceRoot?: string | null };
        workspace = j.workspaceRoot ?? null;
      } else {
        const r2 = await fetch(`http://127.0.0.1:${cfg.port}/api/workspace/info`, { signal: AbortSignal.timeout(2000) });
        if (r2.ok) {
          const j2 = (await r2.json()) as { workspaceRoot?: string | null };
          workspace = j2.workspaceRoot ?? null;
        }
      }
    } catch {}
  }
  const running = healthOk;
  const out: Record<string, unknown> = { running, pid, port: cfg.port, workspace };
  if (pid !== null) out.pidAlive = pidAlive;
  console.log(JSON.stringify(out, null, 2));
  process.exit(running ? 0 : 1);
}

async function main() {
  // NotebookService owns document model, kernel session, workspace root.
  // Boot unresolved-friendly: no workspace = welcome screen; no kernel = picker prompt.
  // Single source of truth: all notebook/kernel state lives in NotebookService.
  // No legacy fallback Notebook/Kernel pair — degraded boot is handled by
  // service booting with null workspaceRoot/kernel and honest errors downstream.

  // Service starts with no workspace (welcome state) unless workspace is pinned
  // via JUPI_WORKSPACE env or ~/.jupibuddy/config.json (BRIEF §15).
  const initialWorkspace: string | null = cfg.workspaceRoot ? cfg.workspaceRoot : null;

  const service = new NotebookService({
    workspaceRoot: initialWorkspace,
    mode: cfg.mode,
  });

  // If workspace was pinned in config/env, try to open it (degraded-boot warns, never crashes)
  if (initialWorkspace) {
    try {
      await service.openWorkspace(initialWorkspace);
      console.log(`[workspace] opened: ${initialWorkspace}`);
    } catch (e) {
      console.warn(`[warn] failed to open workspace ${initialWorkspace}:`, e instanceof Error ? e.message : String(e));
      // Stay in welcome state
      service.workspaceRoot = null;
    }
  }

  // Tools wired to service — single code path through NotebookService.
  const tools = createToolsWithService(service);

  const server = startServer(cfg, tools, service);

  console.log(`JupiBuddy is running at http://localhost:${server.port}`);
  console.log(`MCP endpoint:          http://localhost:${server.port}/mcp`);
  console.log(`Kernelspecs:           http://localhost:${server.port}/api/kernelspecs`);
  console.log(`Workspace:             ${service.workspaceRoot ?? "(welcome — no workspace open)"}`);
  console.log(`Mode:                  ${service.mode} (JUPI_MODE env overrides config)`);
  const svcSpec = (service.kernel as unknown as { selectedSpec?: { pythonPath: string } } | null)?.selectedSpec;
  const kName = service.kernel?.name ?? "(no kernel — select a kernel after opening a notebook)";
  const kExtra = svcSpec ? ` (resolved: ${svcSpec.pythonPath})` : "";
  console.log(`Kernel:                ${kName}${kExtra}`);
  console.log(
    cfg.metaApiKey
      ? `Agent brain:           ${cfg.metaModel} via Meta Model API (Responses API)`
      : "Agent brain:           not configured (set META_API_KEY — see .env.example)",
  );
  if (!service.workspaceRoot) {
    console.log(`Welcome:               open http://localhost:${server.port}/ to choose a workspace`);
  }

  // Graceful shutdown: stop sidecar if present
  const shutdown = async () => {
    try { await (service.kernel as unknown as { shutdown?: () => Promise<void> })?.shutdown?.(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("Failed to start JupiBuddy:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
