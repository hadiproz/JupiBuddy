// PTY wrapper around Bun.Terminal — one shell per WebSocket connection (v1).
//
// Bun.Terminal is the built-in pseudo-terminal (no node-pty, no native dep).
// The server owns the child process; the browser is only a renderer that
// forwards keystrokes and size changes. See dev-notes/BUN-NOTES.md section
// "Bun.Terminal" for the platform notes this module follows.
//
// Exit-code note: Bun.Terminal's own `exit` callback reports PTY lifecycle
// status (0 = EOF, 1 = error), NOT the subprocess exit code — so this module
// never subscribes to it and reads `proc.exited` instead.
//
// Lifecycle: createTerminal() spawns immediately and throws if the spawn
// fails (the caller maps that to an honest 503 before upgrading the socket).
// kill() is idempotent and suppresses the onExit callback (we initiated it).
//
// Spawn form matters: the inline `terminal: {...}` options make Bun set up the
// PTY as the child's controlling terminal, so the shell gets job control
// (Ctrl-C, fg/bg). Passing a pre-constructed `new Bun.Terminal()` as
// `terminal:` skips that setup — bash then prints "no job control in this
// shell" and Ctrl-C never reaches the child. Verified 2026-10-31 on 1.4.4.

export interface TerminalSessionOptions {
  /** Working directory for the shell — the notebook workspace root. */
  cwd: string;
  cols?: number;
  rows?: number;
  /** Shell binary; defaults to $SHELL, then /bin/bash. */
  shell?: string;
  /** Extra env vars merged over process.env (TERM is set to xterm-256color). */
  env?: Record<string, string | undefined>;
  /** Decoded output chunks from the child (stdout + stderr + terminal echo). */
  onData: (chunk: string) => void;
  /** Real subprocess exit code; fired once unless kill() was called first. */
  onExit: (code: number) => void;
}

export interface TerminalSession {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly closed: boolean;
  /** Forward keystrokes / paste to the child's stdin. */
  write(data: string): void;
  /** Resize the PTY (values are clamped to a sane range). */
  resize(cols: number, rows: number): void;
  /** Terminate the child and close the PTY (idempotent). */
  kill(): void;
}

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function createTerminal(opts: TerminalSessionOptions): TerminalSession {
  const cwd = opts.cwd?.trim();
  if (!cwd) throw new Error("createTerminal: cwd is required");

  const shell = opts.shell ?? process.env.SHELL ?? "/bin/bash";
  let currentCols = clampInt(opts.cols, DEFAULT_COLS, MIN_COLS, MAX_COLS);
  let currentRows = clampInt(opts.rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
  const decoder = new TextDecoder();
  let closed = false;

  // Inline terminal options (NOT a pre-built Bun.Terminal) — see header note.
  const proc = Bun.spawn([shell], {
    cwd,
    env: { ...process.env, TERM: "xterm-256color", ...(opts.env ?? {}) },
    terminal: {
      cols: currentCols,
      rows: currentRows,
      data(_terminal, data) {
        // stream:true keeps split multi-byte UTF-8 sequences intact.
        const text = decoder.decode(data, { stream: true });
        if (text) opts.onData(text);
      },
    },
  });

  const term = proc.terminal;
  if (!term) {
    try { proc.kill(); } catch { /* already dead */ }
    throw new Error("createTerminal: PTY was not attached to the shell process");
  }

  proc.exited
    .then((code) => {
      if (closed) return; // kill() owns this path
      closed = true;
      const tail = decoder.decode();
      if (tail) opts.onData(tail);
      try { term.close(); } catch { /* already gone */ }
      opts.onExit(code);
    })
    .catch(() => {
      if (closed) return;
      closed = true;
      try { term.close(); } catch { /* already gone */ }
      opts.onExit(-1);
    });

  return {
    get pid() {
      return proc.pid;
    },
    get cols() {
      return currentCols;
    },
    get rows() {
      return currentRows;
    },
    get closed() {
      return closed;
    },
    write(data: string) {
      if (closed || !data) return;
      try {
        term.write(data);
      } catch {
        // child already gone — the exit callback reports it
      }
    },
    resize(cols: number, rows: number) {
      if (closed) return;
      currentCols = clampInt(cols, currentCols, MIN_COLS, MAX_COLS);
      currentRows = clampInt(rows, currentRows, MIN_ROWS, MAX_ROWS);
      try {
        term.resize(currentCols, currentRows);
      } catch {
        // PTY already closed
      }
    },
    kill() {
      if (closed) return;
      closed = true;
      try { proc.kill(); } catch { /* already dead */ }
      try { term.close(); } catch { /* already closed */ }
    },
  };
}
