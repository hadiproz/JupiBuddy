#!/usr/bin/env bun
// Re-checks a fresh run against ground-truth.json and reports PASS/FAIL per assertion.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const args = Bun.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? Number(args[portIdx+1]) : 3777;
const effPort = Number.isFinite(port) && port>0 ? port:3777;
const base = `http://127.0.0.1:${effPort}`;

async function j(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { method, headers:{ "content-type":"application/json"}, body: body?JSON.stringify(body):undefined });
  const txt = await res.text(); let data: unknown; try{data=JSON.parse(txt);}catch{data=txt;}
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${txt.slice(0,600)}`);
  return data;
}

const gtPath = join(import.meta.dir, "ground-truth.json");
let gt: unknown;
try { gt = JSON.parse(await readFile(gtPath,"utf-8")); } catch { console.log(`FAIL load ground-truth.json: not found at ${gtPath}`); process.exit(1); }
const g = gt as { expectedOutputs:string[]; notebookCells:number; workspaceFiles:string[]; sessionSummaryContains:string[]; withAgent:boolean; };

type Result = { name:string; pass:boolean; detail:string };
const results: Result[] = [];

function check(name:string, pass:boolean, detail:string){ results.push({name,pass,detail}); }

// healthz
try { const h=await j("GET","/healthz") as {ok:boolean}; check("healthz", !!h.ok, String(h.ok)); } catch(e){ check("healthz", false, String(e).slice(0,200)); }
// workspace files
try { const r=await j("GET","/api/workspace/files") as {entries: Array<{name:string}>};
  const names=r.entries.map(e=>e.name).sort();
  // ground truth files must be subset of current (fixture.csv at least)
  const missing=(g.workspaceFiles as string[]).filter(n=>!names.includes(n));
  check("workspaceFiles", missing.length===0, missing.length?`missing ${missing.join(",")}`:`found ${names.length}`);
} catch(e){ check("workspaceFiles", false, String(e).slice(0,200)); }
// notebook cells
try { const c=await j("GET","/api/notebook/content") as {cells: Array<{source:string; outputs: Array<{text:string}>}>};
  check("notebookCells", c.cells.length >= (g.notebookCells as number), `have ${c.cells.length} expected >=${g.notebookCells}`);
  const allText=c.cells.flatMap(c=>c.outputs.map(o=>o.text)).join("\n");
  const hit=(g.expectedOutputs as string[]).some(s=> allText.includes(s));
  check("expectedOutputs", hit, hit?`matched one of ${(g.expectedOutputs as string[]).join("|")}`:"no expected output found");
} catch(e){ check("notebookCells", false, String(e).slice(0,200)); check("expectedOutputs", false, String(e).slice(0,200)); }
// session summary if withAgent
if (g.withAgent && Array.isArray(g.sessionSummaryContains) && (g.sessionSummaryContains as string[]).length){
  try { const s=await j("GET","/api/agent/sessions") as {sessions: Array<{summary:string}>};
    const need=g.sessionSummaryContains as string[];
    // Any session may contain the required substrings (fake stub produces deterministic summary)
    const hit = s.sessions.some(sess => need.every(k => (sess.summary ?? "").includes(k)));
    const preview = s.sessions[0]?.summary?.slice(0,120) ?? "";
    check("sessionSummaryContains", hit, hit?`found session with ${need.join(",")}`:`no session contains ${need.join(",")} (latest: "${preview}")`);
  } catch(e){ check("sessionSummaryContains", false, String(e).slice(0,200)); }
} else {
  // no expectation (offline mode or live agent with free-form summary), mark as pass
  check("sessionSummaryContains", true, "skipped (no fixed expectation)");
}

let fails=0;
for (const r of results){ console.log(`${r.pass?"PASS":"FAIL"} ${r.name}: ${r.detail}`); if(!r.pass) fails++; }
console.log(fails? `\n${fails} assertion(s) FAILED` : "\nAll assertions PASS");
process.exit(fails?1:0);
