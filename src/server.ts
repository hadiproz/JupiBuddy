// HTTP server — the one Bun-native seam of the app.
//
// Everything Bun-specific (Bun.serve, file serving) is isolated in this
// module and src/index.ts; the notebook, MCP, and agent modules are plain
// TypeScript. If a runtime port is ever needed, this is the file that
// changes (see the Bun-native vs Node-compliant discussion in BRIEF.md).

import { join, resolve } from "node:path";
import { readdir, stat, mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { JupiConfig } from "./config";
import { runAgent, runAgentStreaming } from "./agent/loop";
import { createMcpHandler } from "./mcp/server";
import type { ToolDef } from "./mcp/tools";
import type { NotebookService } from "./notebook/service";
import { lastRunSuccess } from "./notebook/notebook";
import { randomUUID } from "node:crypto";
import {
  EFFORT_BY_PROVIDER,
  getProviderDisplayLabel,
  normalizeProviderInput,
  resolveProvider,
  suggestCompletion,
  validateEffort,
  type ProviderId,
} from "./agent/providers";
import { createTerminal, type TerminalSession } from "./terminal";
import { TranscriptWriter, renderTranscriptMarkdown, loadTranscriptHistory } from "./transcript";

// --- Session store: ~/.jupibuddy/sessions.json (capped at 50) ---
// Keeps raw {provider, model} — display label is derived via getProviderDisplayLabel().
export interface SessionEntry {
  id: string;
  task: string;
  title?: string;
  steps: number;
  ok: boolean;
  summary: string;
  provider: string;
  model?: string;
  label?: string;
  time: string;
  compacted?: boolean;
  turnsDropped?: number;
  streamed?: boolean;
  cancelled?: boolean;
  steered?: boolean;
  queued?: boolean;
  approvals?: Array<{ tool: string; decision: string }>;
  stuck?: boolean;
  attachmentIds?: string[];
  transcript?: string;
  effort?: string;
}
function sessionsPath(): string {
  return join(homedir(), ".jupibuddy", "sessions.json");
}
async function loadSessions(): Promise<SessionEntry[]> {
  try {
    const raw = await readFile(sessionsPath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SessionEntry[]) : [];
  } catch {
    return [];
  }
}
async function saveSessions(list: SessionEntry[]): Promise<void> {
  try {
    await mkdir(join(homedir(), ".jupibuddy"), { recursive: true });
    await writeFile(sessionsPath(), JSON.stringify(list.slice(0, 50), null, 2), "utf-8");
  } catch {
    // ignore
  }
}
async function appendSession(entry: SessionEntry): Promise<void> {
  const list = await loadSessions();
  list.unshift(entry);
  await saveSessions(list.slice(0, 50));
}

function sessionsDir(): string {
  return join(homedir(), ".jupibuddy", "sessions");
}

function tryCreateTranscriptWriter(runId: string, task: string, providerRaw: string, service: NotebookService | null | undefined, label?: string, effort?: string): TranscriptWriter | null {
  try {
    const cwd = service?.workspaceRoot ?? (Bun.env.JUPI_WORKSPACE as string | undefined) ?? (process.env.JUPI_WORKSPACE as string | undefined) ?? "";
    let provider = providerRaw || "Meta";
    let model = "";
    // Try to resolve model honestly via provider resolution; fallback to raw provider for fake/no-key cases
    try {
      const p = resolveProvider(providerRaw || "Meta");
      provider = p.id;
      model = p.model;
    } catch {
      // No key — keep raw values; still write transcript with raw provider
      model = providerRaw ? `${providerRaw}-model` : "";
      if (providerRaw === "fake" || providerRaw === "fake-model-stub") {
        provider = "fake";
        model = "fake-model-stub";
      }
    }
    const dir = sessionsDir();
    const writer = new TranscriptWriter({ dir, sessionId: runId, sessionMeta: { cwd, provider, model, task, label, ...(effort ? { effort } : {}) } });
    if (writer.isDisabled) return null;
    return writer;
  } catch (e) {
    console.warn(`[transcript] writer creation failed for ${runId}:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

// --- Ghost completion budgets (POST /api/complete/ghost) ---
const GHOST_MAX_CODE_CHARS = 4000;
const GHOST_RATE_LIMIT = 10;
const GHOST_RATE_WINDOW_MS = 60_000;
const GHOST_TIMEOUT_MS = 15_000;
const GHOST_MAX_GHOST_CHARS = 500;

// --- WS terminal connection state (one PTY per WebSocket, v1) ---
interface TerminalWsData {
  session: TerminalSession;
  ws: Bun.ServerWebSocket<TerminalWsData> | null;
  /** Output produced between spawn and the WS `open` event. */
  pending: string[];
  exited: boolean;
  exitCode: number | null;
}

// --- Terminal WS auth (A6-2): per-boot token + Origin check ---
// Mirrors jupyter_server services/kernels/websocket.py:36-45,61 (authorize + ws_authenticated).
// Token is generated once per process boot via crypto.randomUUID(), logged once, and
// required on every WS upgrade via ?token=, Authorization, or Sec-WebSocket-Protocol.
function isAllowedTerminalOrigin(origin: string | null): boolean {
  if (!origin) return true; // non-browser clients (curl, Bun WS) omit Origin
  if (origin === "null") return false;
  try {
    const raw = new URL(origin).hostname;
    const host = raw.replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function isTerminalAuthorized(req: Request, url: URL, expected: string): boolean {
  const qp = url.searchParams.get("token");
  if (qp && qp === expected) return true;
  const auth = req.headers.get("authorization");
  if (auth) {
    let cand = auth.trim();
    const m = cand.match(/^(?:Bearer|Token)\s+(.+)$/i);
    if (m) cand = m[1].trim();
    if (cand === expected) return true;
  }
  const proto = req.headers.get("sec-websocket-protocol");
  if (proto) {
    const parts = proto.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.includes(expected)) return true;
    if (proto.trim() === expected) return true;
  }
  return false;
}

export function startServer(
  cfg: JupiConfig,
  tools: ToolDef[],
  service?: NotebookService | null,
) {
  const mcp = createMcpHandler(tools, service ?? undefined);
  const pagePath = join(import.meta.dir, "web", "index.html");
  // Sliding window of ghost-completion timestamps (10 req/min per process).
  const ghostHits: number[] = [];
  // Per-boot terminal token (A6-2): single value for the life of the process.
  const terminalToken = (Bun.env.JUPI_TERMINAL_TOKEN as string | undefined) ?? randomUUID();
  console.log(
    `[terminal] per-boot token ${terminalToken} — WS /api/terminal requires ?token=<token> (also accepted: Sec-WebSocket-Protocol or Authorization: Bearer <token>); Origin allowed: 127.0.0.1, localhost, ::1`,
  );

  const server = Bun.serve<TerminalWsData>({
    port: cfg.port,
    hostname: "127.0.0.1", // localhost only — this is a local workshop tool

    // --- WS terminal: GET /api/terminal?cols=&rows= (Upgrade) ---
    // Contract (documented for the frontend worker):
    //   client -> server: {type:"input", data:string} | {type:"resize", cols:number, rows:number}
    //   server -> client: {type:"output", data:string} | {type:"exit", code:number}
    // One PTY per connection (v1, no multi-session); the PTY is killed when
    // the socket closes. Text frames only — binary frames are ignored.
    websocket: {
      open(ws) {
        ws.data.ws = ws;
        for (const chunk of ws.data.pending.splice(0)) {
          try {
            ws.send(JSON.stringify({ type: "output", data: chunk }));
          } catch {
            break;
          }
        }
        if (ws.data.exited) {
          try {
            ws.send(JSON.stringify({ type: "exit", code: ws.data.exitCode ?? -1 }));
          } catch {
            // socket already gone
          }
          try {
            ws.close(1000, "process exited");
          } catch {
            // already closing
          }
        }
      },
      message(ws, message) {
        if (typeof message !== "string") return; // v1: text frames only
        let parsed: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
        try {
          parsed = JSON.parse(message) as typeof parsed;
        } catch {
          return; // ignore malformed frames — no crash
        }
        if (parsed.type === "input" && typeof parsed.data === "string") {
          ws.data.session.write(parsed.data);
        } else if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
          ws.data.session.resize(parsed.cols, parsed.rows);
        }
      },
      close(ws) {
        ws.data.session.kill();
        ws.data.ws = null;
      },
    },

    async fetch(req, srv) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === "/" && req.method === "GET") {
        return new Response(Bun.file(pagePath), {
          // Never serve a stale app shell: always revalidate with the daemon.
          // (No service worker by design — see HANDOFF; this header is the
          // whole freshness story.)
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        });
      }

      if (pathname === "/mcp" && (req.method === "GET" || req.method === "DELETE")) {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      if (pathname === "/mcp" && req.method === "POST") {
        return mcp(req);
      }

      // Proxy kernelspec list from the sidecar / discovery (BRIEF §13: GET /api/kernelspecs)
      // Single source of truth: ALWAYS full local discovery (conda + PATH + kernelspecs).
      // Sidecar kernelspecs are merged in (they reflect the RUNNING server's view) but
      // never replace discovery — otherwise the picker shrinks to the sidecar's 2
      // entries the moment a kernel starts (2026-11-02 incident: 6 -> 2).
      if (pathname === "/api/kernelspecs" && req.method === "GET") {
        try {
          const { resolveCandidates } = await import("./notebook/kernelResolve");
          const wsRoot = service?.workspaceRoot ?? cfg.workspaceRoot;
          const cands = await resolveCandidates({ workspaceRoot: wsRoot });
          const merged: Record<string, unknown> = Object.fromEntries(
            cands.map((c) => [c.name, { name: c.name, spec: { display_name: c.displayName, argv: [c.pythonPath] } }]),
          );
          let note: string | undefined;
          const activeKernel = service?.kernel ?? null;
          if (activeKernel?.listKernelspecs) {
            try {
              const specs = (await activeKernel.listKernelspecs()) as { kernelspecs?: Record<string, { name?: string; spec?: { display_name?: string; argv?: string[] } }> };
              for (const [k, v] of Object.entries(specs?.kernelspecs ?? {})) {
                if (!merged[k]) merged[k] = v;
              }
            } catch {
              note = "sidecar unavailable — showing discovered interpreters only";
            }
          }
          return Response.json({
            kernelspecs: merged,
            default: cands[0]?.name ?? null,
            ...(note ? { _note: note } : {}),
          });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      }

      // --- Workspace & notebook HTTP API (S2) ---

      if (pathname === "/api/workspace/info" && req.method === "GET") {
        if (!service) return Response.json({ workspaceRoot: null, hasNotebook: false, mode: cfg.mode });
        const state = service.getState();
        return Response.json({
          workspaceRoot: state.workspaceRoot,
          notebookPath: state.notebookPath,
          hasNotebook: state.hasNotebook,
          cellCount: state.cellCount,
          dirty: state.dirty,
          kernel: state.kernel,
          kernelState: state.kernelState,
          mode: state.mode,
          configMode: cfg.mode,
          revision: service.revision ?? state.revision ?? 0,
        });
      }

      if (pathname === "/api/mode" && req.method === "POST") {
        try {
          const body = (await req.json()) as { mode?: string };
          const allowed = ["chat-only", "mcp-only", "hybrid"] as const;
          if (!body.mode || !(allowed as readonly string[]).includes(body.mode)) {
            return Response.json({ error: `invalid mode: ${String(body.mode)} — must be chat-only, mcp-only, or hybrid` }, { status: 400 });
          }
          const mode = body.mode as typeof allowed[number];
          if (service) service.mode = mode as typeof service.mode;
          return Response.json({ ok: true, mode, configMode: cfg.mode, note: "runtime override — JUPI_MODE/config-file remain boot default, restart restores" });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/workspace/list" && req.method === "GET") {
        const reqPath = url.searchParams.get("path") ?? homedir();
        const abs = resolve(reqPath);
        try {
          const st = await stat(abs);
          if (!st.isDirectory()) {
            return Response.json({ error: `not a directory: ${abs}` }, { status: 400 });
          }
          const filter = url.searchParams.get("filter");
          const items = await readdir(abs, { withFileTypes: true });
          let entries = items
            .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), path: join(abs, e.name) }))
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          if (filter === "ipynb") {
            entries = entries.filter((e) => e.isDirectory || e.name.endsWith(".ipynb"));
          }
          const writableRoots = [homedir(), "/tmp"];
          if (service?.workspaceRoot && !writableRoots.includes(service.workspaceRoot)) {
            writableRoots.unshift(service.workspaceRoot);
          }
          return Response.json({ path: abs, entries, writableRoots });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      }

      if (pathname === "/api/workspace/open" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { path?: string };
          if (!body.path) return Response.json({ error: "path is required" }, { status: 400 });
          const result = await service.openWorkspace(body.path);
          // Unsaved edits must never be discarded silently — same 409 contract as close.
          if (result.needsConfirm) return Response.json(result, { status: 409 });
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/workspace/recent" && req.method === "GET") {
        if (!service) return Response.json({ recent: [], notebooks: [] });
        const all = await service.getRecentAll();
        return Response.json({ recent: all.workspaces, notebooks: all.notebooks });
      }

      if (pathname === "/api/workspace/new" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { name?: string };
          if (!body.name) return Response.json({ error: "name is required" }, { status: 400 });
          const result = await service.createNewWorkspace(body.name);
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/workspace/files" && req.method === "GET") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const dir = url.searchParams.get("dir") ?? undefined;
          const recursive = url.searchParams.get("recursive") === "1" || url.searchParams.get("recursive") === "true";
          const result = await service.listExplorer(dir, { recursive });
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/workspace/rename" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { oldPath?: string; newPath?: string };
          if (!body.oldPath || !body.newPath) return Response.json({ error: "oldPath and newPath are required" }, { status: 400 });
          const result = await service.renameFile(body.oldPath, body.newPath);
          if ((result as { needsConfirm?: boolean }).needsConfirm) {
            return Response.json(result, { status: 409 });
          }
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/workspace/copy" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { srcPath?: string; destPath?: string; path?: string };
          const src = body.srcPath ?? body.path;
          if (!src) return Response.json({ error: "srcPath is required" }, { status: 400 });
          const result = await service.copyFileOp(src, body.destPath);
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/workspace/delete" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { paths?: string[] };
          if (!Array.isArray(body.paths) || body.paths.length === 0) return Response.json({ error: "paths is required" }, { status: 400 });
          const result = await service.deletePaths(body.paths);
          if ((result as { needsConfirm?: boolean }).needsConfirm) {
            return Response.json(result, { status: 409 });
          }
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/notebook/save" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json().catch(() => ({}))) as { path?: string };
          const result = await service.saveNotebook(body.path);
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/notebook/open" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { path?: string };
          if (!body.path) return Response.json({ error: "path is required" }, { status: 400 });
          const result = await service.openNotebook(body.path, "human");
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/notebook/open-file" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { path?: string };
          if (!body.path) return Response.json({ error: "path is required" }, { status: 400 });
          const result = await service.openNotebookFile(body.path);
          // Unsaved edits must never be discarded silently — same 409 contract as close.
          if (result.needsConfirm) return Response.json(result, { status: 409 });
          return Response.json(result);
        } catch (e) {
          const err = e as Error & { status?: number };
          const msg = err instanceof Error ? err.message : String(e);
          const status = err.status ?? (msg.includes("must end with .ipynb") ? 400 : msg.includes("outside allowed roots") || msg.includes("escapes allowed roots") ? 403 : msg.includes("not found") ? 404 : 400);
          return Response.json({ error: msg }, { status });
        }
      }

      if (pathname === "/api/notebook/close" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json().catch(() => ({}))) as { force?: boolean };
          const result = await service.closeNotebook({ writer: "human", force: !!body.force });
          if (result.needsConfirm) {
            return Response.json(result, { status: 409 });
          }
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/notebook/revert" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          // A13: discard in-memory state by re-reading the saved file.
          // 404 when no notebook is open, 400 for a never-saved notebook.
          const result = await service.revertNotebook();
          return Response.json(result);
        } catch (e) {
          const err = e as Error & { status?: number };
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: err.status ?? 400 });
        }
      }

      if (pathname === "/api/notebook/undo-edit" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          // A9: undo the last HUMAN structural edit. The agent-run undo keeps
          // its own stack and endpoint (/api/agent/undo) — the two never mix.
          const body = (await req.json().catch(() => ({}))) as { steps?: number };
          const steps = typeof body.steps === "number" ? body.steps : 1;
          const res = service.undoLastEdit(steps);
          return Response.json(res);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/notebook/redo-edit" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        // A9: redo the last undone HUMAN edit. An empty redo history is an
        // honest empty result, not an error; a missing notebook is a 404.
        if (!service.notebook) return Response.json({ error: "no notebook open" }, { status: 404 });
        try {
          const body = (await req.json().catch(() => ({}))) as { steps?: number };
          const steps = typeof body.steps === "number" ? body.steps : 1;
          const res = service.redoLastEdit(steps);
          return Response.json(res);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/notebook/content" && req.method === "GET") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        if (!service.notebook) return Response.json({ hasNotebook: false, revision: service.revision ?? 0 });
        const nb = service.notebook;
        return Response.json({
          hasNotebook: true,
          path: service.notebookPath,
          dirty: service.dirty,
          kernelspec: nb.kernelspec,
          revision: service.revision ?? 0,
          cells: nb.cells.map((c, index) => ({
            index,
            id: c.id,
            type: c.type,
            source: c.source,
            sourcePreview: c.source.slice(0, 120),
            executionCount: c.executionCount,
            lastRunSuccess: lastRunSuccess(c),
            outputs: c.outputs,
            writer: service.attribution.get(c.id) ?? "human",
            locked: service.isCellLocked(c.id),
          })),
        });
      }

      // Notebook run progress: polled by the UI while a run is in flight.
      // Derived view only — absolute timestamps stay inside the service, so a
      // skewed client clock cannot misreport the elapsed time.
      if (pathname === "/api/notebook/progress" && req.method === "GET") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        // Same 404 as the sibling notebook actions that need an open document
        // (redo-edit); `progress: null` keeps the poll contract on the wire.
        if (!service.notebook) return Response.json({ error: "no notebook open", progress: null }, { status: 404 });
        const p = service.runProgress;
        if (!p) return Response.json({ progress: null });
        return Response.json({
          progress: {
            done: p.done,
            total: p.total,
            currentIndex: p.currentIndex,
            elapsedMs: Math.max(0, Date.now() - p.startedAt),
          },
        });
      }

      if (pathname === "/api/notebook/revision" && req.method === "GET") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        return Response.json({ revision: service.revision ?? 0 });
      }

      if (pathname === "/api/cell/insert" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { index?: number; type?: string; source?: string };
          const result = service.insertCell(body.index, body.type ?? "code", body.source ?? "", "human");
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/cell/edit" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { cellId?: string; source?: string };
          if (!body.cellId) return Response.json({ error: "cellId required" }, { status: 400 });
          const result = service.editCell(body.cellId, body.source ?? "", "human");
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/cell/delete" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { cellId?: string };
          if (!body.cellId) return Response.json({ error: "cellId required" }, { status: 400 });
          const result = service.deleteCell(body.cellId, "human");
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/cell/change-type" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { cellId?: string; type?: string };
          if (!body.cellId) return Response.json({ error: "cellId required" }, { status: 400 });
          if (!body.type) return Response.json({ error: "type required" }, { status: 400 });
          const result = service.changeCellType(body.cellId, body.type, "human");
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/cell/move" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { cellId?: string; to?: number; direction?: "up" | "down" };
          if (!body.cellId) return Response.json({ error: "cellId required" }, { status: 400 });
          const result = service.moveCell(body.cellId, { to: body.to, direction: body.direction }, "human");
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/cell/split" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { cellId?: string; offset?: number; line?: number };
          if (!body.cellId) return Response.json({ error: "cellId required" }, { status: 400 });
          const result = service.splitCell(body.cellId, { offset: body.offset, line: body.line }, "human");
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/cell/join" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { cellId?: string; direction?: "next" | "previous"; cellIds?: string[] };
          if (!body.cellId) return Response.json({ error: "cellId required" }, { status: 400 });
          const result = service.joinCells(body.cellId, "human", { direction: body.direction, with: body.cellIds });
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/cell/clear-outputs" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { cellId?: string };
          if (!body.cellId) return Response.json({ error: "cellId required" }, { status: 400 });
          const result = service.clearCellOutputs(body.cellId, "human");
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/cell/run" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        const svc = service;
        try {
          const body = (await req.json()) as { from?: number; to?: number };
          if (body.from === undefined || body.to === undefined) return Response.json({ error: "from/to required" }, { status: 400 });
          // A human Run must never overlap an agent execution: jupyter_server
          // broadcasts iopub to every client, so two concurrent executions would
          // interleave outputs. Refuse while the agent owns the notebook.
          if (svc.isAgentBusy()) {
            return Response.json(
              { error: "agent run in progress — wait for it to finish or cancel it before running cells", busy: true },
              { status: 409 },
            );
          }
          // Serialize through the single-writer queue so a human Run cannot
          // interleave with an MCP/agent action that is already in flight.
          // `to` is exclusive (same contract as the run_cells tool).
          const result = await svc.enqueue("human", () => svc.runCells(body.from!, body.to!, "human"));
          return Response.json(result);
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
      }

      if (pathname === "/api/config" && req.method === "GET") {
        return Response.json({
          mode: service?.mode ?? cfg.mode,
          workspaceRoot: service?.workspaceRoot ?? null,
          metaModel: cfg.metaModel,
          port: cfg.port,
        });
      }

      // Internal-chat adapter: POST /api/agent/run — direct function calls into service
      // Supervision: doorbell queue (202 queued), steer/unqueue, cancel, approvals
      if (pathname === "/api/agent/run" && req.method === "POST") {
        const accept = req.headers.get("accept") ?? "";
        const wantsSSE = accept.includes("text/event-stream");
        const body = (await req.json()) as { task?: string; prompt?: string; provider?: string; activeCellIndex?: number; queueId?: string; action?: string; requireApproval?: boolean; attachments?: Array<{ id?: string; data?: string; mime?: string; name?: string }>; continueFrom?: string; effort?: string };
        // --- steer / unqueue via same endpoint with queueId+action ---
        if (body.queueId && body.action) {
          if (!service) return Response.json({ error: "service not available" }, { status: 500 });
          if (body.action === "steer") {
            const t = (body.task ?? (body as unknown as { task: string }).task) as string;
            if (!t) return Response.json({ error: "task required for steer" }, { status: 400 });
            const ok = service.steerPending(body.queueId, t);
            // also allow steering directly into running turn even if queueId not in pending (treat as direct steer)
            if (!ok && service.isAgentBusy()) {
              service.steerBuffer.push(t);
              service.steeredFlag = true;
              return Response.json({ disposition: "steered", queueId: body.queueId, task: t });
            }
            if (!ok) return Response.json({ error: "unknown queueId or not queued" }, { status: 404 });
            return Response.json({ disposition: "steered", queueId: body.queueId, task: t });
          }
          if (body.action === "unqueue") {
            const r = service.unqueuePending(body.queueId);
            if (!r.ok) return Response.json({ error: "unknown queueId or not queued" }, { status: 404 });
            return Response.json({ disposition: "reclaimed", queueId: body.queueId, text: r.text });
          }
          return Response.json({ error: "unknown action" }, { status: 400 });
        }
        const task = (body.task ?? body.prompt) as string | undefined;
        const providerRaw = typeof body.provider === "string" ? body.provider : "Meta";
        try {
          normalizeProviderInput(providerRaw);
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 400 });
        }
        const requireApproval = !!body.requireApproval;
        if (!task) return Response.json({ error: "task is required" }, { status: 400 });
        // --- mode gating: internal chat blocked when mcp-only ---
        {
          const curMode = service ? service.mode : cfg.mode;
          if (curMode === "mcp-only") {
            const gatedMsg = "agent mode is mcp-only — internal-agent (chat) actions are gated";
            return Response.json({ ok: false, error: gatedMsg, gated: true, steps: 0, summary: gatedMsg, provider: providerRaw }, { status: 403 });
          }
        }
        // --- effort: optional native reasoning tier; absent = no flag on the wire ---
        // Validated against the provider's served subset (dev-notes/MUSE-MODELS.md).
        // Baseten clamps none/minimal up to low host-side, so record what is sent.
        let effortVal: string | undefined;
        if (body.effort !== undefined) {
          if (typeof body.effort !== "string") return Response.json({ error: "effort must be a string" }, { status: 400 });
          let effortProvider;
          try {
            effortProvider = normalizeProviderInput(providerRaw);
          } catch (e) {
            return Response.json({ error: (e as Error).message }, { status: 400 });
          }
          let e = body.effort.trim().toLowerCase();
          if (effortProvider === "Baseten" && (e === "none" || e === "minimal")) e = "low";
          if (!validateEffort(effortProvider, e)) {
            const served = EFFORT_BY_PROVIDER[effortProvider].join(", ");
            return Response.json({ error: `effort "${e}" is not served by provider ${effortProvider} — served: ${served}` }, { status: 400 });
          }
          effortVal = e;
        }
        // --- continuation: validate continueFrom if present ---
        let continueFromId: string | undefined;
        if ((body as Record<string, unknown>).continueFrom !== undefined) {
          const raw = (body as Record<string, unknown>).continueFrom;
          if (typeof raw !== "string" || !raw.trim()) {
            return Response.json({ error: "continueFrom must be a non-empty string" }, { status: 400 });
          }
          const id = raw.trim();
          const sessions = await loadSessions();
          const known = sessions.some((s) => s.id === id);
          if (!known) {
            return Response.json({ error: `unknown session id: ${id}` }, { status: 404 });
          }
          continueFromId = id;
        }

        // Park the task as a doorbell item and answer 202. Shared by the early
        // busy check and by any caller that loses the atomic claim race below.
        const queueAsPending = (svc: NotebookService) => {
          const pending = svc.enqueuePending(task, providerRaw, typeof body.activeCellIndex === "number" ? body.activeCellIndex : null, requireApproval);
          if (continueFromId) {
            (pending as unknown as Record<string, unknown>).continueFrom = continueFromId;
            const qEntry = svc.pendingQueue.find((p) => p.queueId === pending.queueId);
            if (qEntry) (qEntry as unknown as Record<string, unknown>).continueFrom = continueFromId;
          }
          if (effortVal) {
            (pending as unknown as Record<string, unknown>).effort = effortVal;
            const qEntry2 = svc.pendingQueue.find((p) => p.queueId === pending.queueId);
            if (qEntry2) (qEntry2 as unknown as Record<string, unknown>).effort = effortVal;
          }
          return Response.json({ disposition: "queued", queueId: pending.queueId }, { status: 202 });
        };

        // doorbell: if agent busy, park as pending and return 202 queued (never pile blindly)
        if (service?.isAgentBusy()) return queueAsPending(service);

        // helper to drain next pending after current run settles
        const drainNext = () => {
          if (!service) return;
          const svc = service;
          const next = service.popNextPending();
          if (!next) return;
          // fire-and-forget: run next pending without blocking current response (its session will be recorded)
          // We synthesize a request-like run using same cfg/tools/provider
          setTimeout(async () => {
            const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 4)}`;
            // Atomic claim first: a live request may have claimed the doorbell
            // during this timer window. Losing it must never overwrite that
            // run's runId/abort controller, and must not end its run.
            if (!svc.beginAgentRun(runId)) {
              // Hand the item back at the head; the run that won the claim
              // drains the queue when it ends.
              svc.pendingQueue.unshift(next);
              return;
            }
            const ctxInfo2 = { service, activeCellHint: next.activeCellIndex ?? null };
            const nextEffort = (next as unknown as Record<string, unknown>).effort as string | undefined;
            const transcript2 = tryCreateTranscriptWriter(runId, next.task, next.provider, service, undefined, nextEffort);
            let queuedHistory: { sessionId: string; items: unknown[] } | undefined;
            const qContinue = (next as unknown as Record<string, unknown>).continueFrom as string | undefined;
            if (qContinue) {
              try {
                const hist = loadTranscriptHistory(sessionsDir(), qContinue);
                queuedHistory = { sessionId: qContinue, items: hist.items };
              } catch {
                queuedHistory = { sessionId: qContinue, items: [] };
              }
            }
            try {
              const result2 = await (service as unknown as { enqueue: <T>(w: string, fn: () => Promise<T>) => Promise<T> }).enqueue("internal-agent", () =>
                runAgent(cfg, tools, next.task, next.provider, ctxInfo2, {
                  signal: (service as unknown as { getAbortSignal: () => AbortSignal | null }).getAbortSignal(),
                  requireApproval: !!next.requireApproval,
                  service: service ?? null,
                  runId,
                  transcript: transcript2,
                  ...(nextEffort ? { effort: nextEffort } : {}),
                }, queuedHistory),
              );
              // record session for drained item
              const prov2 = (result2.provider as string | undefined) ?? next.provider;
              const mdl2 = (result2 as { model?: string }).model;
              let label2: string | undefined;
              try { label2 = getProviderDisplayLabel(prov2 as ProviderId); } catch { label2 = mdl2 ? `${prov2}/${mdl2}` : prov2; }
              if (mdl2) label2 = `${prov2}/${mdl2}`;
              await appendSession({
                id: runId,
                task: next.task,
                steps: result2.steps ?? 0,
                ok: !!result2.ok,
                summary: String(result2.summary ?? "").slice(0, 2000),
                provider: prov2,
                model: mdl2,
                label: label2,
                time: new Date().toISOString(),
                cancelled: (result2 as { cancelled?: boolean }).cancelled,
                steered: (result2 as { steered?: boolean }).steered,
                approvals: (result2 as { approvals?: Array<{ tool: string; decision: string }> }).approvals,
                stuck: (result2 as { stuck?: boolean }).stuck,
                streamed: false,
                queued: true,
                ...(nextEffort ? { effort: nextEffort } : {}),
                ...(transcript2 && !transcript2.isDisabled ? { transcript: transcript2.relativePath } : {}),
              });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              await appendSession({ id: runId, task: next.task, steps: 0, ok: false, summary: msg, provider: next.provider, time: new Date().toISOString(), queued: true, ...(nextEffort ? { effort: nextEffort } : {}), ...(transcript2 && !transcript2.isDisabled ? { transcript: transcript2.relativePath } : {}) });
            } finally {
              try { transcript2?.close(); } catch {}
              try { (service as unknown as { endAgentRun: () => void }).endAgentRun(); } catch {}
              // recurse drain
              drainNext();
            }
          }, 10);
        };

        const isFakeModel = (Bun.env.JUPI_FAKE_MODEL ?? process.env.JUPI_FAKE_MODEL) === "1";
        const runFakeAgent = async (): Promise<{ ok: boolean; steps: number; summary: string; provider: string; model: string }> => {
          const fakeProvider = "fake";
          const fakeModel = "fake-model-stub";
          const doInsertAndRun = async () => {
            if (service?.notebook) {
              const ins = service.insertCell(undefined, "code", "# JUPI_FAKE_MODEL stub\nFAKE_VALUE = 42\nprint(f\"FAKE:{FAKE_VALUE}\")", "internal-agent");
              const idx = service.notebook.cells.findIndex((c) => c.id === ins.id);
              if (idx >= 0) await service.runCells(idx, idx + 1, "internal-agent");
              return { inserted: true as const, cellId: ins.id };
            }
            return { inserted: false as const };
          };
          let inserted = false;
          if (service) {
            const r = (await service.enqueue("internal-agent", doInsertAndRun as () => Promise<unknown>)) as { inserted?: boolean } | undefined;
            inserted = !!r?.inserted;
          }
          if (!inserted) {
            return { ok: false, steps: 0, summary: "FAKE: no notebook open — nothing ran", provider: fakeProvider, model: fakeModel };
          }
          return { ok: true, steps: 2, summary: "FAKE: inserted deterministic cell and ran it (FAKE:42).", provider: fakeProvider, model: fakeModel };
        };

        const attachments = Array.isArray(body.attachments) ? body.attachments : undefined;
        const attachmentIds = attachments?.filter((a) => typeof a.id === "string").map((a) => a.id as string);
        const ctxInfo = { service: service ?? null, activeCellHint: typeof body.activeCellIndex === "number" ? body.activeCellIndex : null };
        let liveHistory: { sessionId: string; items: unknown[] } | undefined;
        if (continueFromId) {
          try {
            const hist = loadTranscriptHistory(sessionsDir(), continueFromId);
            liveHistory = { sessionId: continueFromId, items: hist.items };
          } catch {
            liveHistory = { sessionId: continueFromId, items: [] };
          }
        }

        // Helper to synthesize fake transcript when JUPI_FAKE_MODEL=1 — keeps shape identical to real runs
        const writeFakeTranscript = (writer: TranscriptWriter | null, taskForTranscript: string, runIdForTranscript: string) => {
          if (!writer || writer.isDisabled) return;
          if (liveHistory?.sessionId) {
            try { writer.appendSystem("continuedFrom", { continuedFrom: liveHistory.sessionId }); } catch {}
          }
          try {
            const blocks: unknown[] = [{ type: "text", text: taskForTranscript }];
            for (const id of attachmentIds ?? []) blocks.push({ type: "attachment", id });
            writer.appendUser(blocks);
          } catch {}
          try {
            writer.appendAssistant({ model: "fake-model-stub", blocks: [{ type: "tool_call", id: "tc-fake-1", name: "insert_cell", input: { type: "code", source: "# JUPI_FAKE_MODEL stub\nFAKE_VALUE = 42\nprint(f\"FAKE:{FAKE_VALUE}\")" } }] });
          } catch {}
          try { writer.appendUser([{ type: "tool_result", tool_use_id: "tc-fake-1", content: "inserted cell fake-1" }]); } catch {}
          // No fake compaction — compact line is only written when real compaction occurs (A5 row 4)
          try {
            writer.appendAssistant({ model: "fake-model-stub", blocks: [{ type: "text", text: "FAKE: inserted deterministic cell and ran it (FAKE:42)." }, { type: "tool_call", id: "tc-fake-2", name: "run_cells", input: { from: 0, to: 0 } }] });
          } catch {}
          try { writer.appendUser([{ type: "tool_result", tool_use_id: "tc-fake-2", content: "FAKE:42" }]); } catch {}
          try {
            writer.appendSummary({ ok: true, steps: 2, time: 120, summary: "FAKE: inserted deterministic cell and ran it (FAKE:42).", compacted: false, turnsDropped: 0, cancelled: false, steered: false, approvals: [], stuck: false, attachmentIds: attachmentIds ?? [], usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, effects: { cellsAdded: 1, cellsEdited: 0, cellsRun: 1, filesChanged: 0 }, ...(effortVal ? { effort: effortVal } : {}) });
          } catch {}
        };

        if (isFakeModel) {
          // Create transcript writer for fake path too — shape must match real runs (use fake provider explicitly)
          const fakeRunId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const fakeWriter = tryCreateTranscriptWriter(fakeRunId, task, "fake", service, undefined, effortVal);
          const makeFakeRecord = async (result: { ok: boolean; steps: number; summary: string; provider?: string; model?: string; compacted?: boolean; turnsDropped?: number; streamed?: boolean; cancelled?: boolean; steered?: boolean; approvals?: Array<{ tool: string; decision: string }>; stuck?: boolean }) => {
            const prov = (result.provider as string | undefined) ?? providerRaw;
            const mdl = (result as { model?: string }).model;
            let label: string | undefined;
            try { label = getProviderDisplayLabel(prov as ProviderId); } catch { label = mdl ? `${prov}/${mdl}` : prov; }
            if (mdl) label = `${prov}/${mdl}`;
            const entry: SessionEntry = {
              id: fakeRunId, task, steps: result.steps ?? 0, ok: !!result.ok, summary: String(result.summary ?? "").slice(0, 2000),
              provider: prov, model: mdl, label, time: new Date().toISOString(),
              compacted: result.compacted, turnsDropped: result.turnsDropped, streamed: result.streamed ?? wantsSSE,
              cancelled: (result as { cancelled?: boolean }).cancelled, steered: (result as { steered?: boolean }).steered,
              approvals: (result as { approvals?: Array<{ tool: string; decision: string }> }).approvals, stuck: (result as { stuck?: boolean }).stuck,
              ...(effortVal ? { effort: effortVal } : {}),
              ...(attachmentIds?.length ? { attachmentIds } : {}),
              ...(fakeWriter && !fakeWriter.isDisabled ? { transcript: fakeWriter.relativePath } : {}),
            };
            await appendSession(entry);
            return result;
          };
          if (wantsSSE) {
            const stream = new ReadableStream({
              async start(controller) {
                const enc = new TextEncoder();
                const send = (o: Record<string, unknown>) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
                send({ type: "step", n: 1 });
                send({ type: "tool-call", name: "insert_cell", argsPreview: "FAKE_VALUE=42" });
                send({ type: "tool-result", name: "insert_cell", ok: true, summary: "fake insert" });
                send({ type: "step", n: 2 });
                send({ type: "tool-call", name: "run_cells", argsPreview: "from/to" });
                send({ type: "tool-result", name: "run_cells", ok: true, summary: "FAKE:42" });
                const result = await runFakeAgent();
                // Write transcript before record so file exists when session is queried
                writeFakeTranscript(fakeWriter, task, fakeRunId);
                try { fakeWriter?.close(); } catch {}
                send({ type: "done", steps: result.steps, summary: result.summary, provider: result.provider, model: result.model, ok: true });
                await makeFakeRecord(result);
                controller.close();
                drainNext();
              },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" } });
          } else {
            const result = await runFakeAgent();
            writeFakeTranscript(fakeWriter, task, fakeRunId);
            try { fakeWriter?.close(); } catch {}
            await makeFakeRecord(result);
            drainNext();
            return Response.json({ ...result, runId: fakeRunId });
          }
        }

        if (wantsSSE) {
          const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          // Atomic claim before any await: if another run owns the doorbell by
          // now, queue this one instead of overwriting its runId/abort controller.
          if (service && !service.beginAgentRun(runId)) return queueAsPending(service);
          const transcript = tryCreateTranscriptWriter(runId, task, providerRaw, service, undefined, effortVal);
          const record = async (result: { ok: boolean; steps: number; summary: string; provider?: string; model?: string; compacted?: boolean; turnsDropped?: number; streamed?: boolean; cancelled?: boolean; steered?: boolean; approvals?: Array<{ tool: string; decision: string }>; stuck?: boolean }) => {
            const prov = (result.provider as string | undefined) ?? providerRaw;
            const mdl = (result as { model?: string }).model;
            let label: string | undefined;
            try { label = getProviderDisplayLabel(prov as ProviderId); } catch { label = mdl ? `${prov}/${mdl}` : prov; }
            if (mdl) label = `${prov}/${mdl}`;
            const sessId = (result as unknown as { _runId?: string })._runId as string || runId;
            const entry: SessionEntry = {
              id: sessId, task, steps: result.steps ?? 0, ok: !!result.ok, summary: String(result.summary ?? "").slice(0, 2000),
              provider: prov, model: mdl, label, time: new Date().toISOString(),
              compacted: result.compacted, turnsDropped: result.turnsDropped, streamed: result.streamed ?? wantsSSE,
              cancelled: (result as { cancelled?: boolean }).cancelled, steered: (result as { steered?: boolean }).steered,
              approvals: (result as { approvals?: Array<{ tool: string; decision: string }> }).approvals, stuck: (result as { stuck?: boolean }).stuck,
              ...(effortVal ? { effort: effortVal } : {}),
              ...(attachmentIds?.length ? { attachmentIds } : {}),
              ...(transcript && !transcript.isDisabled ? { transcript: transcript.relativePath } : {}),
            };
            await appendSession(entry);
            return result;
          };
          const stream = new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder();
              const send = (obj: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
              try {
                const supervision = { signal: service?.getAbortSignal() ?? null, requireApproval, service: service ?? null, runId, attachments, transcript, ...(effortVal ? { effort: effortVal } : {}) };
                const run = async () => {
                  if (service) return service.enqueue("internal-agent", () => runAgentStreaming(cfg, tools, task, providerRaw, ctxInfo, (evt) => send(evt as Record<string, unknown>), supervision, liveHistory));
                  return runAgentStreaming(cfg, tools, task, providerRaw, ctxInfo, (evt) => send(evt as Record<string, unknown>), supervision, liveHistory);
                };
                const result = await run();
                const prov = (result.provider as string | undefined) ?? providerRaw;
                const mdl = (result as { model?: string }).model;
                send({ type: "done", steps: result.steps, summary: result.summary, provider: prov, model: mdl ?? "", ok: result.ok, compacted: result.compacted, turnsDropped: result.turnsDropped, cancelled: (result as { cancelled?: boolean }).cancelled, steered: (result as { steered?: boolean }).steered, approvals: (result as { approvals?: unknown }).approvals, stuck: (result as { stuck?: boolean }).stuck });
                await record({ ...result, _runId: runId } as unknown as { ok: boolean; steps: number; summary: string; provider?: string; model?: string; compacted?: boolean; turnsDropped?: number; streamed?: boolean });
                controller.close();
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.includes("gated")) {
                  const gated = { ok: false, error: msg, gated: true, steps: 0, summary: msg, provider: providerRaw };
                  send({ type: "done", steps: 0, summary: msg, provider: providerRaw, model: "", ok: false, error: msg, gated: true });
                  // Even gated runs get a transcript summary via loop's early fail path — but ensure transcript closed
                  await record(gated as unknown as { ok: boolean; steps: number; summary: string; provider?: string; model?: string });
                  controller.close();
                  return;
                }
                send({ type: "done", steps: 0, summary: msg, provider: providerRaw, model: "", ok: false, error: msg });
                const errRes = { ok: false, error: msg, steps: 0, summary: msg, provider: providerRaw };
                await record(errRes as unknown as { ok: boolean; steps: number; summary: string; provider?: string; model?: string });
                controller.close();
              } finally {
                try { transcript?.close(); } catch {}
                try { service?.endAgentRun(); } catch {}
                drainNext();
              }
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" } });
        }

        // Non-streaming JSON fallback (must not regress)
        const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        // Atomic claim before any await (same contract as the SSE branch).
        if (service && !service.beginAgentRun(runId)) return queueAsPending(service);
        const transcript = tryCreateTranscriptWriter(runId, task, providerRaw, service, undefined, effortVal);
        const record = async (result: { ok: boolean; steps: number; summary: string; provider?: string; model?: string; compacted?: boolean; turnsDropped?: number; streamed?: boolean; cancelled?: boolean; steered?: boolean; approvals?: Array<{ tool: string; decision: string }>; stuck?: boolean }) => {
          const prov = (result.provider as string | undefined) ?? providerRaw;
          const mdl = (result as { model?: string }).model;
          let label: string | undefined;
          try { label = getProviderDisplayLabel(prov as ProviderId); } catch { label = mdl ? `${prov}/${mdl}` : prov; }
          if (mdl) label = `${prov}/${mdl}`;
          const sessId = (result as unknown as { _runId?: string })._runId as string || runId;
          const entry: SessionEntry = {
            id: sessId, task, steps: result.steps ?? 0, ok: !!result.ok, summary: String(result.summary ?? "").slice(0, 2000),
            provider: prov, model: mdl, label, time: new Date().toISOString(),
            compacted: result.compacted, turnsDropped: result.turnsDropped, streamed: result.streamed ?? wantsSSE,
            cancelled: (result as { cancelled?: boolean }).cancelled, steered: (result as { steered?: boolean }).steered,
            approvals: (result as { approvals?: Array<{ tool: string; decision: string }> }).approvals, stuck: (result as { stuck?: boolean }).stuck,
            ...(effortVal ? { effort: effortVal } : {}),
            ...(attachmentIds?.length ? { attachmentIds } : {}),
            ...(transcript && !transcript.isDisabled ? { transcript: transcript.relativePath } : {}),
          };
          await appendSession(entry);
          return result;
        };
        const supervision = { signal: service?.getAbortSignal() ?? null, requireApproval, service: service ?? null, runId, attachments, transcript, ...(effortVal ? { effort: effortVal } : {}) };
        const runNonStreaming = async () => {
          const sup2 = { signal: service?.getAbortSignal() ?? null, requireApproval, service: service ?? null, runId, attachments, transcript, ...(effortVal ? { effort: effortVal } : {}) };
          if (service) return service.enqueue("internal-agent", () => runAgent(cfg, tools, task, providerRaw, ctxInfo, sup2, liveHistory));
          return runAgent(cfg, tools, task, providerRaw, ctxInfo, sup2, liveHistory);
        };
        try {
          const result = await runNonStreaming();
          await record({ ...result, _runId: runId } as unknown as { ok: boolean; steps: number; summary: string; provider?: string; model?: string; compacted?: boolean; turnsDropped?: number; streamed?: boolean });
          return Response.json({ ...result, runId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("gated")) {
            const gated = { ok: false, error: msg, gated: true, steps: 0, summary: msg, provider: providerRaw };
            await record(gated as unknown as { ok: boolean; steps: number; summary: string; provider?: string; model?: string });
            return Response.json(gated, { status: 403 });
          }
          const errRes = { ok: false, error: msg, steps: 0, summary: msg, provider: providerRaw };
          await record(errRes as unknown as { ok: boolean; steps: number; summary: string; provider?: string; model?: string });
          return Response.json(errRes, { status: 500 });
        } finally {
          try { transcript?.close(); } catch {}
          try { service?.endAgentRun(); } catch {}
          drainNext();
        }
      }

      // --- supervision endpoints ---
      if ((pathname === "/api/agent/cancel" || pathname === "/api/agent/cancel/") && (req.method === "GET" || req.method === "POST")) {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        const ok = service.requestCancel();
        return Response.json({ ok, cancelled: ok, runId: service.getCurrentRunId() });
      }
      if (pathname === "/api/agent/approve" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json()) as { runId?: string; decision?: string };
          if (!body.runId || !body.decision) return Response.json({ error: "runId and decision required" }, { status: 400 });
          const dec = body.decision === "approve" ? "approve" : body.decision === "deny" ? "deny" : null;
          if (!dec) return Response.json({ error: "decision must be approve|deny" }, { status: 400 });
          const resolved = service.resolveApproval(body.runId, dec as "approve" | "deny");
          if (!resolved) return Response.json({ error: "no pending approval for runId" }, { status: 404 });
          return Response.json({ ok: true, runId: body.runId, decision: dec });
        } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
      }
      if (pathname === "/api/agent/undo" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const body = (await req.json().catch(() => ({}))) as { steps?: number };
          const steps = typeof body.steps === "number" ? body.steps : 1;
          const res = service.undoLastRun(steps);
          return Response.json(res);
        } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
      }
      // queued info
      if (pathname === "/api/agent/queue" && req.method === "GET") {
        if (!service) return Response.json({ queue: [] });
        return Response.json({ queue: service.pendingQueue, busy: service.isAgentBusy(), runId: service.getCurrentRunId() });
      }

      // EXPORT + DELETE + PATCH for sessions (ADDITIVE — new endpoints only)
      // GET /api/agent/sessions/:id/export?format=jsonl|md
      if (pathname.startsWith("/api/agent/sessions/") && pathname.endsWith("/export") && req.method === "GET") {
        const inner = pathname.slice("/api/agent/sessions/".length, -"/export".length);
        const id = inner.replace(/\/$/, "");
        if (!id || id.includes("/") || id.includes("..")) return Response.json({ error: "invalid id" }, { status: 400 });
        const format = url.searchParams.get("format");
        if (format !== "jsonl" && format !== "md") return Response.json({ error: "format must be jsonl or md" }, { status: 400 });
        const list = await loadSessions();
        const found = list.find((s) => s.id === id);
        if (!found) return Response.json({ error: "not found" }, { status: 404 });

        const filePath = join(sessionsDir(), `${id}.jsonl`);
        if (format === "jsonl") {
          try {
            const data = await readFile(filePath);
            return new Response(data, {
              headers: {
                "content-type": "application/jsonl; charset=utf-8",
                "content-disposition": `attachment; filename="${id}.jsonl"`,
              },
            });
          } catch {
            return Response.json({ error: `transcript not found for ${id}` }, { status: 404 });
          }
        } else {
          // md
          try {
            const raw = await readFile(filePath, "utf-8");
            const lines: unknown[] = raw
              .split("\n")
              .filter((l) => l.trim())
              .map((l) => {
                try { return JSON.parse(l); } catch { return null; }
              })
              .filter(Boolean) as unknown[];
            const md = renderTranscriptMarkdown(lines, { id, title: found.title, task: found.task, time: found.time, provider: found.provider, model: found.model });
            return new Response(md, {
              headers: {
                "content-type": "text/markdown; charset=utf-8",
                "content-disposition": `attachment; filename="${id}.md"`,
              },
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("ENOENT") || msg.includes("not found")) return Response.json({ error: `transcript not found for ${id}` }, { status: 404 });
            return Response.json({ error: `transcript not found for ${id}` }, { status: 404 });
          }
        }
      }

      // PATCH /api/agent/sessions/:id {title: string} — rename (panel metadata only, transcript untouched)
      if (pathname.startsWith("/api/agent/sessions/") && req.method === "PATCH") {
        const id = pathname.slice("/api/agent/sessions/".length).split("/")[0].split("?")[0];
        if (!id || id.includes("..")) return Response.json({ error: "id required" }, { status: 400 });
        const list = await loadSessions();
        const idx = list.findIndex((s) => s.id === id);
        if (idx === -1) return Response.json({ error: "not found" }, { status: 404 });
        let body: { title?: unknown };
        try { body = (await req.json()) as typeof body; } catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
        if (typeof body.title !== "string") return Response.json({ error: "title must be a string" }, { status: 400 });
        let t = body.title.trim();
        if (t.length === 0) {
          const copy = { ...list[idx] } as SessionEntry;
          delete (copy as unknown as Record<string, unknown>).title;
          list[idx] = copy;
          await saveSessions(list);
          return Response.json(copy);
        }
        if (t.length > 120) t = t.slice(0, 120);
        list[idx] = { ...list[idx], title: t };
        await saveSessions(list);
        return Response.json(list[idx]);
      }

      // DELETE /api/agent/sessions/:id — remove from sessions.json and delete .jsonl if present (best-effort)
      if (pathname.startsWith("/api/agent/sessions/") && req.method === "DELETE") {
        const id = pathname.slice("/api/agent/sessions/".length).split("/")[0].split("?")[0];
        if (!id || id.includes("..") || id.includes("/")) return Response.json({ error: "id required" }, { status: 400 });
        const list = await loadSessions();
        const idx = list.findIndex((s) => s.id === id);
        if (idx === -1) return Response.json({ error: "not found" }, { status: 404 });
        list.splice(idx, 1);
        await saveSessions(list);
        // best-effort delete file
        try {
          const fp = join(sessionsDir(), `${id}.jsonl`);
          await unlink(fp);
        } catch {}
        return Response.json({ deleted: id });
      }

      // GET /api/agent/sessions — list past runs (capped at 50)
      if (pathname === "/api/agent/sessions" && req.method === "GET") {
        const list = await loadSessions();
        const enriched = list.map((s) => {
          if (s.label) return s;
          let label: string | undefined;
          try {
            label = s.model ? `${s.provider}/${s.model}` : getProviderDisplayLabel((s.provider as ProviderId) ?? "Meta");
          } catch {
            label = s.provider;
          }
          return { ...s, label, model: s.model };
        });
        return Response.json({ sessions: enriched });
      }
      if (pathname.startsWith("/api/agent/sessions/") && req.method === "GET") {
        const id = pathname.slice("/api/agent/sessions/".length);
        if (!id) return Response.json({ error: "id required" }, { status: 400 });
        // if id contains slash, it's not a valid single-id fetch (e.g. already handled export) — return 404
        if (id.includes("/")) return Response.json({ error: "not found" }, { status: 404 });
        const list = await loadSessions();
        const found = list.find((s) => s.id === id);
        if (!found) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(found);
      }

      if (pathname === "/api/providers" && req.method === "GET") {
        const { listProviders } = await import("./agent/providers");
        const list = listProviders().map((p) => ({
          id: p.id,
          baseUrl: p.baseUrl,
          model: p.model,
          protocol: p.protocol,
          hasKey: p.hasKey,
          label: getProviderDisplayLabel(p.id as ProviderId),
        }));
        return Response.json({ providers: list });
      }

      // --- Ghost completion: POST /api/complete/ghost ---
      // Contract (documented for the frontend worker):
      //   request  {code: string, cursorPos: number, cellId?: string}
      //   response {ghost: string|null, model?: string, error?: string}
      //   ?provider=Meta|Baseten|Custom (default Baseten); no silent fallback.
      //   Status: 200 ok/timeout (ghost null on timeout), 400 bad or >4000-char
      //   input, 429 rate limit (10/min per process, Retry-After header),
      //   502 upstream failure, 503 no provider key.
      // Never logs code content or keys.
      if (pathname === "/api/complete/ghost" && req.method === "POST") {
        let body: { code?: unknown; cursorPos?: unknown; cellId?: unknown };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return Response.json({ ghost: null, error: "invalid JSON body" }, { status: 400 });
        }
        if (typeof body.code !== "string") {
          return Response.json({ ghost: null, error: "code is required (string)" }, { status: 400 });
        }
        if (typeof body.cursorPos !== "number" || !Number.isFinite(body.cursorPos)) {
          return Response.json({ ghost: null, error: "cursorPos is required (number)" }, { status: 400 });
        }
        if (body.code.length > GHOST_MAX_CODE_CHARS) {
          return Response.json(
            { ghost: null, error: `code too large: ${body.code.length} chars (max ${GHOST_MAX_CODE_CHARS})` },
            { status: 400 },
          );
        }

        // Sliding-window rate limit, per process.
        const now = Date.now();
        while (ghostHits.length > 0 && now - ghostHits[0] >= GHOST_RATE_WINDOW_MS) ghostHits.shift();
        if (ghostHits.length >= GHOST_RATE_LIMIT) {
          const retryAfterSec = Math.max(1, Math.ceil((GHOST_RATE_WINDOW_MS - (now - ghostHits[0])) / 1000));
          return Response.json(
            { ghost: null, error: `rate limit: ${GHOST_RATE_LIMIT}/min` },
            { status: 429, headers: { "retry-after": String(retryAfterSec) } },
          );
        }
        ghostHits.push(now);

        const result = await suggestCompletion({
          code: body.code,
          cursorPos: body.cursorPos,
          provider: url.searchParams.get("provider") ?? "Baseten",
          timeoutMs: GHOST_TIMEOUT_MS,
          maxChars: GHOST_MAX_GHOST_CHARS,
        });
        if (result.noKey) return Response.json({ ghost: null, error: "no provider key" }, { status: 503 });
        if (result.timedOut) return Response.json({ ghost: null, error: "timeout" }, { status: 200 });
        if (result.error) return Response.json({ ghost: null, error: result.error }, { status: 502 });
        return Response.json({ ghost: result.ghost, model: result.model });
      }

      // --- WS terminal: GET /api/terminal?cols=&rows= (Upgrade) ---
      // Spawns one PTY (Bun.Terminal) in the service workspace root. Honest
      // refusals before the upgrade: 400 without an Upgrade header, 503 when no
      // workspace is open or the PTY cannot be spawned.
      // Auth (A6-2): per-boot token + Origin allowlist. Mirrors
      // jupyter_server services/kernels/websocket.py:36-45,61.
      if (pathname === "/api/terminal" && req.method === "GET") {
        const origin = req.headers.get("origin");
        if (!isAllowedTerminalOrigin(origin)) {
          return Response.json({ error: "forbidden origin" }, { status: 403 });
        }
        if (!isTerminalAuthorized(req, url, terminalToken)) {
          return Response.json(
            { error: "terminal token required — pass ?token=<per-boot token> or Authorization: Bearer <token> or Sec-WebSocket-Protocol: <token>" },
            { status: 401 },
          );
        }
        if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
          return Response.json({ error: "websocket upgrade required" }, { status: 400 });
        }
        const cwd = service?.workspaceRoot ?? null;
        if (!cwd) return Response.json({ error: "no workspace open" }, { status: 503 });

        const data = {
          session: null as unknown as TerminalSession,
          ws: null,
          pending: [],
          exited: false,
          exitCode: null,
        } as TerminalWsData;
        try {
          data.session = createTerminal({
            cwd,
            cols: Number(url.searchParams.get("cols") ?? 80),
            rows: Number(url.searchParams.get("rows") ?? 24),
            onData: (chunk) => {
              if (data.ws) {
                try {
                  data.ws.send(JSON.stringify({ type: "output", data: chunk }));
                } catch {
                  // socket gone — close handler kills the PTY
                }
              } else if (data.pending.length < 1000) {
                data.pending.push(chunk);
              }
            },
            onExit: (code) => {
              data.exited = true;
              data.exitCode = code;
              if (!data.ws) return;
              try {
                data.ws.send(JSON.stringify({ type: "exit", code }));
              } catch {
                // socket already gone
              }
              try {
                data.ws.close(1000, "process exited");
              } catch {
                // already closing
              }
            },
          });
        } catch (e) {
          return Response.json(
            { error: `pty failed: ${e instanceof Error ? e.message : String(e)}` },
            { status: 503 },
          );
        }

        if (!srv.upgrade(req, { data })) {
          data.session.kill();
          return Response.json({ error: "websocket upgrade failed" }, { status: 400 });
        }
        return;
      }

      // --- Attach store ---
      if (pathname === "/api/attach" && req.method === "POST") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const form = await req.formData();
          const file = form.get("file");
          if (!(file instanceof File)) return Response.json({ error: "field 'file' is required" }, { status: 400 });
          const name = (form.get("name") as string) || file.name || "file";
          const mime = file.type || "application/octet-stream";
          const buf = new Uint8Array(await file.arrayBuffer());
          const entry = await service.attachFile(name, buf, mime);
          return Response.json({ id: entry.id, name: entry.name, mime: entry.mime, size: entry.size });
        } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
      }
      if (pathname.startsWith("/api/attach/") && req.method === "GET") {
        if (!service) return Response.json({ error: "service not available" }, { status: 500 });
        try {
          const id = pathname.slice("/api/attach/".length).split("/")[0].split("?")[0];
          const { bytes, mime, name } = await service.getAttachment(id);
          return new Response(bytes as unknown as BodyInit, { headers: { "content-type": mime || "application/octet-stream", "content-disposition": `inline; filename="${name.replace(/"/g, "")}"` } });
        } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 }); }
      }

      if (pathname === "/healthz") {
        return Response.json({ ok: true, app: "jupibuddy", stage: 2 });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return server;
}
