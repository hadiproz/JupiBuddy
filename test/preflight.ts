#!/usr/bin/env bun
// Preflight checks before any demo run. Prints PASS/FAIL per check, exit 1 if any FAIL.

import { existsSync } from "node:fs";
import { access, mkdir, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

type Check = { name: string; pass: boolean; detail: string };

const args = Bun.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 3777;

function parsePortFlag(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 3777;
}
const effectivePort = parsePortFlag(port);

const checks: Check[] = [];

// 1. bun check clean
{
  const proc = Bun.spawn(["bun", "check"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  const ok = proc.exitCode === 0;
  checks.push({ name: "bun check", pass: ok, detail: ok ? "clean" : (out + err).slice(0, 600) });
}

// 2. port free
{
  let pass = false; let detail = "";
  try {
    const srv = Bun.serve({ port: effectivePort, hostname: "127.0.0.1", fetch() { return new Response("ok"); } });
    pass = true; detail = `port ${effectivePort} free`;
    srv.stop(true);
  } catch (e) {
    pass = false; detail = `port ${effectivePort} in use: ${e instanceof Error ? e.message : String(e)}`;
  }
  checks.push({ name: "port free", pass, detail });
}

// 3. python sidecar present (JUPI_PYTHON or auto-resolved, import jupyter_server + ipykernel)
{
  let pythonPath = process.env.JUPI_PYTHON ?? Bun.env.JUPI_PYTHON ?? "";
  if (!pythonPath) {
    // auto-resolve: prefer workspace .venv then PATH
    const ws = process.env.JUPI_WORKSPACE ?? Bun.env.JUPI_WORKSPACE ?? "";
    if (ws && existsSync(join(ws, ".venv", "bin", "python"))) pythonPath = join(ws, ".venv", "bin", "python");
    if (!pythonPath && existsSync(join(homedir(), "JupiBuddy", ".venv", "bin", "python"))) pythonPath = join(homedir(), "JupiBuddy", ".venv", "bin", "python");
    if (!pythonPath) pythonPath = "python3";
  }
  let pass = false; let detail = `python=${pythonPath}`;
  try {
    const proc = Bun.spawn([pythonPath, "-c", "import jupyter_server; import ipykernel; print('ok')"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const er = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode === 0 && out.includes("ok")) { pass = true; detail += " import jupyter_server+ipykernel ok"; }
    else detail += ` FAIL: ${er.slice(0,400)}`;
  } catch (e) { detail += ` error: ${String(e).slice(0,200)}`; }
  checks.push({ name: "python sidecar", pass, detail });
}

// 4. Baseten key present (env only, never log value)
{
  const v = Bun.env.BASETEN_API_KEY ?? process.env.BASETEN_API_KEY ?? "";
  const hasKey = !!(v && v.length > 0);
  checks.push({ name: "Baseten key", pass: true, detail: `hasKey=${hasKey}` });
  // This check is informational: PASS always, detail shows hasKey true/false
}

// 5. workspace dir exists/writable
{
  const ws = resolve(process.env.JUPI_WORKSPACE ?? Bun.env.JUPI_WORKSPACE ?? homedir());
  let pass = false; let detail = `workspace=${ws}`;
  try {
    await mkdir(ws, { recursive: true });
    await access(ws);
    // probe writable
    const probe = join(ws, ".jupi-preflight-probe");
    await writeFile(probe, "probe", "utf-8");
    await unlink(probe);
    pass = true; detail += " writable";
  } catch (e) { detail += ` FAIL: ${String(e).slice(0,300)}`; }
  checks.push({ name: "workspace dir", pass, detail });
}

let failed = 0;
for (const c of checks) {
  console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  if (!c.pass) failed++;
}
if (failed) console.log(`\n${failed} check(s) FAILED`);
else console.log("\nAll checks PASS");
process.exit(failed ? 1 : 0);
