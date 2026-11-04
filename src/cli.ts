import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import {
  pidPath,
  logPath,
  isPidAlive,
  supervisorStatePath,
  readServiceState,
} from "./daemon";
import { homedir } from "node:os";
import { join } from "node:path";

type Cfg = { port: number };

const KNOWN = new Set(["status", "open", "run", "sessions", "logs", "service"]);
const SERVICE_CMDS = new Set(["start", "status", "stop", "restart", "logs"]);

function extractPort(argv: string[]): number | null {
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1] !== undefined) {
    const n = Number(argv[idx + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const eq = argv.find((a) => a.startsWith("--port="));
  if (eq) {
    const n = Number(eq.slice("--port=".length));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function withoutPort(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") {
      i++;
      continue;
    }
    if (argv[i].startsWith("--port=")) continue;
    out.push(argv[i]);
  }
  return out;
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] !== undefined && !args[idx + 1].startsWith("-")) {
    return args[idx + 1];
  }
  const eq = args.find((a) => a.startsWith(flag + "="));
  if (eq) return eq.slice(flag.length + 1);
  return undefined;
}

function removeFlag(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++;
      continue;
    }
    if (args[i].startsWith(flag + "=")) continue;
    out.push(args[i]);
  }
  return out;
}

function notRunningMsg(port: number): string {
  return `not running (port ${port} refused) — start with jupibuddy [--daemon]`;
}

function serviceNotRunningMsg(port: number): string {
  return `not running (port ${port}) — start with: jupibuddy service start`;
}

function isConnRefused(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const cause = (e as { cause?: { code?: string } })?.cause;
  if (cause?.code === "ECONNREFUSED") return true;
  return /ECONNREFUSED|fetch failed|Connection refused|ECONNRESET|port \d+ refused/i.test(msg);
}

// --- Verified start / restart (S1, S2) ---

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 10_000;

/** One /healthz probe; false on refusal, timeout, or non-2xx. */
async function probeHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll /healthz until it answers, the deadline passes, or the supervisor dies. */
async function waitForHealthy(
  port: number,
  timeoutMs = HEALTH_TIMEOUT_MS,
  supervisorPid: number | null = null,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (supervisorPid !== null && !isPidAlive(supervisorPid)) return false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (await probeHealth(port, Math.min(1500, remaining))) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await Bun.sleep(Math.min(HEALTH_POLL_INTERVAL_MS, left));
  }
}

/** Last `lines` non-empty-trailing lines of a log file (best effort). */
function tailLog(file: string, lines: number): string[] {
  try {
    const all = readFileSync(file, "utf-8").split("\n");
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/** Server child pid recorded by the supervisor that owns `wrapperPid`. */
function recordedChildPid(wrapperPid: number): number | null {
  const st = readServiceState();
  if (!st || st.wrapperPid !== wrapperPid) return null;
  return st.childPid;
}

/** Kill a supervisor child that outlived its wrapper (stuck or SIGKILLed). */
async function killRecordedChild(childPid: number | null): Promise<void> {
  if (childPid === null || !isPidAlive(childPid)) return;
  try { process.kill(childPid, "SIGTERM"); } catch { return; }
  const start = Date.now();
  while (Date.now() - start < 3000) {
    await Bun.sleep(100);
    if (!isPidAlive(childPid)) return;
  }
  try { process.kill(childPid, "SIGKILL"); } catch {}
}

export async function dispatchCli(rawArgv: string[], cfg: Cfg): Promise<void> {
  const port = extractPort(rawArgv) ?? cfg.port;
  const cleaned = withoutPort(rawArgv);
  const cmd = cleaned.find((a) => KNOWN.has(a));
  if (!cmd) {
    console.error(`unknown command: ${rawArgv.join(" ")}`);
    console.error("available: status, open <path>, run \"<task>\" [--provider X], sessions [--limit N], logs [--lines N]");
    process.exit(2);
  }
  const cmdIdx = cleaned.indexOf(cmd);
  const subArgs = cleaned.slice(cmdIdx + 1);

  switch (cmd) {
    case "status":
      await handleStatusCli(port);
      break;
    case "open":
      await handleOpen(port, subArgs);
      break;
    case "run":
      await handleRun(port, subArgs);
      break;
    case "sessions":
      await handleSessions(port, subArgs);
      break;
    case "logs":
      await handleLogs(subArgs);
      break;
    case "service":
      await handleService(port, subArgs);
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
}

async function handleService(port: number, serviceArgs: string[]): Promise<void> {
  const sub = serviceArgs[0];
  if (!sub || !SERVICE_CMDS.has(sub)) {
    console.error(`unknown service command: ${sub ?? "(none)"}`);
    console.error("available service commands: start, status, stop, restart, logs");
    console.error("usage: jupibuddy service <start|status|stop|restart|logs> [--port N] [--standalone] [--lines N]");
    process.exit(2);
  }
  const rest = serviceArgs.slice(1);
  switch (sub) {
    case "start":
      await handleServiceStart(port, rest);
      break;
    case "status":
      await handleServiceStatus(port, rest);
      break;
    case "stop":
      await handleServiceStop(port, rest);
      break;
    case "restart":
      await handleServiceRestart(port, rest);
      break;
    case "logs":
      await handleServiceLogs(rest);
      break;
  }
}

async function handleServiceStart(port: number, args: string[]): Promise<void> {
  let standalone = false;
  for (const a of args) {
    if (a === "--standalone") standalone = true;
    else if (a.startsWith("-")) {
      console.error(`unknown flag for service start: ${a}`);
      console.error("usage: jupibuddy service start [--port N] [--standalone]");
      process.exit(2);
    } else {
      console.error(`unknown argument for service start: ${a}`);
      console.error("usage: jupibuddy service start [--port N] [--standalone]");
      process.exit(2);
    }
  }
  if (standalone) {
    const url = `http://127.0.0.1:${port}`;
    console.log(url);
    console.log(`JupiBuddy service started (pid ${process.pid}) — open the URL above`);
    return;
  }
  await spawnDaemonAndPrint(port);
}

async function handleServiceStatus(port: number, args: string[]): Promise<void> {
  if (args.length > 0) {
    for (const a of args) {
      if (a.startsWith("-")) {
        console.error(`unknown flag for service status: ${a}`);
        console.error("usage: jupibuddy service status [--port N]");
        process.exit(2);
      }
    }
    console.error(`unknown argument for service status: ${args.join(" ")}`);
    console.error("usage: jupibuddy service status [--port N]");
    process.exit(2);
  }
  const pidFile = pidPath();
  let pid: number | null = null;
  if (existsSync(pidFile)) {
    try {
      const s = readFileSync(pidFile, "utf-8").trim();
      const n = Number(s);
      if (Number.isFinite(n)) pid = n;
    } catch {}
  }
  const healthOk = await probeHealth(port, 2000);
  // Supervisor record is only trusted when it belongs to the pidfile process.
  const st = readServiceState();
  const supervisorState = st && (pid === null || st.wrapperPid === pid) ? st : null;
  const childPid = supervisorState?.childPid ?? null;
  const childAlive = childPid !== null && isPidAlive(childPid);
  let workspace: string | null = null;
  if (healthOk) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = (await r.json()) as { workspaceRoot?: string | null };
        workspace = j.workspaceRoot ?? null;
      } else {
        const r2 = await fetch(`http://127.0.0.1:${port}/api/workspace/info`, { signal: AbortSignal.timeout(2000) });
        if (r2.ok) {
          const j2 = (await r2.json()) as { workspaceRoot?: string | null };
          workspace = j2.workspaceRoot ?? null;
        }
      }
    } catch {}
  }
  if (healthOk) {
    const url = `http://127.0.0.1:${port}`;
    console.log(url);
    const wsDisplay = workspace ? workspace : "(welcome)";
    if (pid !== null) console.log(`pid ${pid}, workspace ${wsDisplay}`);
    else console.log(`pid unknown, workspace ${wsDisplay}`);
    if (supervisorState) {
      const childLabel = childPid === null ? "none" : `${childPid}${childAlive ? "" : " (gone)"}`;
      console.log(`supervisor: child ${childLabel}, restarts ${supervisorState.restarts}`);
    }
    process.exit(0);
  } else if (pid !== null && isPidAlive(pid)) {
    // Wrapper is up but the server is not answering: restarting, not healthy.
    const childLabel = childPid === null ? "none" : `${childPid}${childAlive ? "" : " (gone)"}`;
    console.error(`wrapper alive (pid ${pid}), child ${childLabel} — health check failed on port ${port}`);
    if (supervisorState) {
      const serving = supervisorState.port > 0 ? `, serving port ${supervisorState.port}` : "";
      console.error(`supervisor state: ${supervisorState.state}, restarts ${supervisorState.restarts}${serving}`);
    }
    process.exit(1);
  } else {
    console.error(serviceNotRunningMsg(port));
    if (supervisorState?.state === "stopped") {
      console.error(`last supervisor run ended stopped after ${supervisorState.restarts} restarts — see: jupibuddy service logs`);
    }
    process.exit(1);
  }
}

async function handleServiceStop(port: number, args: string[]): Promise<void> {
  if (args.length > 0) {
    for (const a of args) {
      if (a.startsWith("-")) {
        console.error(`unknown flag for service stop: ${a}`);
        console.error("usage: jupibuddy service stop [--port N]");
        process.exit(2);
      }
    }
    console.error(`unknown argument for service stop: ${args.join(" ")}`);
    console.error("usage: jupibuddy service stop [--port N]");
    process.exit(2);
  }
  const pidFile = pidPath();
  if (!existsSync(pidFile)) {
    console.error(serviceNotRunningMsg(port));
    process.exit(1);
  }
  let pidStr: string;
  try {
    pidStr = readFileSync(pidFile, "utf-8").trim();
  } catch (e) {
    console.error(`failed to read pidfile ${pidFile}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const pid = Number(pidStr);
  if (!Number.isFinite(pid)) {
    console.error(`bad pidfile ${pidFile}: "${pidStr}"`);
    try { unlinkSync(pidFile); } catch {}
    console.error(serviceNotRunningMsg(port));
    process.exit(1);
  }
  if (!isPidAlive(pid)) {
    console.warn(`stale pidfile ${pidFile} (pid ${pid} not running) — removing`);
    try { unlinkSync(pidFile); } catch {}
    console.error(serviceNotRunningMsg(port));
    process.exit(1);
  }
  // The wrapper forwards SIGTERM to its child; this pid is the fallback for a
  // wrapper that was already stuck or SIGKILLed.
  const childPid = recordedChildPid(pid);
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
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
  await killRecordedChild(childPid);
  try { unlinkSync(pidFile); } catch {}
  try { unlinkSync(supervisorStatePath()); } catch {}
  console.log(`stopped.`);
  process.exit(0);
}

async function doStopIgnore(port: number): Promise<void> {
  const pidFile = pidPath();
  if (!existsSync(pidFile)) return;
  let pidStr: string;
  try { pidStr = readFileSync(pidFile, "utf-8").trim(); } catch { return; }
  const pid = Number(pidStr);
  if (!Number.isFinite(pid)) {
    try { unlinkSync(pidFile); } catch {}
    return;
  }
  if (!isPidAlive(pid)) {
    try { unlinkSync(pidFile); } catch {}
    return;
  }
  const childPid = recordedChildPid(pid);
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const start = Date.now();
  while (Date.now() - start < 5000) {
    await Bun.sleep(100);
    if (!isPidAlive(pid)) break;
  }
  if (isPidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    await Bun.sleep(500);
  }
  await killRecordedChild(childPid);
  if (!isPidAlive(pid)) {
    try { unlinkSync(pidFile); } catch {}
  }
  try { unlinkSync(supervisorStatePath()); } catch {}
}

/**
 * Spawn the supervisor (which spawns the real server) and only report success
 * once /healthz answers. On failure: kill the tree, drop the pidfile, print the
 * log tail so the owner sees WHY boot failed. S1 + S3.
 */
async function spawnDaemonAndPrint(port: number, previousPid: number | null = null): Promise<void> {
  const pidFile = pidPath();
  const logFile = logPath();
  if (existsSync(pidFile)) {
    try {
      const pidStr = readFileSync(pidFile, "utf-8").trim();
      const pid = Number(pidStr);
      if (Number.isFinite(pid) && isPidAlive(pid)) {
        const url = `http://127.0.0.1:${port}`;
        console.error(`already running (pid ${pid}) at ${url} — pidfile ${pidFile} exists`);
        console.error(url);
        process.exit(1);
      } else {
        console.warn(`stale pidfile ${pidFile} (pid ${pidStr} not running) — overwriting`);
      }
    } catch {
      console.warn(`stale pidfile ${pidFile} unreadable — overwriting`);
    }
  }
  // A listener we did not spawn is never shadowed, killed, or mistaken for ours.
  if (await probeHealth(port)) {
    console.error(`port ${port} already in use by a non-service process — stop it or choose another --port`);
    process.exit(1);
  }
  try { mkdirSync(join(homedir(), ".jupibuddy"), { recursive: true }); } catch {}
  const entry = (Bun.argv[1] ?? process.argv[1] ?? join(import.meta.dir, "index.ts")) as string;
  const supervisor = join(import.meta.dir, "supervise.ts");
  let fd: number;
  try { fd = openSync(logFile, "a"); } catch (e) {
    console.error(`failed to open log ${logFile}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["bun", supervisor, "--port", String(port), "--entry", entry], {
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
  } catch (e) {
    console.error(`failed to spawn supervisor: ${e instanceof Error ? e.message : String(e)}`);
    try { closeSync(fd); } catch {}
    process.exit(1);
  }
  try { writeFileSync(pidFile, String(proc.pid), "utf-8"); } catch (e) {
    console.error(`failed to write pidfile ${pidFile}: ${e instanceof Error ? e.message : String(e)}`);
    try { proc.kill(); } catch {}
    try { closeSync(fd); } catch {}
    process.exit(1);
  }
  try { closeSync(fd); } catch {}
  const url = `http://127.0.0.1:${port}`;
  if (!(await waitForHealthy(port, HEALTH_TIMEOUT_MS, proc.pid))) {
    // Never leave a pidfile pointing at a dead tree.
    try { proc.kill(); } catch {}
    await Bun.sleep(500);
    if (isPidAlive(proc.pid)) { try { proc.kill("SIGKILL"); } catch {} }
    await killRecordedChild(recordedChildPid(proc.pid));
    try {
      if (readFileSync(pidFile, "utf-8").trim() === String(proc.pid)) unlinkSync(pidFile);
    } catch {}
    try { unlinkSync(supervisorStatePath()); } catch {}
    console.error(
      `service failed to become healthy at ${url} — stopped pid ${proc.pid}, pidfile removed`,
    );
    const tail = tailLog(logFile, 15);
    if (tail.length === 0) {
      console.error(`no output in ${logFile}`);
    } else {
      console.error(`last ${tail.length} lines of ${logFile}:`);
      for (const line of tail) console.error(`  ${line}`);
    }
    process.exit(1);
  }
  console.log(url);
  if (previousPid !== null) {
    console.log(`restarted (old pid ${previousPid} → new pid ${proc.pid})`);
  } else {
    console.log(`JupiBuddy service started (pid ${proc.pid}) — open the URL above`);
  }
  process.exit(0);
}

async function handleServiceRestart(port: number, args: string[]): Promise<void> {
  let standalone = false;
  for (const a of args) {
    if (a === "--standalone") standalone = true;
    else if (a.startsWith("-")) {
      console.error(`unknown flag for service restart: ${a}`);
      console.error("usage: jupibuddy service restart [--port N] [--standalone]");
      process.exit(2);
    } else {
      console.error(`unknown argument for service restart: ${a}`);
      console.error("usage: jupibuddy service restart [--port N] [--standalone]");
      process.exit(2);
    }
  }
  if (standalone) {
    await doStopIgnore(port);
    const url = `http://127.0.0.1:${port}`;
    console.log(url);
    console.log(`JupiBuddy service started (pid ${process.pid}) — open the URL above`);
    return;
  }
  // S2: only ever stop a process this service started (pidfile → wrapper).
  const pidFile = pidPath();
  let oldPid: number | null = null;
  if (existsSync(pidFile)) {
    try {
      const n = Number(readFileSync(pidFile, "utf-8").trim());
      if (Number.isFinite(n) && isPidAlive(n)) oldPid = n;
    } catch {}
  }
  if (oldPid !== null) {
    const st = readServiceState();
    const oldPort = st && st.wrapperPid === oldPid ? st.port : null;
    if (oldPort !== null && oldPort !== port) {
      console.error(
        `service already running for port ${oldPort} (pid ${oldPid}) — one service per machine, stop it first: jupibuddy service stop`,
      );
      process.exit(1);
    }
  }
  if (oldPid === null && (await probeHealth(port))) {
    console.error(
      `port ${port} held by non-service process (pid ?) — start a fresh service on --port N or stop yours first`,
    );
    process.exit(1);
  }
  await doStopIgnore(port);
  await spawnDaemonAndPrint(port, oldPid);
}

async function handleServiceLogs(args: string[]): Promise<void> {
  await handleLogs(args);
}

async function handleStatusCli(port: number): Promise<void> {
  const pidFile = pidPath();
  let pid: number | null = null;
  let pidAlive = false;
  if (existsSync(pidFile)) {
    try {
      const s = readFileSync(pidFile, "utf-8").trim();
      const n = Number(s);
      if (Number.isFinite(n)) {
        pid = n;
        pidAlive = isPidAlive(n);
      }
    } catch {}
  }
  let healthOk = false;
  let workspace: string | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) healthOk = true;
  } catch {}
  if (healthOk) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = (await r.json()) as { workspaceRoot?: string | null };
        workspace = j.workspaceRoot ?? null;
      } else {
        const r2 = await fetch(`http://127.0.0.1:${port}/api/workspace/info`, { signal: AbortSignal.timeout(2000) });
        if (r2.ok) {
          const j2 = (await r2.json()) as { workspaceRoot?: string | null };
          workspace = j2.workspaceRoot ?? null;
        }
      }
    } catch {}
  }
  const running = healthOk;
  const out: Record<string, unknown> = { running, pid, port, workspace };
  // include pidAlive for extra honesty
  if (pid !== null) (out as Record<string, unknown>).pidAlive = pidAlive;
  console.log(JSON.stringify(out, null, 2));
  process.exit(running ? 0 : 1);
}

async function handleOpen(port: number, subArgs: string[]): Promise<void> {
  // open expects <path>
  if (subArgs.length === 0 || subArgs[0].startsWith("-")) {
    console.error("usage: jupibuddy open <path> [--port N]");
    process.exit(2);
  }
  const pathArg = subArgs[0];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workspace/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: pathArg }),
    });
    const txt = await res.text();
    let data: unknown;
    try { data = JSON.parse(txt); } catch { data = txt; }
    if (!res.ok) {
      console.error(`open failed: ${res.status} ${txt.slice(0, 600)}`);
      process.exit(1);
    }
    const obj = data as { workspaceRoot?: string; path?: string };
    if (obj.workspaceRoot) console.log(obj.workspaceRoot);
    else console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  } catch (e) {
    if (isConnRefused(e)) {
      console.error(notRunningMsg(port));
      process.exit(1);
    }
    console.error(`open error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function handleRun(port: number, subArgs: string[]): Promise<void> {
  if (subArgs.length === 0) {
    console.error('usage: jupibuddy run "<task>" [--provider X] [--port N]');
    console.error("Note: CLI v1 is non-streaming; for live output use web UI or Accept: text/event-stream");
    process.exit(2);
  }
  // extract --provider
  let provider: string | undefined = getFlagValue(subArgs, "--provider");
  subArgs = removeFlag(subArgs, "--provider");
  // task is remaining args joined (handles both quoted single arg and unquoted multiple words)
  if (subArgs.length === 0) {
    console.error('run: <task> is required');
    process.exit(2);
  }
  const task = subArgs.join(" ");
  if (!task.trim()) {
    console.error('run: <task> is required');
    process.exit(2);
  }
  try {
    const body: Record<string, string> = { task };
    if (provider) body.provider = provider;
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    let data: Record<string, unknown>;
    try { data = JSON.parse(txt) as Record<string, unknown>; } catch { data = { raw: txt }; }
    if (!res.ok) {
      // try to show error detail
      console.error(`run failed: ${res.status} ${txt.slice(0, 800)}`);
      process.exit(1);
    }
    const ok = data.ok as boolean | undefined;
    const steps = data.steps as number | undefined;
    const prov = (data.provider as string | undefined) ?? provider ?? "";
    const model = data.model as string | undefined;
    const summary = (data.summary as string | undefined) ?? "";
    console.log(`ok: ${ok}`);
    console.log(`steps: ${steps ?? ""}`);
    console.log(`provider: ${prov}${model ? "/" + model : ""}`);
    console.log(`summary: ${summary}`);
    // also print full JSON for debugging
    console.log(JSON.stringify(data, null, 2));
    console.log("Note: CLI v1 non-streaming only; for live output use web UI");
    process.exit(0);
  } catch (e) {
    if (isConnRefused(e)) {
      console.error(notRunningMsg(port));
      process.exit(1);
    }
    console.error(`run error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function handleSessions(port: number, subArgs: string[]): Promise<void> {
  let limitStr = getFlagValue(subArgs, "--limit");
  if (limitStr !== undefined) {
    const n = Number(limitStr);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("sessions: --limit requires positive number");
      process.exit(2);
    }
  }
  // remove limit flag for cleanliness (though no other args expected)
  subArgs = removeFlag(subArgs, "--limit");
  if (subArgs.length > 0) {
    console.error("usage: jupibuddy sessions [--limit N] [--port N]");
    process.exit(2);
  }
  const limit = limitStr ? Number(limitStr) : 10;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/sessions`, { signal: AbortSignal.timeout(5000) });
    const txt = await res.text();
    if (!res.ok) {
      console.error(`sessions failed: ${res.status} ${txt.slice(0, 600)}`);
      process.exit(1);
    }
    let data: { sessions?: Array<{ id: string; task: string; steps: number; ok: boolean; provider: string; model?: string }> };
    try { data = JSON.parse(txt); } catch { data = { sessions: [] }; }
    const sessions = data.sessions ?? [];
    const sliced = sessions.slice(0, limit);
    if (sliced.length === 0) {
      console.log("no sessions");
      process.exit(0);
    }
    for (const s of sliced) {
      const taskPreview = (s.task ?? "").slice(0, 80).replace(/\n/g, " ");
      const prov = s.provider + (s.model ? "/" + s.model : "");
      console.log(`${s.id} | task: ${taskPreview} | steps: ${s.steps} | ok: ${s.ok} | provider: ${prov}`);
    }
    process.exit(0);
  } catch (e) {
    if (isConnRefused(e)) {
      console.error(notRunningMsg(port));
      process.exit(1);
    }
    console.error(`sessions error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function handleLogs(subArgs: string[]): Promise<void> {
  let linesStr = getFlagValue(subArgs, "--lines");
  subArgs = removeFlag(subArgs, "--lines");
  if (subArgs.length > 0) {
    console.error("usage: jupibuddy logs [--lines N] [--port N]");
    process.exit(2);
  }
  let lines = 100;
  if (linesStr !== undefined) {
    const n = Number(linesStr);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("logs: --lines requires positive number");
      process.exit(2);
    }
    lines = n;
  }
  const lp = logPath();
  if (!existsSync(lp)) {
    console.log(`no log at ${lp}`);
    process.exit(0);
  }
  try {
    const content = readFileSync(lp, "utf-8");
    const all = content.split("\n");
    // remove trailing empty line if file ends with newline for clean tail
    const tail = all.slice(-lines).join("\n");
    console.log(tail);
    process.exit(0);
  } catch (e) {
    console.error(`logs error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
