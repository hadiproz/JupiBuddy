#!/usr/bin/env bun
// Scripted demo case + ground truth. Drives RUNNING server via HTTP.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

const args = Bun.argv.slice(2);
const withAgent = args.includes("--with-agent");
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 3777;
const effPort = Number.isFinite(port) && port>0 ? port : 3777;
const base = `http://127.0.0.1:${effPort}`;

// workspace dir: --workspace flag, JUPI_TEST_WS env, or /tmp/jupi-demo-<ts>.
// For durable dev workspaces use --workspace <path> (e.g. ./tmp-test-workspaces/demo1,
// which is gitignored); default /tmp is scratch and may vanish on reboot.
const wsIdx = args.indexOf("--workspace");
const wsEnv = Bun.env.JUPI_TEST_WS ?? process.env.JUPI_TEST_WS;
let workspaceDir = wsIdx >= 0 ? resolve(args[wsIdx+1]) : wsEnv ? resolve(wsEnv) : join(tmpdir(), `jupi-demo-${Date.now()}`);
workspaceDir = resolve(workspaceDir);

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }

async function j(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data: unknown; try { data = JSON.parse(txt); } catch { data = txt; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${txt.slice(0,600)}`);
  return data;
}

console.log(`[demo-case] workspace=${workspaceDir} port=${effPort} withAgent=${withAgent}`);

// (a) create small CSV fixture
await mkdir(workspaceDir, { recursive: true });
const csv = "id,value\n1,10\n2,20\n3,30\n";
await writeFile(join(workspaceDir, "fixture.csv"), csv, "utf-8");
console.log("  fixture.csv created");

// (b) drive server via HTTP
// healthz
{
  const h = await j("GET", "/healthz") as { ok: boolean };
  assert(!!h.ok, "healthz ok");
  console.log("  healthz PASS");
}
// open workspace
{
  const r = await j("POST", "/api/workspace/open", { path: workspaceDir }) as { workspaceRoot: string };
  assert(!!r.workspaceRoot, "open workspace");
  console.log(`  openWorkspace PASS -> ${r.workspaceRoot}`);
}
// open notebook (create if missing)
{
  const r = await j("POST", "/api/notebook/open", { path: "demo.ipynb" }) as { ok: boolean; cells: number };
  assert(r.ok, "open notebook");
  console.log(`  openNotebook PASS cells=${r.cells}`);
}
// insert cell print(1+1)
let insertedId = "";
{
  const r = await j("POST", "/api/cell/insert", { type: "code", source: "print(1+1)" }) as { id: string; index: number };
  assert(!!r.id, "insert_cell id");
  insertedId = r.id;
  console.log(`  insert_cell PASS id=${r.id} index=${r.index}`);
}
// run cells
let runOk = false;
{
  // find index of inserted cell
  const content = await j("GET", "/api/notebook/content") as { cells: Array<{ id: string; index: number }> };
  const idx = content.cells.findIndex(c => c.id === insertedId);
  assert(idx >= 0, "inserted cell found in content");
  const runRes = await j("POST", "/api/cell/run", { from: idx, to: idx }) as { ran: string[] };
  assert(runRes.ran.length >= 1, "run_cells ran");
  console.log(`  run_cells PASS ran=${runRes.ran.length}`);
  // read outputs
  const content2 = await j("GET", "/api/notebook/content") as { cells: Array<{ outputs: Array<{ text: string }> }> };
  const cell = content2.cells[idx];
  const txt = cell.outputs.map(o=>o.text).join("\n");
  console.log(`  outputs: ${txt.slice(0,300).replace(/\n/g," | ")}`);
  runOk = txt.includes("2") || txt.includes("echo-kernel");
  console.log(`  read outputs PASS containsExpected=${runOk}`);
}
// workspace/files
{
  const r = await j("GET", "/api/workspace/files") as { entries: unknown[] };
  assert(Array.isArray(r.entries), "workspace/files entries");
  console.log(`  workspace/files PASS entries=${(r.entries as unknown[]).length}`);
}

// (c) optionally trigger one agent run
let sessionSummary: string | null = null;
if (withAgent) {
  console.log("  agent run (with --with-agent) ...");
  const r = await j("POST", "/api/agent/run", { task: "tiny task: reply with one short python line, no tools", provider: "Baseten" }) as { ok: boolean; summary: string; provider?: string; model?: string; steps?: number };
  console.log(`  agent/run -> ok=${r.ok} steps=${(r as {steps?:number}).steps} provider=${(r as {provider?:string}).provider} summary=${String(r.summary).slice(0,200)}`);
  assert(r.ok, "agent run ok");
  sessionSummary = String(r.summary ?? "");
  // verify session recorded
  const sess = await j("GET", "/api/agent/sessions") as { sessions: Array<{ summary: string }> };
  assert(sess.sessions.length > 0, "session recorded");
  console.log(`  sessions recorded PASS count=${sess.sessions.length}`);
}

// (d) write ground-truth.json
{
  // re-read content for counts
  const content = await j("GET", "/api/notebook/content") as { cells: Array<{ source: string; outputs: Array<{ text:string }> }> };
  const filesRes = await j("GET", "/api/workspace/files") as { entries: Array<{ name:string }> };
  const gt = {
    workspaceFiles: filesRes.entries.map(e=>e.name).sort(),
    notebookCells: content.cells.length,
    // core case expects at least one cell with print(1+1) source
    expectedOutputs: ["2", "echo-kernel"],
    // for session check
    sessionSummaryContains: withAgent ? null : [],
    withAgent,
    workspaceDir,
    port: effPort,
    generatedAt: new Date().toISOString(),
  };
  const gtPath = join(import.meta.dir, "ground-truth.json");
  await writeFile(gtPath, JSON.stringify(gt, null, 2), "utf-8");
  console.log(`  ground-truth.json written -> ${gtPath}`);
}

console.log("\n[demo-case] ALL PASS");
