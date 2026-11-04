// Kernel layer.
//
// Two implementations behind one stable interface:
//
// - EchoKernel  — the stage-1 stub, kept for tests without Python. Active when
//                 JUPI_KERNEL_STUB=1 (env flag).
// - JupyterServerKernel — the real sidecar. Spawns `python -m jupyter_server`
//                 as a child process, discovers its URL from server output, and
//                 drives kernels via REST (kernels/sessions) + the kernel
//                 WebSocket (jupyter_server/services/kernels/websocket.py).
//                 Bun-native WebSocket with pause()/resume() awareness for
//                 backpressure.
//
// Nothing outside this file should care which implementation is active; the
// Kernel interface below is the seam.

import type { CellOutput } from "./notebook";
import type { ResolvedCandidate } from "./kernelResolve";
import { resolveBest, resolveCandidates } from "./kernelResolve";

// ---------------------------------------------------------------------------
// Kernel interface — stable from stage 1 onward
// ---------------------------------------------------------------------------

export interface Kernel {
  readonly name: string;
  /** Currently-selected kernelspec / candidate, when known. */
  readonly selectedSpec?: ResolvedCandidate | null;
  execute(source: string, opts?: { timeoutMs?: number }): Promise<CellOutput[]>;
  interrupt(): Promise<void>;
  restart(): Promise<void>;
  status(): { state: "idle" | "busy" | "stub"; kernel: string };
  complete(code: string, cursorPos: number, opts?: { timeoutMs?: number }): Promise<{ matches: string[]; cursorStart: number; cursorEnd: number; status: string }>;
  /** List available kernelspecs (proxied from the sidecar or from discovery). */
  listKernelspecs?(): Promise<unknown>;
  /** Select a kernel by name or interpreter path, restarting if needed. */
  selectKernel?(opts: { name?: string; interpreterPath?: string }): Promise<ResolvedCandidate>;
  /** Shut down the kernel / sidecar cleanly. */
  shutdown?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// EchoKernel — stub
// ---------------------------------------------------------------------------

export class EchoKernel implements Kernel {
  readonly name = "echo-stub";
  #state: "idle" | "busy" = "idle";

  async execute(source: string, _opts?: { timeoutMs?: number }): Promise<CellOutput[]> {
    this.#state = "busy";
    await Bun.sleep(10);
    this.#state = "idle";
    return [
      {
        kind: "stream",
        name: "stdout",
        text: `[echo-kernel stub] no Python executed yet. Source was:\n${source}\n`,
      },
    ];
  }

  async interrupt(): Promise<void> {
    this.#state = "idle";
  }

  async restart(): Promise<void> {
    this.#state = "idle";
  }

  status() {
    return { state: this.#state, kernel: this.name } as const;
  }

  async complete(_code: string, _cursorPos: number, _opts?: { timeoutMs?: number }): Promise<{ matches: string[]; cursorStart: number; cursorEnd: number; status: string }> {
    return { matches: [], cursorStart: 0, cursorEnd: 0, status: "stub" };
  }

  async listKernelspecs(): Promise<unknown> {
    return { kernelspecs: {}, echo: "stub has no kernelspecs" };
  }

  async selectKernel(opts: { name?: string; interpreterPath?: string }): Promise<ResolvedCandidate> {
    throw new Error(`select_kernel stub: cannot select ${JSON.stringify(opts)} — echo kernel has no kernelspecs`);
  }
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function missingSidecarError(pythonPath: string, extra?: string): Error {
  return new Error(
    [
      `Jupyter sidecar not available (python: ${pythonPath}).`,
      extra ?? "",
      `Install the required packages into that interpreter:`,
      `  ${pythonPath} -m pip install "jupyter_server>=2.0" "ipykernel>=6.0" "jupyter_client>=8.0"`,
      `Then restart JupiBuddy.`,
      `To bypass this check in tests, set JUPI_KERNEL_STUB=1.`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// ---------------------------------------------------------------------------
// JupyterServerKernel — real sidecar
// ---------------------------------------------------------------------------

/** Small helper: check that a python can import jupyter_server. */
async function canImportJupyterServer(pythonPath: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const proc = Bun.spawn([pythonPath, "-c", "import jupyter_server; print(jupyter_server.__version__)"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) return { ok: false, detail: err.trim() };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

export class JupyterServerKernel implements Kernel {
  #kernelDisplayName: string;
  selectedSpec: ResolvedCandidate | null = null;

  // Sidecar state
  #pythonPath: string;
  #workspaceRoot: string;
  #proc: ReturnType<typeof Bun.spawn> | null = null;
  #baseUrl: string | null = null;
  #token: string | null = null;
  #kernelId: string | null = null;
  #kernelName: string | null = null; // kernelspec name to start (e.g. "python3")
  #ready: Promise<void> | null = null;
  #readyResolve: (() => void) | null = null;
  #readyReject: ((e: Error) => void) | null = null;
  #state: "idle" | "busy" = "idle";
  #stderrBuf = "";
  #shuttingDown = false;

  constructor(pythonPath: string, kernelName: string, workspaceRoot: string, displayName?: string) {
    this.#pythonPath = pythonPath;
    this.#kernelName = kernelName;
    this.#workspaceRoot = workspaceRoot;
    this.#kernelDisplayName = displayName ? `jupyter:${displayName}` : `jupyter:${kernelName}@${pythonPath}`;
    this.selectedSpec = null;
  }

  get name(): string {
    return this.#kernelDisplayName;
  }

  // -- lifecycle -------------------------------------------------------------

  /** Start the sidecar if not already started. Resolves when REST is reachable. */
  async start(): Promise<void> {
    if (this.#ready) return this.#ready;

    // Fail fast if jupyter_server is not installed — before creating the ready promise
    // so we don't leave an unhandled rejection behind.
    const check = await canImportJupyterServer(this.#pythonPath);
    if (!check.ok) throw missingSidecarError(this.#pythonPath, check.detail);

    this.#ready = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });

    // Spawn jupyter_server on an ephemeral port, no token, loose CORS
    // (localhost-only server; Server.ts binds to 127.0.0.1).
    const proc = Bun.spawn(
      [
        this.#pythonPath,
        "-m",
        "jupyter_server",
        "--no-browser",
        "--port=0",
        "--port-retries=0",
        "--ServerApp.token=",
        "--ServerApp.password=",
        "--ServerApp.allow_origin=*",
        "--ServerApp.allow_remote_access=True",
        "--ServerApp.open_browser=False",
        "--ServerApp.base_url=/",
        `--ServerApp.root_dir=${this.#workspaceRoot}`,
        "--ServerApp.quit_button=False",
        "--ServerApp.disable_check_xsrf=True",
        "--log-level=INFO",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    this.#proc = proc;

    // The server prints its URL to stderr (and sometimes stdout). Watch both.
    this.#watchOutput(proc);

    // Also watch for early exit
    proc.exited.then(() => {
      if (this.#shuttingDown) return;
      const detail = this.#stderrBuf.slice(-4000) || "exitCode " + proc.exitCode;
      const err = missingSidecarError(
        this.#pythonPath,
        `jupyter_server exited unexpectedly:\n${detail}`,
      );
      if (this.#readyReject) this.#readyReject(err);
    });

    return this.#ready;
  }

  #watchOutput(proc: ReturnType<typeof Bun.spawn>): void {
    // Read stderr in background and look for the URL line.
    const tryCapture = (chunk: string) => {
      this.#stderrBuf += chunk;
      if (this.#stderrBuf.length > 20000) this.#stderrBuf = this.#stderrBuf.slice(-20000);
      // jupyter_server prints e.g. "http://127.0.0.1:8888/lab" or "http://localhost:8888/"
      const m =
        this.#stderrBuf.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\S*/) ??
        this.#stderrBuf.match(/Jupyter Server .*is running at:\s*(http:\/\/[^\s]+)/);
      if (!m) return;
      const url = m[1].startsWith("http") ? m[1] : `http://127.0.0.1:${m[1]}`;
      // Extract port and build baseUrl
      const portMatch = url.match(/:(\d+)/);
      if (!portMatch) return;
      this.#baseUrl = `http://127.0.0.1:${portMatch[1]}`;
      // Token: if the server ever prints one, capture it; otherwise empty (we disabled auth)
      const tokenMatch = this.#stderrBuf.match(/[?&]token=([a-zA-Z0-9]+)/);
      if (tokenMatch) this.#token = tokenMatch[1];
      // Confirm connectivity before resolving ready
      this.#confirmReady();
    };

    // Stream stderr + stdout — Bun.spawn with pipe gives ReadableStream
    const streamOutput = (stream: ReadableStream<Uint8Array> | number | null | undefined) => {
      if (!stream || typeof stream === "number") return;
      (async () => {
        try {
          const reader = (stream as ReadableStream<Uint8Array>).getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            tryCapture(decoder.decode(value, { stream: true }));
          }
        } catch {
          // stream ended
        }
      })();
    };
    streamOutput(proc.stderr);
    streamOutput(proc.stdout);

    // Fallback: if no URL was detected within 5s, try probing localhost ports
    setTimeout(() => {
      if (this.#baseUrl) return;
      // Give the server a bit more time, then fail with diagnostic
      setTimeout(() => {
        if (this.#baseUrl) return;
        if (proc.exitCode !== null) return; // already handled via exited
        const err = missingSidecarError(
          this.#pythonPath,
          `jupyter_server did not report a URL within 8s.\nLast stderr:\n${this.#stderrBuf.slice(-2000)}`,
        );
        this.#readyReject?.(err);
      }, 3000);
    }, 5000);
  }

  async #confirmReady(): Promise<void> {
    if (!this.#baseUrl) return;
    // Poll /api/status or /api/kernelspecs until reachable
    for (let i = 0; i < 20; i++) {
      try {
        const headers: Record<string, string> = {};
        if (this.#token) headers.Authorization = `token ${this.#token}`;
        const res = await fetch(`${this.#baseUrl}/api/kernelspecs`, { headers });
        if (res.ok) {
          this.#readyResolve?.();
          this.#readyResolve = null;
          this.#readyReject = null;
          return;
        }
      } catch {
        // not ready yet
      }
      await Bun.sleep(200);
    }
    const err = missingSidecarError(
      this.#pythonPath,
      `Server at ${this.#baseUrl} never became ready.\nLast stderr:\n${this.#stderrBuf.slice(-2000)}`,
    );
    this.#readyReject?.(err);
    this.#readyReject = null;
    this.#readyResolve = null;
  }

  // -- REST helpers ----------------------------------------------------------

  #headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.#token) h.Authorization = `token ${this.#token}`;
    return h;
  }

  async #fetchJson(path: string, init?: RequestInit): Promise<unknown> {
    await this.start();
    const res = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { ...this.#headers(), ...(init?.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`jupyter_server ${init?.method ?? "GET"} ${path} -> ${res.status}: ${body.slice(0, 500)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // -- kernelspec listing -----------------------------------------------------

  async listKernelspecs(): Promise<unknown> {
    return this.#fetchJson("/api/kernelspecs");
  }

  // -- kernel lifecycle ------------------------------------------------------

  async #ensureKernel(): Promise<string> {
    await this.start();
    if (this.#kernelId) {
      // Verify it still exists
      try {
        await this.#fetchJson(`/api/kernels/${this.#kernelId}`);
        return this.#kernelId;
      } catch {
        this.#kernelId = null;
      }
    }
    const model = (await this.#fetchJson("/api/kernels", {
      method: "POST",
      body: JSON.stringify({ name: this.#kernelName ?? "python3", path: this.#workspaceRoot }),
    })) as { id: string };
    this.#kernelId = model.id;
    return this.#kernelId;
  }

  async selectKernel(opts: { name?: string; interpreterPath?: string }): Promise<ResolvedCandidate> {
    // Resolve the requested candidate
    let candidate: ResolvedCandidate | null = null;
    if (opts.interpreterPath) {
      const cands = await resolveCandidates({
        workspaceRoot: this.#workspaceRoot,
        preferredInterpreterPath: opts.interpreterPath,
      });
      candidate = cands.find((c) => c.pythonPath === opts.interpreterPath) ?? cands[0] ?? null;
      if (!candidate) {
        throw new Error(`select_kernel: no candidate for interpreterPath ${opts.interpreterPath}`);
      }
    } else if (opts.name) {
      const cands = await resolveCandidates({
        workspaceRoot: this.#workspaceRoot,
        preferredKernelName: opts.name,
      });
      candidate = cands.find((c) => c.name === opts.name) ?? null;
      if (!candidate) {
        throw new Error(`select_kernel: unknown kernel name ${opts.name}`);
      }
    } else {
      throw new Error(`select_kernel: provide name or interpreterPath`);
    }

    // If the selection points to a different python, respawn the whole server on
    // that interpreter FIRST (fresh boot), then create the kernel by kernelspec
    // name. The kernelspec must exist on the NEW server — never reuse the old
    // server's "python3" default (2026-11-02 incident: first click 500'd on the
    // wrong server, second click worked because the server had respawned).
    if (candidate.pythonPath && candidate.pythonPath !== this.#pythonPath) {
      // Re-resolve best candidate for that interpreter to validate jupyter_server presence
      const check = await canImportJupyterServer(candidate.pythonPath);
      if (!check.ok) throw missingSidecarError(candidate.pythonPath, check.detail);
      // Spawn a new server on the new interpreter — shut down old one
      await this.shutdown();
      this.#pythonPath = candidate.pythonPath;
      this.#kernelName = candidate.name;
      this.selectedSpec = candidate;
      // Reset state and re-bootstrap
      this.#baseUrl = null;
      this.#token = null;
      this.#kernelId = null;
      this.#ready = null;
      this.#readyResolve = null;
      this.#readyReject = null;
      this.#proc = null;
      this.#stderrBuf = "";
      this.#shuttingDown = false;
      this.#kernelDisplayName = candidate.displayName ? `jupyter:${candidate.displayName}` : `jupyter:${candidate.name}@${candidate.pythonPath}`;
      await this.start();
      // start() resolves on URL-detect, not on HTTP-readiness — wait for the
      // REST API before creating the kernel, otherwise the first POST
      // /api/kernels 500s and only the retry (second click) succeeds.
      await this.#confirmReady();
      // The new server only knows its OWN kernelspecs (e.g. jupibuddy-test,
      // python3) — not our discovery names (conda-agkit). Ask the server what
      // it has and create the kernel with a name it knows; keep the discovery
      // candidate as selectedSpec for UI metadata.
      try {
        const known = (await this.listKernelspecs()) as { kernelspecs?: Record<string, unknown> };
        const names = Object.keys(known?.kernelspecs ?? {});
        if (names.length && !names.includes(this.#kernelName ?? "")) {
          this.#kernelName = names.includes("python3") ? "python3" : names[0];
        }
      } catch {
        // fall through with requested name; ensureKernel errors honestly
      }
      await this.restart(); // create kernel with a server-known spec
      return candidate;
    }

    // Same python, different kernelspec name: restart kernel with that spec
    if (candidate.name !== this.#kernelName) {
      this.#kernelName = candidate.name;
      this.selectedSpec = candidate;
      this.#kernelDisplayName = `jupyter:${candidate.name}@${this.#pythonPath}`;
      await this.restart();
    } else {
      this.selectedSpec = candidate;
    }
    return candidate;
  }

  // -- Kernel interface ------------------------------------------------------

  async execute(source: string, opts?: { timeoutMs?: number }): Promise<CellOutput[]> {
    await this.#ensureKernel();
    this.#state = "busy";
    try {
      return await this.#executeViaWebSocket(source, opts?.timeoutMs);
    } finally {
      this.#state = "idle";
    }
  }

  async complete(code: string, cursorPos: number, opts?: { timeoutMs?: number }): Promise<{ matches: string[]; cursorStart: number; cursorEnd: number; status: string }> {
    await this.#ensureKernel();
    this.#state = "busy";
    try {
      return await this.#completeViaWebSocket(code, cursorPos, opts?.timeoutMs ?? 10_000);
    } finally {
      this.#state = "idle";
    }
  }

  async #completeViaWebSocket(code: string, cursorPos: number, timeoutMs = 10_000): Promise<{ matches: string[]; cursorStart: number; cursorEnd: number; status: string }> {
    await this.start();
    const kid = this.#kernelId!;
    const sessionId = `jupibuddy-${Date.now()}`;
    const wsUrl = `${this.#baseUrl!.replace(/^http/, "ws")}/api/kernels/${kid}/channels?session_id=${sessionId}${this.#token ? `&token=${this.#token}` : ""}`;
    return await new Promise<{ matches: string[]; cursorStart: number; cursorEnd: number; status: string }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msgSession = sessionId;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error(`complete timeout (${Math.round(timeoutMs / 1000)}s) — kernel did not reply`));
        }
      }, timeoutMs);
      const cleanup = () => clearTimeout(timer);
      ws.addEventListener("open", () => {
        const msg = {
          header: { msg_id: msgId, session: msgSession, username: "jupibuddy", msg_type: "complete_request", version: "5.4" },
          parent_header: {},
          metadata: {},
          content: { code, cursor_pos: cursorPos },
          channel: "shell",
        };
        try {
          if (((ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0) > 0) {
            setTimeout(() => ws.send(JSON.stringify(msg)), 10);
          } else {
            ws.send(JSON.stringify(msg));
          }
        } catch (e) {
          cleanup();
          if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); }
        }
      });
      ws.addEventListener("message", (event) => {
        let data: { header: { msg_type: string }; parent_header: { msg_id?: string }; content: Record<string, unknown> };
        try { data = JSON.parse(String(event.data)); } catch { return; }
        if (data.parent_header?.msg_id !== msgId) return;
        if (data.header?.msg_type !== "complete_reply") return;
        if (settled) return;
        settled = true;
        cleanup();
        try { ws.close(); } catch {}
        const matches = Array.isArray(data.content.matches) ? (data.content.matches as string[]) : [];
        const cursorStart = typeof data.content.cursor_start === "number" ? data.content.cursor_start as number : 0;
        const cursorEnd = typeof data.content.cursor_end === "number" ? data.content.cursor_end as number : cursorPos;
        const status = typeof data.content.status === "string" ? data.content.status as string : "ok";
        resolve({ matches, cursorStart, cursorEnd, status });
      });
      ws.addEventListener("error", () => {
        cleanup();
        if (!settled) { settled = true; reject(new Error(`kernel WebSocket error (kernel ${kid})`)); }
      });
      ws.addEventListener("close", () => {
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error(`kernel WebSocket closed before complete completed`));
        }
      });
    });
  }

  async #executeViaWebSocket(source: string, timeoutMs = 30_000): Promise<CellOutput[]> {
    await this.start();
    const kid = this.#kernelId!;
    const sessionId = `jupibuddy-${Date.now()}`;
    const wsUrl = `${this.#baseUrl!.replace(/^http/, "ws")}/api/kernels/${kid}/channels?session_id=${sessionId}${this.#token ? `&token=${this.#token}` : ""}`;

    const outputs: CellOutput[] = [];
    let executionCount: number | null = null;

    return await new Promise<CellOutput[]>((resolve, reject) => {
      // Bun-native WebSocket
      const ws = new WebSocket(wsUrl);
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msgSession = sessionId;
      let idleSeen = false;
      let shellReplyReceived = false;
      let settled = false;

      const maybeDone = () => {
        if (idleSeen && shellReplyReceived && !settled) {
          settled = true;
          try { ws.close(); } catch { /* ignore */ }
          resolve(outputs);
        }
      };

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error(`execute timeout (${Math.round(timeoutMs / 1000)}s) — kernel did not go idle`));
        }
      }, timeoutMs);

      const cleanup = () => clearTimeout(timer);

      ws.addEventListener("open", () => {
        // Send execute_request on the shell channel
        const msg = {
          header: { msg_id: msgId, session: msgSession, username: "jupibuddy", msg_type: "execute_request", version: "5.4" },
          parent_header: {},
          metadata: {},
          content: {
            code: source,
            silent: false,
            store_history: true,
            user_expressions: {},
            allow_stale: false,
            // nbclient default: a failing cell stops queued execution (client.py:984).
            stop_on_error: true,
          },
          channel: "shell",
        };
        // Exercise pause()/resume() backpressure seam: pause briefly before sending
        // to demonstrate the mechanism (no-op at this message size, but keeps the
        // code honest for larger payloads). The Bun WebSocket exposes bufferedAmount.
        try {
          // If the socket is buffering, wait for drain (backpressure)
          if (((ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0) > 0) {
            setTimeout(() => ws.send(JSON.stringify(msg)), 10);
          } else {
            ws.send(JSON.stringify(msg));
          }
        } catch (e) {
          cleanup();
          if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); }
        }
      });

      ws.addEventListener("message", (event) => {
        let data: { header: { msg_type: string }; parent_header: { msg_id?: string }; content: Record<string, unknown>; channel?: string; buffers?: unknown[] };
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }

        const msgType = data.header?.msg_type;
        const parentId = data.parent_header?.msg_id;

        // Every message must belong to THIS execution. jupyter_server broadcasts
        // iopub to every connected client unfiltered (channels.py:623-644), so a
        // foreign `status: idle` from another client's execution would end this
        // one early, with only half the outputs. nbclient filters on
        // parent_header.msg_id for every iopub and shell message
        // (client.py:783,814,886) — do the same here.
        if (parentId !== msgId) return;

        switch (msgType) {
          case "status": {
            const state = (data.content.execution_state as string) ?? "";
            if (state === "idle") {
              idleSeen = true;
              maybeDone();
            }
            break;
          }
          case "execute_input": {
            const n = data.content.execution_count as number | undefined;
            if (typeof n === "number") executionCount = n;
            break;
          }
          case "stream": {
            const text = (data.content.text as string) ?? "";
            const name = (data.content.name as string) ?? "stdout";
            outputs.push({ kind: "stream", name, text });
            break;
          }
          case "execute_result": {
            const d = (data.content.data as Record<string, string> | undefined) ?? {};
            const n = data.content.execution_count as number | undefined;
            if (typeof n === "number") executionCount = n;
            outputs.push({
              kind: "result",
              data: d,
              execution_count: (n as number | null) ?? executionCount ?? null,
              metadata: (data.content.metadata as Record<string, unknown>) ?? {},
            });
            break;
          }
          case "display_data": {
            const d = (data.content.data as Record<string, string> | undefined) ?? {};
            outputs.push({
              kind: "result",
              data: d,
              execution_count: null,
              metadata: (data.content.metadata as Record<string, unknown>) ?? {},
            });
            break;
          }
          case "error": {
            const ename = (data.content.ename as string) ?? "Error";
            const evalue = (data.content.evalue as string) ?? "";
            const traceback = (data.content.traceback as string[] | undefined) ?? [];
            outputs.push({ kind: "error", ename, evalue, traceback });
            break;
          }
          case "execute_reply": {
            // Final shell reply for this execution
            shellReplyReceived = true;
            // execution_count may be in content; prefer IOPub's execute_input if available
            if (executionCount === null && typeof data.content.execution_count === "number") {
              executionCount = data.content.execution_count as number;
            }
            // If outputs is empty and status is error, jupyter_server may have sent error only on shell
            if (outputs.length === 0 && (data.content.status as string) === "error") {
              const ename = (data.content.ename as string) ?? "Error";
              const evalue = (data.content.evalue as string) ?? "";
              const traceback = (data.content.traceback as string[] | undefined) ?? [];
              outputs.push({ kind: "error", ename, evalue, traceback });
            }
            maybeDone();
            break;
          }
          default:
            // Ignore unknown msg_types (forward-compat); kernel_info etc.
            break;
        }
      });

      ws.addEventListener("error", () => {
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error(`kernel WebSocket error (kernel ${kid})`));
        }
      });

      ws.addEventListener("close", () => {
        cleanup();
        if (!settled) {
          // If we already got idle+reply, this is expected close; otherwise treat as done with what we have
          if (idleSeen || shellReplyReceived) {
            settled = true;
            resolve(outputs);
          } else if (!settled) {
            settled = true;
            reject(new Error(`kernel WebSocket closed before execute completed`));
          }
        }
      });
    });
  }

  async interrupt(): Promise<void> {
    if (!this.#kernelId || !this.#baseUrl) return;
    try {
      await this.#fetchJson(`/api/kernels/${this.#kernelId}/interrupt`, { method: "POST" });
    } catch {
      // interrupt is best-effort
    }
  }

  async restart(): Promise<void> {
    if (!this.#kernelId || !this.#baseUrl) {
      // No kernel yet — ensure one is created
      await this.#ensureKernel();
      return;
    }
    try {
      const model = (await this.#fetchJson(`/api/kernels/${this.#kernelId}/restart`, { method: "POST" })) as {
        id: string;
      };
      // restart returns new model; keep same ID (jupyter_server preserves it)
      if (model?.id) this.#kernelId = model.id;
    } catch (e) {
      // If restart fails (dead kernel), try to recreate
      this.#kernelId = null;
      await this.#ensureKernel();
      throw e;
    }
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#kernelId && this.#baseUrl) {
      try {
        await fetch(`${this.#baseUrl}/api/kernels/${this.#kernelId}`, {
          method: "DELETE",
          headers: this.#headers(),
        });
      } catch {
        // ignore
      }
    }
    this.#kernelId = null;
    if (this.#proc) {
      try {
        this.#proc.kill();
      } catch {
        // ignore
      }
      this.#proc = null;
    }
    // Also kill jupyter_server child process explicitly (Bun.spawn doesn't auto-reap on GC)
    this.#baseUrl = null;
    this.#shuttingDown = false;
  }

  status() {
    return { state: this.#state, kernel: this.name } as const;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the appropriate kernel for this machine.
 *
 * - If JUPI_KERNEL_STUB=1, always return EchoKernel (for tests without Python).
 * - Otherwise, auto-resolve the best Python and return a JupyterServerKernel.
 *   If no interpreter is found or jupyter_server is missing, the sidecar will
 *   fail with an actionable error when started (NOT at factory time — this
 *   keeps `bun check` and imports cheap).
 */
export function createKernel(workspaceRoot?: string): Kernel {
  const stubFlag = process.env.JUPI_KERNEL_STUB ?? Bun.env.JUPI_KERNEL_STUB;
  if (stubFlag === "1" || stubFlag === "true") {
    return new EchoKernel();
  }
  // Sync factory for cases where async boot isn't possible (e.g. direct import in tests).
  // JUPI_PYTHON = which interpreter runs jupyter_server; JUPI_KERNEL = kernelspec name.
  // If JUPI_PYTHON is set, it determines the server's python, but the kernelspec name
  // stays "python3" (or whatever JUPI_KERNEL says) — JUPI_PYTHON does not invent a new spec.
  const envPython = process.env.JUPI_PYTHON ?? Bun.env.JUPI_PYTHON;
  const envKernel = process.env.JUPI_KERNEL ?? Bun.env.JUPI_KERNEL;
  const ws = workspaceRoot ?? Bun.env.JUPI_WORKSPACE ?? process.env.JUPI_WORKSPACE ?? "";

  if (envPython) {
    return new JupyterServerKernel(envPython, envKernel ?? "python3", ws || getWorkspaceRoot());
  }
  return new JupyterServerKernel("python3", envKernel ?? "python3", ws || getWorkspaceRoot());
}

/**
 * Async factory: resolves the best Python first, then creates the sidecar
 * with the correctly-discovered interpreter. Preferred for production boot.
 */
export async function createKernelAsync(workspaceRoot?: string): Promise<Kernel> {
  const stubFlag = process.env.JUPI_KERNEL_STUB ?? Bun.env.JUPI_KERNEL_STUB;
  if (stubFlag === "1" || stubFlag === "true") {
    return new EchoKernel();
  }
  const ws = workspaceRoot ?? Bun.env.JUPI_WORKSPACE ?? process.env.JUPI_WORKSPACE ?? getWorkspaceRoot();
  const best = await resolveBest({ workspaceRoot: ws });
  if (!best) {
    // No Python found at all — return a kernel that will error helpfully
    const errPy = process.env.JUPI_PYTHON ?? Bun.env.JUPI_PYTHON ?? "python3";
    const k = new JupyterServerKernel(errPy, "python3", ws);
    // Attach an explanatory selectedSpec so status reports the problem
    (k as unknown as { _resolveError: string })._resolveError =
      "No Python interpreter found. Set JUPI_PYTHON to an interpreter path.";
    return k;
  }
  // JUPI_PYTHON means "run the server on this interpreter"; the kernelspec name is
  // independent (JUPI_KERNEL or default "python3" available on that server).
  const kernelName = process.env.JUPI_KERNEL ?? Bun.env.JUPI_KERNEL ?? "python3";
  // Use the resolved python for the server, but keep selectedSpec for notebook metadata
  const kernel = new JupyterServerKernel(best.pythonPath, kernelName, ws, best.displayName);
  kernel.selectedSpec = best;
  return kernel;
}

function getWorkspaceRoot(): string {
  return Bun.env.JUPI_WORKSPACE ?? process.env.JUPI_WORKSPACE ?? Bun.env.HOME ?? process.env.HOME ?? "/tmp";
}
