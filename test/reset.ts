#!/usr/bin/env bun
// Reset machine to demo-clean state.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const args = Bun.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 3777;
const yes = args.includes("--yes");
const effectivePort = Number.isFinite(port) && port > 0 ? port : 3777;

if (!yes) {
  process.stdout.write(`Reset on port ${effectivePort}? This will kill test servers, clear sessions, remove /tmp/jupi-* . (y/N) `);
  const ans = await new Promise<string>((res) => {
    process.stdin.once("data", (d) => res(d.toString().trim()));
  });
  if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") { console.log("Aborted."); process.exit(0); }
}

// 1. Kill test servers on given port (only bun processes matching JupiBuddy)
{
  try {
    const proc = Bun.spawn(["bash", "-c", `ps aux 2>/dev/null | grep -E "bun.*(JupiBuddy|src/index)" | grep -v grep | awk '{print $2}'`], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const pids = out.split(/\s+/).map(s=>s.trim()).filter(Boolean);
    // Also try fuser/lsof for port holder
    try {
      const fuser = Bun.spawn(["fuser", "-k", `${effectivePort}/tcp`], { stdout: "pipe", stderr: "pipe" });
      await fuser.exited;
    } catch {}
    try {
      const lsof = Bun.spawn(["bash", "-c", `lsof -ti :${effectivePort} 2>/dev/null | xargs -r kill 2>/dev/null; true`], { stdout: "pipe", stderr: "pipe" });
      await lsof.exited;
    } catch {}
    if (pids.length) {
      for (const pid of pids) {
        try { process.kill(Number(pid), "SIGTERM"); } catch {}
      }
      console.log(`Killed ${pids.length} bun JupiBuddy process(es)`);
    } else console.log("No JupiBuddy bun processes found");
  } catch (e) { console.log(`kill step warn: ${String(e).slice(0,200)}`); }
}

// 2. Clear ~/.jupibuddy/sessions.json (backup to sessions.bak-<ts> first)
{
  const dir = join(homedir(), ".jupibuddy");
  const sess = join(dir, "sessions.json");
  if (existsSync(sess)) {
    const bak = join(dir, `sessions.bak-${Date.now()}`);
    try {
      const raw = await readFile(sess, "utf-8");
      await mkdir(dir, { recursive: true });
      await writeFile(bak, raw, "utf-8");
      await writeFile(sess, "[]", "utf-8");
      console.log(`Sessions backed up to ${bak} and cleared`);
    } catch (e) { console.log(`sessions clear warn: ${String(e)}`); }
  } else console.log("No sessions.json to clear");
}

// 3. Remove scratch /tmp/jupi-* dirs (durable ./tmp-test-workspaces/ is NEVER touched)
{
  let removed = 0;
  try {
    const entries = await readdir("/tmp");
    for (const e of entries) if (e.startsWith("jupi-")) { try { rmSync(join("/tmp", e), { recursive: true, force: true }); removed++; } catch {} }
  } catch {}
  console.log(`Removed ${removed} /tmp/jupi-* scratch dir(s)`);
  console.log("Left .venv and repo untouched");
}

console.log("Reset done");
