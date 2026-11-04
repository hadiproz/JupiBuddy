// NotebookService — owns document model, kernel session, workspace root.
// Single-active notebook in v1. Single-writer queue for agent actions;
// human typing/editing is never blocked. Every cell records its writer.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, stat, open, rename, copyFile, unlink, rm } from "node:fs/promises";
import { resolve, join, relative, basename, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { Notebook, type Cell, type CellOutput, type CellType } from "./notebook";
import type { Kernel } from "./kernel";
import { resolveBest } from "./kernelResolve";
import { extensionForMime, isTextLikeMime } from "./format";

function outputText(o: CellOutput): string {
  if (o.kind === "stream") return o.text;
  if (o.kind === "error") return `${o.ename}: ${o.evalue}\n${o.traceback.join("\n")}`.trim();
  // result: prefer text/plain
  return o.data["text/plain"] ?? o.data["text/html"] ?? o.data["text/markdown"] ?? JSON.stringify(o.data);
}

function toPosixPath(p: string): string {
  return p.split("\\").join("/");
}

import type { JupiConfig } from "../config";

// Writer attribution for every cell
export type Writer = "human" | "internal-agent" | "external-agent";
export type AgentMode = "chat-only" | "mcp-only" | "hybrid";

// Structural ops accept a raw type string from HTTP/MCP and must reject
// typos instead of silently degrading them to "code" (insertCell's fallback).
function parseCellType(type: unknown): CellType {
  if (type === "code" || type === "markdown" || type === "raw") return type;
  throw new Error(`invalid cell type: ${String(type)} (expected code, markdown, or raw)`);
}

// Extended cell with attribution metadata (kept alongside Notebook cells)
export interface AttributedCell extends Cell {
  writer: Writer;
}

// One undoable step: the inverse of a mutation, recorded before it happens.
// Agent runs build one entry per run; human structural edits (A9) push one
// entry per operation. Same shape for both, so a single applier restores
// either. Optional members are only filled by the writer that can restore
// that detail — the human delete/join snapshot carries outputs + metadata,
// the agent one carries source/type only (its documented limit).
export interface UndoSnapshot {
  /** cellId -> source before the change */
  edits: Map<string, string>;
  /** cells created by the mutation (removed again on undo) */
  insertedIds: string[];
  /** cells removed by the mutation, with everything needed to reinsert them */
  deletedSnap?: Map<
    string,
    {
      source: string;
      type: CellType;
      index: number;
      outputs?: CellOutput[];
      executionCount?: number | null;
      metadata?: Record<string, unknown>;
    }
  >;
  /** cellId -> type before a change-type */
  typeSnap?: Map<string, CellType>;
  /** former indexes, newest last (unwound in reverse) */
  moves?: Array<{ id: string; from: number }>;
  /** cellId -> outputs/executionCount removed by a clear */
  clearedSnap?: Map<string, { outputs: CellOutput[]; executionCount: number | null }>;
}

// A cell captured before a human structural mutation — everything needed to
// put it back exactly as it was (outputs and metadata included).
export interface CellSnapshot {
  source: string;
  type: CellType;
  index: number;
  outputs: CellOutput[];
  executionCount: number | null;
  metadata?: Record<string, unknown>;
}

// Resolve a user-supplied path inside the workspace root.
// Guards: reject escapes via .., reject absolute paths outside root,
// reject symlinks (including intermediate components) that point outside root.
export function resolveInsideWorkspace(
  workspaceRoot: string,
  userPath: string,
): string {
  if (!workspaceRoot) throw new Error("no workspace open");
  const root = resolve(workspaceRoot);
  let abs: string;
  if (userPath.startsWith("/")) {
    abs = resolve(userPath);
  } else {
    abs = resolve(root, userPath);
  }
  // Guard: must be inside root (no .. escapes, no absolute outside)
  const rel = relative(root, abs);
  if (rel.startsWith("..") || (abs !== root && !abs.startsWith(root + "/"))) {
    throw new Error(`path escapes workspace root: ${userPath}`);
  }
  // Guard: symlinks in any path component that escape root
  // Walk from root down to abs, checking each existing prefix that is a symlink
  try {
    const parts = abs.slice(root.length).split("/").filter(Boolean);
    let cur = root;
    for (const part of parts) {
      cur = join(cur, part);
      if (!existsSync(cur)) break; // remaining components don't exist yet — no symlink to check
      try {
        const st = lstatSync(cur);
        if (st.isSymbolicLink()) {
          const target = readlinkTarget(cur);
          if (target) {
            const realPath = resolve(dirname(cur), target);
            // If symlink target plus remaining unresolved suffix escapes root, reject
            // Check realPath itself
            const realRel = relative(root, realPath);
            if (
              realRel.startsWith("..") ||
              (realPath !== root && !realPath.startsWith(root + "/"))
            ) {
              throw new Error(`symlink escapes workspace root: ${userPath}`);
            }
            // Also check realpath of the symlink fully resolved (in case of chained symlinks)
            try {
              const { realpathSync } = require("node:fs");
              const fullReal = realpathSync(cur, "utf8") as string;
              const fullRel = relative(root, resolve(fullReal));
              if (
                fullRel.startsWith("..") ||
                (resolve(fullReal) !== root && !resolve(fullReal).startsWith(root + "/"))
              ) {
                throw new Error(`symlink escapes workspace root: ${userPath}`);
              }
            } catch (e) {
              if (e instanceof Error && e.message.includes("escapes workspace")) throw e;
            }
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("escapes workspace")) throw e;
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("escapes workspace")) throw e;
  }
  return abs;
}

function readlinkTarget(p: string): string | null {
  try {
    const { readlinkSync } = require("node:fs");
    return readlinkSync(p, "utf8") as string;
  } catch {
    return null;
  }
}

// Check if path is inside workspace without throwing (for explorer filtering)
export function isInsideWorkspace(workspaceRoot: string, absPath: string): boolean {
  const root = resolve(workspaceRoot);
  const abs = resolve(absPath);
  if (abs === root) return true;
  return abs.startsWith(root + "/");
}

// ---------------------------------------------------------------------------
// NotebookService
// ---------------------------------------------------------------------------

/**
 * Live progress of one `runCells` call. `runProgress` is null whenever no run
 * is in flight, so the field itself is the idle/running signal. `done`/`total`
 * count CODE cells only: markdown and raw cells in the range are skipped by
 * the executor and must not inflate the bar.
 */
export interface RunProgress {
  startedAt: number;
  from: number;
  to: number;
  done: number;
  total: number;
  currentId: string | null;
  currentIndex: number | null;
}

export class NotebookService {
  // --- owned state ---
  workspaceRoot: string | null = null;
  notebook: Notebook | null = null;
  kernel: Kernel | null = null;
  // absolute path of currently open notebook file, if any
  notebookPath: string | null = null;
  dirty = false;
  revision = 0;
  // attribution by cell ID
  attribution = new Map<string, Writer>();
  // cells currently being executed by agent (read-only guard)
  executingCells = new Set<string>();
  // live progress of the current runCells call; null when no run is in flight
  runProgress: RunProgress | null = null;
  // mode gating
  mode: AgentMode;
  // single-writer queue: chained promise for agent operations
  #queue: Promise<void> = Promise.resolve();
  // active writer context for attribution (set during enqueue)
  #activeWriter: Writer | null = null;

  // --- supervision: doorbell queue / cancel / approvals / undo ---
  // doorbell: only one agent run at a time; second parks as pending
  #agentBusy = false;
  #currentRunId: string | null = null;
  #cancelController: AbortController | null = null;
  // pending doorbell items
  pendingQueue: Array<{
    queueId: string;
    task: string;
    provider: string;
    activeCellIndex?: number | null;
    requireApproval?: boolean;
    status: "queued" | "reclaimed" | "steered";
  }> = [];
  // steer buffer for running turn
  steerBuffer: string[] = [];
  steeredFlag = false;
  // approval waiting
  #pendingApproval: {
    runId: string;
    tool: string;
    argsPreview: string;
    resolve: (d: "approve" | "deny") => void;
    timer?: ReturnType<typeof setTimeout>;
  } | null = null;
  // approvals history for session (per-run)
  currentApprovals: Array<{ tool: string; decision: string }> = [];
  // undo snapshots: history of last runs (each is map of cellId->source before
  // change + inserted ids + the cells the run deleted, replayable on undo)
  undoStack: UndoSnapshot[] = [];
  // human structural edits (A9): one inverse per delete/move/change-type/
  // split/join/clear. Kept apart from the agent-run stack so an agent undo
  // never resurrects a human action and vice versa.
  humanUndoStack: UndoSnapshot[] = [];
  // redo history (A9): the inverse of every human undo, so an accidental undo
  // can be walked forward again. Any new human edit forks the history and
  // clears this branch; the cap matches the undo stack.
  humanRedoStack: UndoSnapshot[] = [];
  // Coalescing marker for human text edits: the editor debounces typing
  // (~600ms), so a burst on one cell must collapse into a single undo step or
  // the depth-20 stack floods on one sentence. Holds the cell and push time of
  // the newest human stack entry; null when that entry is not a plain edit.
  #humanEditTop: { cellId: string; at: number } | null = null;
  // current run snapshot being built
  #curUndoEdits: Map<string, string> | null = null;
  #curUndoInserted: Set<string> | null = null;
  #curUndoDeleted: Map<string, { source: string; type: CellType; index: number }> | null = null;
  #curUndoTypes: Map<string, CellType> | null = null;
  #curUndoMoves: Array<{ id: string; from: number }> | null = null;

  constructor(opts: {
    workspaceRoot?: string | null;
    mode?: AgentMode;
  }) {
    this.workspaceRoot = opts.workspaceRoot ?? null;
    this.mode = opts.mode ?? "hybrid";
  }

  // Current writer context — handlers read this for attribution
  get currentWriter(): Writer | null {
    return this.#activeWriter;
  }

  // Run fn with writer context
  async withWriter<T>(writer: Writer, fn: () => Promise<T>): Promise<T> {
    const prev = this.#activeWriter;
    this.#activeWriter = writer;
    try {
      return await fn();
    } finally {
      this.#activeWriter = prev;
    }
  }

  // --- workspace ---

  async openWorkspace(path: string): Promise<{ ok: boolean; workspaceRoot: string; needsConfirm?: boolean; message?: string }> {
    const abs = resolve(path);
    // Verify it exists and is directory
    try {
      const st = await stat(abs);
      if (!st.isDirectory()) throw new Error(`not a directory: ${abs}`);
    } catch (e) {
      if (e instanceof Error && e.message.includes("not a directory")) throw e;
      throw new Error(`workspace path does not exist: ${abs}`);
    }
    // Never discard unsaved edits: same needs-confirm contract as closeNotebook.
    // Checked BEFORE any state is reset, so the open notebook and its edits survive.
    if (this.dirty && this.notebook) {
      return {
        ok: false,
        workspaceRoot: this.workspaceRoot ?? abs,
        needsConfirm: true,
        message: `notebook has unsaved changes (${this.notebookPath}); save or close it before opening another workspace`,
      };
    }
    // Record recent
    this.workspaceRoot = abs;
    this.notebook = null;
    this.notebookPath = null;
    this.dirty = false;
    this.#bumpRevision();
    await this.#persistRecent(abs).catch(() => {});
    return { ok: true, workspaceRoot: abs };
  }

  // Create a new folder under $HOME with Untitled.ipynb and open it
  async createNewWorkspace(name: string): Promise<{ ok: boolean; workspaceRoot: string; notebookPath: string }> {
    if (!name || name.includes("/") || name.includes("..") || name.includes("\0")) {
      throw new Error(`invalid workspace name: ${name}`);
    }
    const home = homedir();
    const dir = join(home, name);
    if (existsSync(dir)) throw new Error(`path already exists: ${dir}`);
    await mkdir(dir, { recursive: true });
    const nbPath = join(dir, "Untitled.ipynb");
    const fresh = new Notebook();
    fresh.appendCell("code", "");
    await writeFile(nbPath, JSON.stringify(fresh.toIpynb(), null, 2), "utf-8");
    // Open as workspace
    this.workspaceRoot = dir;
    await this.#persistRecent(dir).catch(() => {});
    await this.openNotebook("Untitled.ipynb", "human");
    return { ok: true, workspaceRoot: dir, notebookPath: nbPath };
  }

  // --- notebook lifecycle ---

  async openNotebook(relPath: string, writer: Writer): Promise<{ ok: boolean; path: string; cells: number }> {
    if (!this.workspaceRoot) throw new Error("no workspace open — open a folder first");
    const abs = resolveInsideWorkspace(this.workspaceRoot, relPath);
    // If same file already open and not dirty, just return
    if (this.notebook && this.notebookPath === abs) {
      return { ok: true, path: abs, cells: this.notebook.cells.length };
    }
    // If dirty, require close first (caller should handle close-dirty flow)
    if (this.dirty && this.notebook) {
      // We don't auto-close dirty; caller must closeNotebook first
      throw new Error(`close current notebook first (dirty: ${this.notebookPath})`);
    }
    // Shutdown previous kernel if exists
    if (this.kernel) {
      try { await this.kernel.shutdown?.(); } catch { /* ignore */ }
      this.kernel = null;
    }
    // Load file
    const nb = await this.#loadNotebookFile(abs);
    this.notebook = nb;
    this.notebookPath = abs;
    this.dirty = false;
    this.attribution.clear();
    // Attribute initial cells to the opener
    for (const c of nb.cells) this.attribution.set(c.id, writer);
    this.#bumpRevision();

    // Cold start (owner 2026-11-02): NO auto-boot, ever. Every opened notebook
    // shows "Select Kernel" until the user picks one explicitly. The user
    // chooses agkit themselves; guessing miniconda3 was wrong.
    // (One kernel per notebook, BRIEF §15, still holds — selection just
    // always comes from the user, never from resolveBest.)
    return { ok: true, path: abs, cells: nb.cells.length };
  }

  // Parse an .ipynb file into a fresh Notebook. Shared by openNotebook and
  // revertNotebook so both read a document exactly the same way. A missing
  // file yields a blank one-cell notebook (openNotebook's create-on-open
  // behaviour); revertNotebook checks existence first and never gets here.
  async #loadNotebookFile(abs: string): Promise<Notebook> {
    const nb = new Notebook();
    if (!existsSync(abs)) {
      // File does not exist yet — create blank notebook
      nb.appendCell("code", "");
      return nb;
    }
    const raw = await readFile(abs, "utf-8");
    const parsed = JSON.parse(raw) as {
      cells?: Array<{
        cell_type: string;
        source: string | string[];
        id?: string;
        metadata?: Record<string, unknown>;
        outputs?: unknown[];
        execution_count?: number | null;
      }>;
      metadata?: Record<string, unknown> & {
        kernelspec?: { display_name: string; language: string; name: string };
      };
    };
    if (parsed.cells && Array.isArray(parsed.cells)) {
      for (const c of parsed.cells) {
        const source = Array.isArray(c.source) ? c.source.join("") : (c.source ?? "");
        // Notebook insert generates new IDs; we preserve original IDs where valid
        const cellType = c.cell_type === "markdown" ? "markdown" : "code";
        const cell = nb.appendCell(cellType as CellType, source);
        // Preserve original id if it looks valid (nbformat 4.5 allows [a-zA-Z0-9-_]+)
        if (c.id && /^[a-zA-Z0-9-_]+$/.test(c.id) && c.id.length >= 1 && c.id.length <= 64) {
          if (c.id.startsWith("#jb-") || c.id.startsWith("#JB-")) {
            cell.id = c.id;
          } else {
            const bare = c.id.replace(/^jb-/i, "");
            if (/^[0-9a-f]{8}$/i.test(bare)) {
              cell.id = `#jb-${bare.toLowerCase()}`;
            } else {
              cell.id = `#JB-${bare}`;
            }
          }
        }
        if (c.execution_count !== undefined && c.execution_count !== null) {
          cell.executionCount = c.execution_count as number;
        }
        // A6: keep the cell's free-form metadata verbatim — tags, collapsed,
        // scrolled, Jupyter editable/deletable, attachments. toIpynb() writes
        // the field straight back, so load -> save no longer drops it.
        if (c.metadata && typeof c.metadata === "object" && !Array.isArray(c.metadata)) {
          cell.metadata = c.metadata;
        }
        // Restore outputs if present
        if (Array.isArray(c.outputs)) {
          for (const o of c.outputs as Array<Record<string, unknown>>) {
            if (o.output_type === "error") {
              const ename = String(o.ename ?? "Error");
              const evalue = String(o.evalue ?? "");
              const tb = Array.isArray(o.traceback) ? (o.traceback as unknown[]).map(String) : [];
              cell.outputs.push({ kind: "error", ename, evalue, traceback: tb });
            } else if (o.output_type === "stream") {
              const text = Array.isArray(o.text) ? (o.text as unknown[]).map(String).join("") : String(o.text ?? "");
              cell.outputs.push({ kind: "stream", name: String(o.name ?? "stdout"), text });
            } else if (o.output_type === "execute_result" || o.output_type === "display_data") {
              const data = (o.data as Record<string, string>) ?? {};
              cell.outputs.push({ kind: "result", data, execution_count: typeof o.execution_count === "number" ? o.execution_count : null });
            }
          }
        }
      }
      // A5: keep the whole document metadata object, not just kernelspec —
      // Colab provenance and any other key survive to the next save.
      if (parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)) {
        nb.metadata = parsed.metadata;
        if (parsed.metadata.kernelspec) nb.kernelspec = parsed.metadata.kernelspec;
      }
    }
    // Ensure at least one cell
    if (nb.cells.length === 0) nb.appendCell("code", "");
    return nb;
  }

  // Close current notebook. If dirty and force!=true, return needs-confirm.
  // Agent may only request close (force never true for agent writers — enforced here).
  async closeNotebook(opts: { writer: Writer; force?: boolean }): Promise<{ ok: boolean; closed?: boolean; needsConfirm?: boolean; message?: string }> {
    if (!this.notebook) return { ok: true, closed: false };
    const isHuman = opts.writer === "human";
    // Close-dirty ALWAYS requires explicit human confirm — agent may only request, never force
    if (this.dirty && (!opts.force || !isHuman)) {
      return {
        ok: false,
        closed: false,
        needsConfirm: true,
        message: `notebook has unsaved changes (${this.notebookPath}); close requires explicit human confirm`,
      };
    }
    // Human force or not dirty — proceed
    if (this.kernel) {
      try { await this.kernel.shutdown?.(); } catch { /* ignore */ }
      this.kernel = null;
    }
    this.notebook = null;
    this.notebookPath = null;
    this.dirty = false;
    this.attribution.clear();
    this.executingCells.clear();
    this.#bumpRevision();
    return { ok: true, closed: true };
  }

  // Save current notebook to disk (resolves inside workspace if relative)
  async saveNotebook(targetPath?: string): Promise<{ saved: string }> {
    if (!this.notebook) throw new Error("no notebook open");
    let abs: string;
    if (targetPath) {
      if (!this.workspaceRoot) throw new Error("no workspace open");
      abs = resolveInsideWorkspace(this.workspaceRoot, targetPath);
    } else if (this.notebookPath) {
      abs = this.notebookPath;
    } else {
      throw new Error("no notebook path — provide a path");
    }
    await writeFile(abs, JSON.stringify(this.notebook!.toIpynb(), null, 2), "utf-8");
    this.dirty = false;
    this.notebookPath = abs;
    this.#bumpRevision();
    return { saved: abs };
  }

  // A13 revert-to-saved: throw away in-memory state by re-reading the file
  // this notebook was opened from. The kernel keeps running — a revert is a
  // document operation, not a kernel operation. Every undo/redo entry is
  // dropped: each recorded inverse refers to the pre-revert document, so
  // keeping one would let a later undo (or redo) write cells that no longer
  // exist into the model.
  async revertNotebook(): Promise<{ ok: true; path: string; cells: number }> {
    if (!this.notebook) throw Object.assign(new Error("no notebook open"), { status: 404 });
    if (!this.notebookPath) {
      throw Object.assign(new Error("notebook has never been saved — nothing to revert to (save it first)"), { status: 400 });
    }
    const abs = this.notebookPath;
    if (!existsSync(abs)) {
      throw Object.assign(
        new Error(`saved notebook no longer exists on disk: ${abs} — save it to a path instead of reverting`),
        { status: 404 },
      );
    }
    const nb = await this.#loadNotebookFile(abs);
    // Assign only after a full parse, so a malformed file leaves the current
    // in-memory document untouched instead of half-replacing it.
    this.notebook = nb;
    this.dirty = false;
    this.undoStack.length = 0;
    this.humanUndoStack.length = 0;
    this.humanRedoStack.length = 0;
    this.#humanEditTop = null;
    this.attribution.clear();
    const writer = this.currentWriter ?? "human";
    for (const c of nb.cells) this.attribution.set(c.id, writer);
    this.#bumpRevision();
    return { ok: true, path: abs, cells: nb.cells.length };
  }

  // --- cell operations (mark dirty, record attribution) ---

  #markDirty(cellId: string, writer: Writer) {
    this.dirty = true;
    this.attribution.set(cellId, writer);
  }

  #bumpRevision() {
    this.revision++;
  }

  insertCell(index: number | undefined, type: string, source: string, writer: Writer) {
    if (!this.notebook) throw new Error("no notebook open");
    const cellType: CellType = type === "markdown" ? "markdown" : "code";
    const cell = index === undefined ? this.notebook.appendCell(cellType, source ?? "") : this.notebook.insertCell(index, cellType, source ?? "");
    // snapshot for undo if internal-agent during a run
    if (writer === "internal-agent" && this.#agentBusy) this.#recordInsert(cell.id);
    this.#markDirty(cell.id, writer);
    this.#bumpRevision();
    return { id: cell.id, index: this.notebook.indexOf(cell.id) };
  }

  editCell(cellId: string, source: string, writer: Writer) {
    if (!this.notebook) throw new Error("no notebook open");
    if (this.executingCells.has(cellId)) throw new Error(`cell ${cellId} is currently executing and is read-only`);
    if (writer === "internal-agent" && this.#agentBusy) this.#recordEditBeforeChange(cellId);
    else if (writer === "human") this.#recordHumanEdit(cellId);
    this.notebook.editCell(cellId, source);
    this.#markDirty(cellId, writer);
    this.#bumpRevision();
    return { id: cellId, index: this.notebook.indexOf(cellId) };
  }

  deleteCell(cellId: string, writer: Writer) {
    if (!this.notebook) throw new Error("no notebook open");
    if (this.executingCells.has(cellId)) throw new Error(`cell ${cellId} is currently executing and is read-only`);
    // Snapshot for undo — agent runs are scoped exactly like insert/edit:
    // internal-agent writes during an active run only. A human delete lands on
    // the human stack instead (A9), with outputs and metadata included.
    if (writer === "internal-agent" && this.#agentBusy) {
      if (this.#curUndoInserted?.has(cellId)) {
        // Inserted and deleted inside the same run: the net effect is nothing,
        // so drop the insert record instead of resurrecting it on undo.
        this.#curUndoInserted.delete(cellId);
      } else {
        this.#recordDelete(cellId);
      }
    } else if (writer === "human") {
      const snap = this.#snapshotCell(cellId);
      if (snap) this.#pushHumanUndo({ deletedSnap: new Map([[cellId, snap]]) });
    }
    const result = this.notebook.deleteCell(cellId);
    this.dirty = true;
    this.attribution.delete(cellId);
    this.#bumpRevision();
    return result;
  }

  // --- structural cell ops (F8): change type / move / split / join ---
  // All of them follow the edit/delete contract: executing cells are read-only,
  // the writer is recorded, and an internal-agent change during a run lands in
  // the undo snapshot so undo can put the document back.

  changeCellType(cellId: string, type: string, writer: Writer) {
    if (!this.notebook) throw new Error("no notebook open");
    if (this.executingCells.has(cellId)) throw new Error(`cell ${cellId} is currently executing and is read-only`);
    const cellType = parseCellType(type);
    const index = this.notebook.indexOf(cellId);
    if (index < 0) throw new Error(`cell not found: ${cellId}`);
    if (this.notebook.cells[index].type === cellType) {
      return { id: cellId, index, type: cellType, changed: false };
    }
    if (writer === "internal-agent" && this.#agentBusy) this.#recordTypeBeforeChange(cellId);
    else if (writer === "human") this.#pushHumanUndo({ typeSnap: new Map([[cellId, this.notebook.cells[index].type]]) });
    this.notebook.setCellType(cellId, cellType);
    this.#markDirty(cellId, writer);
    this.#bumpRevision();
    return { id: cellId, index, type: cellType, changed: true };
  }

  moveCell(cellId: string, target: { to?: number; direction?: "up" | "down" }, writer: Writer) {
    if (!this.notebook) throw new Error("no notebook open");
    const from = this.notebook.indexOf(cellId);
    if (from < 0) throw new Error(`cell not found: ${cellId}`);
    let to: number;
    if (target.direction !== undefined) {
      if (target.direction !== "up" && target.direction !== "down") {
        throw new Error(`invalid direction: ${String(target.direction)} (expected up or down)`);
      }
      // Directional moves clamp at the ends: pressing "up" on the first cell is
      // a no-op, not an error — the caller cannot know the boundary state.
      to = Math.max(0, Math.min(this.notebook.cells.length - 1, from + (target.direction === "up" ? -1 : 1)));
    } else if (target.to !== undefined) {
      to = target.to;
    } else {
      throw new Error("move requires to (0-based index) or direction (up|down)");
    }
    if (!Number.isInteger(to)) throw new Error(`to must be an integer (got ${to})`);
    if (to < 0 || to >= this.notebook.cells.length) {
      throw new Error(`to ${to} out of range (notebook has ${this.notebook.cells.length} cells)`);
    }
    if (to === from) return { id: cellId, from, to, moved: false };
    if (writer === "internal-agent" && this.#agentBusy) this.#recordMove(cellId, from);
    else if (writer === "human") this.#pushHumanUndo({ moves: [{ id: cellId, from }] });
    this.notebook.moveCell(cellId, to);
    this.#markDirty(cellId, writer);
    this.#bumpRevision();
    return { id: cellId, from, to, moved: true };
  }

  // Split a cell in two. `offset` is a character index into the source;
  // `line` is the 1-based line that starts the new cell. Exactly one is
  // required. The head keeps the ID (and outputs); the tail becomes a new cell
  // below it with a fresh ID (rule 1), the same type, and inherited metadata so
  // markdown attachments/tags survive the split.
  splitCell(cellId: string, at: { offset?: number; line?: number }, writer: Writer) {
    if (!this.notebook) throw new Error("no notebook open");
    if (this.executingCells.has(cellId)) throw new Error(`cell ${cellId} is currently executing and is read-only`);
    const index = this.notebook.indexOf(cellId);
    if (index < 0) throw new Error(`cell not found: ${cellId}`);
    const cell = this.notebook.cells[index];
    if (cell.source.length === 0) throw new Error(`cell ${cellId} is empty — nothing to split`);
    if ((at.offset === undefined) === (at.line === undefined)) {
      throw new Error("split requires exactly one of offset (character index) or line (1-based line the new cell starts at)");
    }
    let head: string;
    let tail: string;
    let offset: number;
    if (at.line !== undefined) {
      if (!Number.isInteger(at.line)) throw new Error(`line must be an integer (got ${at.line})`);
      const lines = cell.source.split("\n");
      // `line` is the 1-based line that starts the new cell: 1 moves the whole
      // source down, lines.length moves only the last line out.
      if (at.line < 1 || at.line > lines.length) {
        throw new Error(`line ${at.line} out of range (a ${lines.length}-line cell splits at lines 1..${lines.length})`);
      }
      head = lines.slice(0, at.line - 1).join("\n");
      tail = lines.slice(at.line - 1).join("\n");
      // the newline between the halves belongs to neither
      offset = at.line === 1 ? 0 : head.length + 1;
    } else {
      offset = at.offset!;
      if (!Number.isInteger(offset)) throw new Error(`offset must be an integer (got ${offset})`);
      if (offset < 0 || offset > cell.source.length) {
        throw new Error(`offset ${offset} out of range (source is ${cell.source.length} characters)`);
      }
      head = cell.source.slice(0, offset);
      tail = cell.source.slice(offset);
    }
    // A9 human split: the inverse is "restore the head's source and drop the
    // tail", so the original source is captured before the edit below.
    const beforeSplit = cell.source;
    if (writer === "internal-agent" && this.#agentBusy) this.#recordEditBeforeChange(cellId);
    this.notebook.editCell(cellId, head);
    const created = this.notebook.insertCell(index + 1, cell.type, tail, cell.metadata ? { ...cell.metadata } : undefined);
    if (writer === "internal-agent" && this.#agentBusy) this.#recordInsert(created.id);
    else if (writer === "human") {
      this.#pushHumanUndo({ edits: new Map([[cellId, beforeSplit]]), insertedIds: [created.id] });
    }
    this.#markDirty(cellId, writer);
    this.#markDirty(created.id, writer);
    this.#bumpRevision();
    return { id: cellId, index, newCellId: created.id, newCellIndex: index + 1, offset };
  }

  // Join cells into the earliest one, in notebook order, separated by newlines.
  // `direction` joins the anchor with its neighbour; `with` joins an explicit
  // selection (>= 2 IDs, anchor ignored). Sources only — the joined-away cells'
  // outputs are dropped. A human join is undoable with outputs restored (A9);
  // the agent-run snapshot stays source-only, as it always was.
  joinCells(cellId: string, writer: Writer, opts?: { direction?: "next" | "previous"; with?: string[] }) {
    if (!this.notebook) throw new Error("no notebook open");
    const nb = this.notebook;
    let ids: string[];
    if (opts?.with !== undefined) {
      if (!Array.isArray(opts.with) || opts.with.length < 2) {
        throw new Error("join with a selection requires at least two cell IDs");
      }
      if (new Set(opts.with).size !== opts.with.length) throw new Error("join cell IDs must be distinct");
      for (const id of opts.with) {
        if (nb.indexOf(id) < 0) throw new Error(`cell not found: ${id}`);
      }
      ids = opts.with;
    } else {
      const direction = opts?.direction ?? "next";
      if (direction !== "next" && direction !== "previous") {
        throw new Error(`invalid direction: ${String(direction)} (expected next or previous)`);
      }
      const anchor = nb.indexOf(cellId);
      if (anchor < 0) throw new Error(`cell not found: ${cellId}`);
      const other = nb.cells[anchor + (direction === "next" ? 1 : -1)];
      if (!other) {
        throw new Error(
          direction === "next"
            ? `cell ${cellId} is the last cell — nothing to join below`
            : `cell ${cellId} is the first cell — nothing to join above`,
        );
      }
      ids = [cellId, other.id];
    }
    ids = [...ids].sort((a, b) => nb.indexOf(a) - nb.indexOf(b));
    for (const id of ids) {
      if (this.executingCells.has(id)) throw new Error(`cell ${id} is currently executing and is read-only`);
    }
    const survivorId = ids[0];
    const survivorIndex = nb.indexOf(survivorId);
    const merged = ids.map((id) => nb.cells[nb.indexOf(id)].source).join("\n");
    if (writer === "internal-agent" && this.#agentBusy) {
      this.#recordEditBeforeChange(survivorId);
      for (const id of ids.slice(1)) this.#recordDelete(id);
    } else if (writer === "human") {
      // A9 human join: the inverse is "restore the survivor's source and
      // reinsert the joined-away cells with their outputs and metadata".
      const beforeJoin = nb.cells[survivorIndex].source;
      const deletedSnap = new Map<string, CellSnapshot>();
      for (const id of ids.slice(1)) {
        const snap = this.#snapshotCell(id);
        if (snap) deletedSnap.set(id, snap);
      }
      this.#pushHumanUndo({ edits: new Map([[survivorId, beforeJoin]]), deletedSnap });
    }
    nb.editCell(survivorId, merged);
    const removed: string[] = [];
    for (const id of ids.slice(1)) {
      nb.deleteCell(id);
      this.attribution.delete(id);
      removed.push(id);
    }
    this.#markDirty(survivorId, writer);
    this.#bumpRevision();
    return { id: survivorId, index: survivorIndex, removed };
  }

  // Per-cell clear (F9). The agent-run snapshot is source-oriented, so an agent
  // clear records nothing and its undo restores sources only. A human clear
  // (A9) records the removed outputs + execution count, so undo brings them
  // back. A clear that removes nothing (no outputs, no count) leaves the
  // document clean instead of faking dirty the way the old UI did.
  clearCellOutputs(cellId: string, writer: Writer) {
    if (!this.notebook) throw new Error("no notebook open");
    if (this.executingCells.has(cellId)) throw new Error(`cell ${cellId} is currently executing and is read-only`);
    const index = this.notebook.indexOf(cellId);
    if (index < 0) throw new Error(`cell not found: ${cellId}`);
    const cell = this.notebook.cells[index];
    const cleared = cell.outputs.length;
    if (cleared === 0 && cell.executionCount === null) return { id: cellId, index, cleared: 0 };
    if (writer === "human") {
      this.#pushHumanUndo({
        clearedSnap: new Map([[cellId, { outputs: cell.outputs.map((o) => ({ ...o })), executionCount: cell.executionCount }]]),
      });
    }
    this.notebook.clearOutputs(cellId);
    this.#markDirty(cellId, writer);
    this.#bumpRevision();
    return { id: cellId, index, cleared };
  }

  // --- output artifacts: mirror jupyter-vscode-mcp jupyterApi.ts:501-539 + format.ts:18-39 ---
  // Writes each output item to <workspace>/.jupibuddy/artifacts/<notebook>-c<cell>-o<out>-i<item>.<ext>
  // Text mimes inline if ≤8KB (same threshold), else preview ≤1000 chars + artifactPath.
  // Ref: /mnt/e/agent-playground/jupyter-mcp-vscode/jupyter-mcp-vscode-release/src/jupyterApi.ts:501-539
  // Ref: /mnt/e/agent-playground/jupyter-mcp-vscode/jupyter-mcp-vscode-release/src/format.ts:18-39
  getArtifactsRoot(): string {
    if (!this.workspaceRoot) throw new Error("Artifacts require an open workspace folder");
    return join(this.workspaceRoot, ".jupibuddy", "artifacts");
  }

  private notebookBaseName(): string {
    const raw = this.notebookPath ? basename(this.notebookPath, extname(this.notebookPath)) : "notebook";
    // sanitize to filesystem-safe, keep alphanum/_/-
    return raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "notebook";
  }

  async writeOutputArtifacts(cellIndex: number): Promise<{
    id: string;
    executionCount: number | null;
    artifactsRoot: string;
    artifacts: Array<{ output: number; item: number; mime: string; bytes: number; artifactPath: string; preview?: string; text?: string }>;
  }> {
    if (!this.notebook) throw new Error("no notebook open");
    const cell = this.notebook.cells[cellIndex];
    if (!cell) throw new Error(`no cell at index ${cellIndex}`);
    const artifactsRoot = this.getArtifactsRoot();
    await mkdir(artifactsRoot, { recursive: true });
    const base = this.notebookBaseName();
    const artifacts: Array<{ output: number; item: number; mime: string; bytes: number; artifactPath: string; preview?: string; text?: string }> = [];
    // flatten outputs into items mirroring VSCode NotebookCellOutputItem
    type Item = { mime: string; data: string };
    const flat: Array<{ outputIdx: number; itemIdx: number; item: Item }> = [];
    for (let outputIdx = 0; outputIdx < cell.outputs.length; outputIdx++) {
      const o = cell.outputs[outputIdx];
      let items: Item[] = [];
      if (o.kind === "stream") {
        const mime = o.name === "stderr" ? "application/vnd.code.notebook.stderr" : "application/vnd.code.notebook.stdout";
        items = [{ mime, data: o.text }];
      } else if (o.kind === "error") {
        const payload = JSON.stringify({ ename: o.ename, evalue: o.evalue, traceback: o.traceback });
        items = [{ mime: "application/vnd.code.notebook.error", data: payload }];
      } else if (o.kind === "result") {
        items = Object.entries(o.data).map(([mime, data]) => ({ mime, data }));
      }
      for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        flat.push({ outputIdx, itemIdx, item: items[itemIdx] });
      }
    }
    await Promise.all(
      flat.map(async ({ outputIdx, itemIdx, item }) => {
        const ext = extensionForMime(item.mime);
        const filename = `${base}-c${cellIndex}-o${outputIdx}-i${itemIdx}${ext}`;
        const filePath = join(artifactsRoot, filename);
        const isText = isTextLikeMime(item.mime);
        let buf: Buffer;
        if (isText) {
          buf = Buffer.from(item.data, "utf8");
        } else if (item.mime === "image/svg+xml") {
          // SVG is XML text, not base64
          buf = Buffer.from(item.data, "utf8");
        } else {
          // binary mimes (image/png, image/jpeg, application/pdf) — value is base64
          try {
            buf = Buffer.from(item.data, "base64");
            // sanity: if base64 decode yields empty but original non-empty, treat as utf8 (defensive)
            if (buf.length === 0 && item.data.length > 0) buf = Buffer.from(item.data, "utf8");
          } catch {
            buf = Buffer.from(item.data, "utf8");
          }
        }
        await writeFile(filePath, buf);
        const textValue = isText ? buf.toString("utf8") : undefined;
        const entry: { output: number; item: number; mime: string; bytes: number; artifactPath: string; preview?: string; text?: string } = {
          output: outputIdx,
          item: itemIdx,
          mime: item.mime,
          bytes: buf.byteLength,
          artifactPath: toPosixPath(filePath),
        };
        if (textValue !== undefined) {
          if (textValue) entry.preview = textValue.substring(0, 1000);
          if (buf.byteLength <= 8192) entry.text = textValue;
        }
        artifacts.push(entry);
      }),
    );
    // stable order by output/item
    artifacts.sort((a, b) => (a.output - b.output) || (a.item - b.item));
    return { id: cell.id, executionCount: cell.executionCount, artifactsRoot: toPosixPath(artifactsRoot), artifacts };
  }

  // Run code cells in the half-open 0-based index range [from, toExclusive).
  // Stop-on-error is the default (nbclient client.py:984): execution halts at the
  // first cell whose outputs contain an error and the failing cell is surfaced in
  // `stoppedOnError`. Callers opt into continuing with `continueOnError: true`.
  async runCells(
    from: number,
    toExclusive: number,
    writer: Writer,
    opts?: { continueOnError?: boolean },
  ): Promise<{ ran: string[]; stoppedOnError?: { id: string; index: number; outputs: CellOutput[] }; artifacts?: Array<{ id: string; index: number; executionCount: number | null; artifactsRoot: string; artifacts: Array<{ output: number; item: number; mime: string; bytes: number; artifactPath: string; preview?: string; text?: string }> }> }> {
    if (!this.notebook) throw new Error("no notebook open");
    if (!this.kernel) throw new Error("no kernel available — select a kernel first");
    const cells = this.notebook.cells;
    if (!Number.isInteger(from) || !Number.isInteger(toExclusive)) throw new Error("from/to must be integers");
    if (from < 0) throw new Error(`from must be >= 0 (got ${from})`);
    if (toExclusive <= from) throw new Error(`empty range: to is exclusive and must be greater than from (from=${from}, to=${toExclusive})`);
    if (from >= cells.length) throw new Error(`from ${from} is out of range (notebook has ${cells.length} cells)`);
    const end = Math.min(toExclusive, cells.length);
    // Progress counts CODE cells only — the loop below skips markdown/raw, so
    // they must not be part of the total either.
    let total = 0;
    for (let i = from; i < end; i++) if (cells[i].type === "code") total++;
    this.runProgress = { startedAt: Date.now(), from, to: end, done: 0, total, currentId: null, currentIndex: null };
    const ran: string[] = [];
    const runArtifacts: Array<{ id: string; index: number; executionCount: number | null; artifactsRoot: string; artifacts: Array<{ output: number; item: number; mime: string; bytes: number; artifactPath: string; preview?: string; text?: string }> }> = [];
    try {
      for (let i = from; i < end; i++) {
        const cell = cells[i];
        if (cell.type !== "code") continue;
        this.executingCells.add(cell.id);
        let outputs: CellOutput[];
        try {
          outputs = await this.kernel.execute(cell.source);
        } finally {
          this.executingCells.delete(cell.id);
        }
        this.notebook.recordRun(cell.id, outputs);
        this.attribution.set(cell.id, writer);
        ran.push(cell.id);
        this.#bumpRevision();
        // write artifacts for this cell (best-effort; never fail the run on artifact IO)
        try {
          const art = await this.writeOutputArtifacts(i);
          runArtifacts.push({ id: art.id, index: i, executionCount: art.executionCount, artifactsRoot: art.artifactsRoot, artifacts: art.artifacts });
        } catch {
          // artifact write failed — run still counts
        }
        // Count the cell as done whether it succeeded or errored: an errored
        // cell still finished executing, and the stop must stay observable.
        const progress = this.runProgress;
        if (progress) {
          progress.done += 1;
          progress.currentId = cell.id;
          progress.currentIndex = i;
        }
        if (!opts?.continueOnError && outputs.some((o) => o.kind === "error")) {
          return { ran, stoppedOnError: { id: cell.id, index: i, outputs }, artifacts: runArtifacts };
        }
      }
      return { ran, artifacts: runArtifacts };
    } finally {
      // Success, stop-on-error, or a thrown kernel failure — progress is
      // transient and never outlives the call.
      this.runProgress = null;
    }
  }

  // --- queue for agent operations ---

  // Enqueue an agent action. Returns gated error if mode disallows the writer.
  // Also sets activeWriter context for attribution inside the queued fn.
  enqueue<T>(writer: Writer, fn: () => Promise<T>): Promise<T> {
    // Gate by mode
    if (writer === "internal-agent" && this.mode === "mcp-only") {
      return Promise.reject(new Error(`agent mode is mcp-only — internal-agent actions are gated`));
    }
    if (writer === "external-agent" && this.mode === "chat-only") {
      return Promise.reject(new Error(`agent mode is chat-only — external-agent (MCP) actions are gated`));
    }
    // Wrap fn with writer context and queue chaining
    const wrapped = () => this.withWriter(writer, fn);
    const task = this.#queue.then(wrapped, wrapped);
    // Keep queue alive even if task rejects
    this.#queue = task.then(() => {}, () => {});
    return task;
  }

  // Check if a cell is currently executing (read-only guard for human)
  isCellLocked(cellId: string): boolean {
    return this.executingCells.has(cellId);
  }

  // --- supervision helpers ---

  isAgentBusy(): boolean {
    return this.#agentBusy;
  }
  getCurrentRunId(): string | null {
    return this.#currentRunId;
  }
  getAbortSignal(): AbortSignal | null {
    return this.#cancelController?.signal ?? null;
  }

  // Atomic claim for the doorbell. Fully synchronous compare-and-set (no await
  // between the test and the assignment), so two callers in the same tick can
  // never both own the run. Returns false when a run is already active —
  // callers must queue/reject instead of overwriting runId / abort controller.
  beginAgentRun(runId: string): boolean {
    if (this.#agentBusy) return false;
    this.#agentBusy = true;
    this.#currentRunId = runId;
    this.#cancelController = new AbortController();
    this.steerBuffer = [];
    this.steeredFlag = false;
    this.currentApprovals = [];
    this.#curUndoEdits = new Map();
    this.#curUndoInserted = new Set();
    this.#curUndoDeleted = new Map();
    this.#curUndoTypes = new Map();
    this.#curUndoMoves = [];
    return true;
  }
  endAgentRun(): void {
    // finalize undo snapshot even if no changes
    if (this.#curUndoEdits && this.#curUndoInserted) {
      const hasEdits = this.#curUndoEdits.size > 0;
      const hasInserts = this.#curUndoInserted.size > 0;
      const hasDeletes = (this.#curUndoDeleted?.size ?? 0) > 0;
      const hasTypes = (this.#curUndoTypes?.size ?? 0) > 0;
      const hasMoves = (this.#curUndoMoves?.length ?? 0) > 0;
      if (hasEdits || hasInserts || hasDeletes || hasTypes || hasMoves) {
        this.undoStack.push({
          edits: new Map(this.#curUndoEdits),
          insertedIds: [...this.#curUndoInserted],
          ...(hasDeletes ? { deletedSnap: new Map(this.#curUndoDeleted!) } : {}),
          ...(hasTypes ? { typeSnap: new Map(this.#curUndoTypes!) } : {}),
          ...(hasMoves ? { moves: [...this.#curUndoMoves!] } : {}),
        });
        if (this.undoStack.length > 20) this.undoStack.shift();
      }
    }
    this.#curUndoEdits = null;
    this.#curUndoInserted = null;
    this.#curUndoDeleted = null;
    this.#curUndoTypes = null;
    this.#curUndoMoves = null;
    this.#agentBusy = false;
    this.#currentRunId = null;
    this.#cancelController = null;
    this.steerBuffer = [];
    // do not clear pendingQueue here; drain is handled by server
  }

  requestCancel(): boolean {
    if (!this.#agentBusy || !this.#cancelController) return false;
    try {
      this.#cancelController.abort();
    } catch {}
    return true;
  }

  // doorbell queue ops
  enqueuePending(task: string, provider: string, activeCellIndex?: number | null, requireApproval?: boolean): { disposition: "queued"; queueId: string } {
    const queueId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.pendingQueue.push({ queueId, task, provider, activeCellIndex: activeCellIndex ?? null, requireApproval: !!requireApproval, status: "queued" });
    return { disposition: "queued", queueId };
  }
  findPending(queueId: string) {
    return this.pendingQueue.find((p) => p.queueId === queueId);
  }
  steerPending(queueId: string, newTask: string): boolean {
    const p = this.findPending(queueId);
    if (!p || p.status !== "queued") return false;
    // remove from queue and fold into running turn
    const idx = this.pendingQueue.indexOf(p);
    if (idx >= 0) this.pendingQueue.splice(idx, 1);
    p.status = "steered";
    this.steerBuffer.push(newTask);
    this.steeredFlag = true;
    return true;
  }
  unqueuePending(queueId: string): { ok: boolean; text?: string } {
    const p = this.findPending(queueId);
    if (!p || p.status !== "queued") return { ok: false };
    const idx = this.pendingQueue.indexOf(p);
    if (idx >= 0) this.pendingQueue.splice(idx, 1);
    p.status = "reclaimed";
    return { ok: true, text: p.task };
  }
  popNextPending(): (typeof this.pendingQueue)[number] | null {
    // find first queued
    const idx = this.pendingQueue.findIndex((p) => p.status === "queued");
    if (idx < 0) return null;
    const item = this.pendingQueue[idx];
    // remove from queue; caller will start it
    this.pendingQueue.splice(idx, 1);
    return item;
  }
  // approvals
  waitForApproval(runId: string, tool: string, argsPreview: string): Promise<"approve" | "deny"> {
    // if already waiting, deny previous auto
    if (this.#pendingApproval) {
      try { clearTimeout(this.#pendingApproval.timer); } catch {}
      this.#pendingApproval.resolve("deny");
      this.#pendingApproval = null;
    }
    return new Promise<"approve" | "deny">((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pendingApproval && this.#pendingApproval.runId === runId) {
          this.#pendingApproval = null;
          this.currentApprovals.push({ tool, decision: "deny (timeout)" });
          resolve("deny");
        }
      }, 120_000);
      this.#pendingApproval = { runId, tool, argsPreview, resolve: (d) => { clearTimeout(timer); resolve(d); }, timer };
    });
  }
  resolveApproval(runId: string, decision: "approve" | "deny"): boolean {
    if (!this.#pendingApproval || this.#pendingApproval.runId !== runId) return false;
    const pa = this.#pendingApproval;
    clearTimeout(pa.timer);
    this.#pendingApproval = null;
    this.currentApprovals.push({ tool: pa.tool, decision });
    pa.resolve(decision);
    return true;
  }
  getPendingApproval(): { runId: string; tool: string; argsPreview: string } | null {
    if (!this.#pendingApproval) return null;
    return { runId: this.#pendingApproval.runId, tool: this.#pendingApproval.tool, argsPreview: this.#pendingApproval.argsPreview };
  }

  // snapshots for undo (call from insert/edit)
  #recordEditBeforeChange(cellId: string) {
    if (!this.#agentBusy || !this.#curUndoEdits) return;
    if (this.#curUndoEdits.has(cellId)) return;
    const c = this.notebook?.cells.find((x) => x.id === cellId);
    if (c) this.#curUndoEdits.set(cellId, c.source);
  }
  // called after insert to track inserted cells
  #recordInsert(cellId: string) {
    if (!this.#agentBusy || !this.#curUndoInserted) return;
    this.#curUndoInserted.add(cellId);
  }
  // called before delete to snapshot the cell (source/type/former index)
  #recordDelete(cellId: string) {
    if (!this.#agentBusy || !this.#curUndoDeleted) return;
    if (this.#curUndoDeleted.has(cellId)) return;
    const idx = this.notebook?.indexOf(cellId) ?? -1;
    if (idx < 0) return;
    const c = this.notebook!.cells[idx];
    this.#curUndoDeleted.set(cellId, { source: c.source, type: c.type, index: idx });
  }
  // called before change-type to snapshot the cell type
  #recordTypeBeforeChange(cellId: string) {
    if (!this.#agentBusy || !this.#curUndoTypes) return;
    if (this.#curUndoTypes.has(cellId)) return;
    const c = this.notebook?.cells.find((x) => x.id === cellId);
    if (c) this.#curUndoTypes.set(cellId, c.type);
  }
  // called before move to remember the former position (moves can repeat in a run)
  #recordMove(cellId: string, from: number) {
    if (!this.#agentBusy || !this.#curUndoMoves) return;
    this.#curUndoMoves.push({ id: cellId, from });
  }

  // Full pre-mutation copy of a cell for the human undo stack (A9). Null when
  // the cell is gone — callers then skip the recording.
  #snapshotCell(cellId: string): CellSnapshot | null {
    const idx = this.notebook?.indexOf(cellId) ?? -1;
    if (idx < 0) return null;
    const c = this.notebook!.cells[idx];
    return {
      source: c.source,
      type: c.type,
      index: idx,
      outputs: c.outputs.map((o) => ({ ...o })),
      executionCount: c.executionCount,
      ...(c.metadata ? { metadata: { ...c.metadata } } : {}),
    };
  }
  // Record the pre-edit source of a human text edit (A9/R2). A burst on one
  // cell coalesces into the entry already on top of the stack: that entry
  // holds the source from before the burst, which is exactly what one undo
  // should restore, so only the timestamp is refreshed. Pushing per keystroke
  // would flood the depth-20 stack with near-identical steps.
  #recordHumanEdit(cellId: string) {
    const idx = this.notebook?.indexOf(cellId) ?? -1;
    if (idx < 0) return;
    const source = this.notebook!.cells[idx].source;
    const now = Date.now();
    const top = this.humanUndoStack[this.humanUndoStack.length - 1];
    const marker = this.#humanEditTop;
    if (
      marker !== null &&
      marker.cellId === cellId &&
      now - marker.at < 2000 &&
      top !== undefined &&
      this.#isPlainEdit(top)
    ) {
      marker.at = now;
      return;
    }
    this.#pushHumanUndo({ edits: new Map([[cellId, source]]) });
    this.#humanEditTop = { cellId, at: now };
  }
  // True when a snapshot is a single-cell source edit and nothing else — the
  // only shape whose repeated pushes may be merged.
  #isPlainEdit(snap: UndoSnapshot): boolean {
    return (
      snap.edits.size === 1 &&
      snap.insertedIds.length === 0 &&
      !snap.deletedSnap &&
      !snap.typeSnap &&
      !snap.moves &&
      !snap.clearedSnap
    );
  }
  // True when applying a snapshot would touch no cell. An empty inverse is
  // dropped instead of becoming a no-op entry on the other stack.
  #isEmptySnapshot(snap: UndoSnapshot): boolean {
    return (
      snap.edits.size === 0 &&
      snap.insertedIds.length === 0 &&
      (snap.deletedSnap?.size ?? 0) === 0 &&
      (snap.typeSnap?.size ?? 0) === 0 &&
      (snap.moves?.length ?? 0) === 0 &&
      (snap.clearedSnap?.size ?? 0) === 0
    );
  }
  // Capture the state a snapshot is about to overwrite, in the same shape, so
  // the shared applier can walk the document the other way: an undo's inverse
  // is the redo, and a redo's inverse is the undo again. Must run BEFORE the
  // snapshot is applied. A cell the snapshot re-inserts only counts when the
  // applier will really bring it back — a live ID holder is a conflict, and
  // deleting that unrelated cell on redo would be worse than a lost redo.
  #captureInverse(snap: UndoSnapshot): UndoSnapshot {
    const nb = this.notebook;
    const edits = new Map<string, string>();
    const insertedIds: string[] = [];
    const deletedSnap = new Map<string, CellSnapshot>();
    const typeSnap = new Map<string, CellType>();
    const moves: Array<{ id: string; from: number }> = [];
    const clearedSnap = new Map<string, { outputs: CellOutput[]; executionCount: number | null }>();
    if (nb) {
      for (const id of snap.deletedSnap?.keys() ?? []) {
        if (nb.indexOf(id) < 0) insertedIds.push(id);
      }
      for (const id of snap.insertedIds) {
        const before = this.#snapshotCell(id);
        if (before) deletedSnap.set(id, before);
      }
      for (const id of snap.edits.keys()) {
        const idx = nb.indexOf(id);
        if (idx >= 0) edits.set(id, nb.cells[idx].source);
      }
      for (const id of snap.typeSnap?.keys() ?? []) {
        const idx = nb.indexOf(id);
        if (idx >= 0) typeSnap.set(id, nb.cells[idx].type);
      }
      for (const mv of snap.moves ?? []) {
        const cur = nb.indexOf(mv.id);
        if (cur >= 0) moves.push({ id: mv.id, from: cur });
      }
      for (const id of snap.clearedSnap?.keys() ?? []) {
        const idx = nb.indexOf(id);
        if (idx >= 0) {
          const c = nb.cells[idx];
          clearedSnap.set(id, {
            outputs: c.outputs.map((o) => ({ ...o })),
            executionCount: c.executionCount,
          });
        }
      }
    }
    return {
      edits,
      insertedIds,
      ...(deletedSnap.size ? { deletedSnap } : {}),
      ...(typeSnap.size ? { typeSnap } : {}),
      ...(moves.length ? { moves } : {}),
      ...(clearedSnap.size ? { clearedSnap } : {}),
    };
  }
  // Push one human inverse onto the human stack. Depth matches the agent stack
  // (20); the oldest entry falls off first. A new human edit forks the history,
  // so it also drops the redo branch — replaying an action that never followed
  // the edit now on top would contradict the document.
  #pushHumanUndo(snap: Partial<UndoSnapshot>) {
    this.#pushHumanUndoEntry(snap);
    this.humanRedoStack.length = 0;
  }
  // Stack-only push, used for the inverse of a redo: that entry restores
  // history instead of forking it, so the remaining redo branch must survive.
  #pushHumanUndoEntry(snap: Partial<UndoSnapshot>) {
    this.humanUndoStack.push({
      edits: snap.edits ?? new Map(),
      insertedIds: snap.insertedIds ?? [],
      ...(snap.deletedSnap ? { deletedSnap: snap.deletedSnap } : {}),
      ...(snap.typeSnap ? { typeSnap: snap.typeSnap } : {}),
      ...(snap.moves ? { moves: snap.moves } : {}),
      ...(snap.clearedSnap ? { clearedSnap: snap.clearedSnap } : {}),
    });
    if (this.humanUndoStack.length > 20) this.humanUndoStack.shift();
    // Any push invalidates the coalescing marker; the human edit path sets a
    // fresh one right after its own push.
    this.#humanEditTop = null;
  }
  #pushHumanRedo(snap: UndoSnapshot) {
    this.humanRedoStack.push(snap);
    if (this.humanRedoStack.length > 20) this.humanRedoStack.shift();
  }

  // Apply one recorded inverse to the live document. Shared by the agent-run
  // undo and the human structural undo so both restore the document the same
  // way — the only difference is which stack the snapshot came from.
  #applyUndoSnapshot(snap: UndoSnapshot, writer: Writer, undone: string[], conflicts: Array<{ id: string; reason: string }>) {
    const nb = this.notebook;
    if (!nb) return;
    // remove inserted cells
    for (const id of snap.insertedIds) {
      const idx = nb.indexOf(id);
      if (idx >= 0) {
        try { nb.deleteCell(id); this.attribution.delete(id); undone.push(id); } catch {}
      }
    }
    // restore edited cells
    for (const [id, src] of snap.edits) {
      const idx = nb.indexOf(id);
      if (idx >= 0) {
        try { nb.editCell(id, src); undone.push(id); } catch {}
      }
    }
    // re-insert the cells this change removed, ascending by former index so the
    // original relative order comes back. Outputs/execution count/metadata are
    // restored when the snapshot carries them (human path); the agent snapshot
    // is source/type only, as before.
    const deleted = snap.deletedSnap ? [...snap.deletedSnap.entries()].sort((a, b) => a[1].index - b[1].index) : [];
    for (const [id, cell] of deleted) {
      if (nb.indexOf(id) >= 0) {
        // Never clobber a live cell that now owns this id — report instead.
        conflicts.push({ id, reason: "cell id already in use — not restored" });
        continue;
      }
      const at = Math.max(0, Math.min(cell.index, nb.cells.length));
      const restored = nb.insertCell(at, cell.type, cell.source, cell.metadata ? { ...cell.metadata } : undefined);
      // Deliberate exception to "cell IDs are never recycled": undo restores
      // the exact identity of a cell this change deleted (no live cell holds it —
      // checked above), so the undo stays reversible and references stay valid.
      restored.id = id;
      restored.outputs = cell.outputs ? cell.outputs.map((o) => ({ ...o })) : [];
      restored.executionCount = cell.executionCount ?? null;
      this.attribution.set(id, writer);
      undone.push(id);
    }
    // restore types changed by change-type (that op leaves source untouched)
    for (const [id, type] of snap.typeSnap ?? []) {
      if (nb.indexOf(id) < 0) continue;
      try { nb.setCellType(id, type); undone.push(id); } catch {}
    }
    // unwind moves newest-first: each cell goes back to its former index
    for (const mv of [...(snap.moves ?? [])].reverse()) {
      const cur = nb.indexOf(mv.id);
      if (cur < 0) continue;
      const [cell] = nb.cells.splice(cur, 1);
      const at = Math.max(0, Math.min(mv.from, nb.cells.length));
      nb.cells.splice(at, 0, cell);
      undone.push(mv.id);
    }
    // restore outputs removed by a clear (human snapshots only)
    for (const [id, cleared] of snap.clearedSnap ?? []) {
      const idx = nb.indexOf(id);
      if (idx < 0) continue;
      nb.cells[idx].outputs = cleared.outputs.map((o) => ({ ...o }));
      nb.cells[idx].executionCount = cleared.executionCount;
      undone.push(id);
    }
  }

  // undo: revert last run's internal-agent attribution
  undoLastRun(steps: number): { undone: string[]; conflicts?: Array<{ id: string; reason: string }> } {
    if (!this.notebook) throw new Error("no notebook open");
    if (!steps || steps <= 0) steps = 1;
    const undone: string[] = [];
    const conflicts: Array<{ id: string; reason: string }> = [];
    for (let s = 0; s < steps; s++) {
      const snap = this.undoStack.pop();
      if (!snap) break;
      this.#applyUndoSnapshot(snap, "internal-agent", undone, conflicts);
    }
    if (undone.length) { this.dirty = true; this.#bumpRevision(); }
    return conflicts.length ? { undone, conflicts } : { undone };
  }

  // A9: undo the last HUMAN edit (text edit / delete / move / change-type /
  // split / join / clear-outputs). Separate stack from undoLastRun, so an
  // agent undo never resurrects a human action and vice versa. Every step
  // pushed onto the redo stack is the inverse of what the undo just
  // overwrote, so the same applier can walk forward again. Undo marks the
  // document dirty — it now differs from what is on disk.
  undoLastEdit(steps: number): { undone: string[]; conflicts?: Array<{ id: string; reason: string }> } {
    if (!this.notebook) throw new Error("no notebook open");
    if (!steps || steps <= 0) steps = 1;
    this.#humanEditTop = null;
    const undone: string[] = [];
    const conflicts: Array<{ id: string; reason: string }> = [];
    for (let s = 0; s < steps; s++) {
      const snap = this.humanUndoStack.pop();
      if (!snap) break;
      const inverse = this.#captureInverse(snap);
      this.#applyUndoSnapshot(snap, this.#activeWriter ?? "human", undone, conflicts);
      if (!this.#isEmptySnapshot(inverse)) this.#pushHumanRedo(inverse);
    }
    if (undone.length) { this.dirty = true; this.#bumpRevision(); }
    return conflicts.length ? { undone, conflicts } : { undone };
  }

  // A9 redo: walk the last undone human edit forward again. Mirrors
  // undoLastEdit's contract — an empty redo stack is an honest empty result,
  // not an error. The step just redone goes back onto the undo stack (stack
  // only, so the remaining redo branch survives), which keeps undo/redo
  // bouncing on the same step instead of drifting onto older history.
  redoLastEdit(steps: number): { redone: string[]; conflicts?: Array<{ id: string; reason: string }> } {
    if (!this.notebook) throw new Error("no notebook open");
    if (!steps || steps <= 0) steps = 1;
    this.#humanEditTop = null;
    const redone: string[] = [];
    const conflicts: Array<{ id: string; reason: string }> = [];
    for (let s = 0; s < steps; s++) {
      const snap = this.humanRedoStack.pop();
      if (!snap) break;
      const inverse = this.#captureInverse(snap);
      this.#applyUndoSnapshot(snap, this.#activeWriter ?? "human", redone, conflicts);
      if (!this.#isEmptySnapshot(inverse)) this.#pushHumanUndoEntry(inverse);
    }
    if (redone.length) { this.dirty = true; this.#bumpRevision(); }
    return conflicts.length ? { redone, conflicts } : { redone };
  }

  // --- status ---

  getState() {
    return {
      workspaceRoot: this.workspaceRoot,
      notebookPath: this.notebookPath,
      hasNotebook: !!this.notebook,
      cellCount: this.notebook?.cells.length ?? 0,
      dirty: this.dirty,
      kernel: this.kernel?.name ?? null,
      kernelState: this.kernel?.status()?.state ?? null,
      mode: this.mode,
      revision: this.revision,
    };
  }

  // --- recent persistence ---

  // Internal helpers for recent storage: handles both legacy string[] and new {workspaces, notebooks} shape
  #readRecentData(): { workspaces: string[]; notebooks: string[] } {
    const recentPath = join(homedir(), ".jupibuddy", "recent.json");
    try {
      const raw = readFileSync(recentPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { workspaces: parsed as string[], notebooks: [] };
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const ws = Array.isArray(obj.workspaces) ? (obj.workspaces as string[]) : Array.isArray(obj.recent) ? (obj.recent as string[]) : [];
        const nbs = Array.isArray(obj.notebooks) ? (obj.notebooks as string[]) : [];
        return { workspaces: ws, notebooks: nbs };
      }
      return { workspaces: [], notebooks: [] };
    } catch {
      return { workspaces: [], notebooks: [] };
    }
  }

  async #writeRecentData(data: { workspaces: string[]; notebooks: string[] }): Promise<void> {
    const cfgDir = join(homedir(), ".jupibuddy");
    await mkdir(cfgDir, { recursive: true });
    const recentPath = join(cfgDir, "recent.json");
    try { await writeFile(recentPath, JSON.stringify(data, null, 2), "utf-8"); } catch { /* ignore */ }
  }

  async #persistRecent(path: string): Promise<void> {
    const data = this.#readRecentData();
    data.workspaces = [path, ...data.workspaces.filter((p) => p !== path)].slice(0, 10);
    await this.#writeRecentData(data);
  }

  async #persistRecentNotebook(path: string): Promise<void> {
    const data = this.#readRecentData();
    data.notebooks = [path, ...data.notebooks.filter((p) => p !== path)].slice(0, 10);
    await this.#writeRecentData(data);
  }

  async getRecent(): Promise<string[]> {
    return this.#readRecentData().workspaces;
  }

  async getRecentNotebooks(): Promise<string[]> {
    return this.#readRecentData().notebooks;
  }

  async getRecentAll(): Promise<{ workspaces: string[]; notebooks: string[] }> {
    return this.#readRecentData();
  }

  // Open a notebook file by absolute path: sets workspace to dirname, records recent workspace + notebook
  async openNotebookFile(absPath: string): Promise<{ ok: boolean; workspaceRoot: string; notebookPath: string; cells: number; needsConfirm?: boolean; message?: string }> {
    const resolved = resolve(absPath);
    // Allowed roots guard FIRST: must be inside homedir() or /tmp (or current workspaceRoot if set) — 403 takes precedence over 400/404
    const allowedRoots = [resolve(homedir()), resolve("/tmp")];
    if (this.workspaceRoot) allowedRoots.unshift(resolve(this.workspaceRoot));
    const insideAllowed = allowedRoots.some((r) => resolved === r || resolved.startsWith(r + "/"));
    if (!insideAllowed) throw Object.assign(new Error(`path outside allowed roots: ${resolved}`), { status: 403 });
    if (!resolved.endsWith(".ipynb")) throw Object.assign(new Error("path must end with .ipynb"), { status: 400 });
    // Validate file exists
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(resolved);
    } catch {
      throw Object.assign(new Error(`file not found: ${resolved}`), { status: 404 });
    }
    if (st.isDirectory()) throw Object.assign(new Error("path is a directory, not a .ipynb file"), { status: 400 });
    // Symlink guard: reuse resolveInsideWorkspace-style check for the target file's directory walk
    // Walk from allowed root down or from dirname chain to detect escaping symlink
    // For open-file we do a simpler symlink check on the file itself and its parent chain
    try {
      const dir = dirname(resolved);
      const parts = dir.split("/").filter(Boolean);
      // Reconstruct and check each prefix for symlink escaping allowed roots
      let cur = "/";
      for (const part of parts) {
        cur = join(cur, part);
        if (!existsSync(cur)) break;
        try {
          const lst = lstatSync(cur);
          if (lst.isSymbolicLink()) {
            const target = readlinkTarget(cur);
            if (target) {
              const realPath = resolve(dirname(cur), target);
              const realInside = allowedRoots.some((r) => realPath === r || realPath.startsWith(r + "/"));
              if (!realInside) throw new Error(`symlink escapes allowed roots: ${absPath}`);
            }
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes("escapes allowed roots")) throw e;
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("escapes allowed roots")) throw e;
    }
    const dir = dirname(resolved);
    // Never discard unsaved edits: same needs-confirm contract as closeNotebook.
    // Checked BEFORE openWorkspace resets workspaceRoot/notebook/dirty.
    if (this.dirty && this.notebook) {
      return {
        ok: false,
        workspaceRoot: this.workspaceRoot ?? dir,
        notebookPath: this.notebookPath ?? resolved,
        cells: this.notebook.cells.length,
        needsConfirm: true,
        message: `notebook has unsaved changes (${this.notebookPath}); save or close it before opening another notebook`,
      };
    }
    // Reuse openWorkspace logic (records recent workspaces)
    const opened = await this.openWorkspace(dir);
    if (opened.needsConfirm) {
      return {
        ok: false,
        workspaceRoot: opened.workspaceRoot,
        notebookPath: this.notebookPath ?? resolved,
        cells: this.notebook?.cells.length ?? 0,
        needsConfirm: true,
        message: opened.message,
      };
    }
    // Derive workspace-relative path for openNotebook (reuse its guard)
    const rel = relative(dir, resolved);
    const result = await this.openNotebook(rel, "human");
    // Record recent notebooks
    await this.#persistRecentNotebook(resolved).catch(() => {});
    return { ok: true, workspaceRoot: dir, notebookPath: result.path, cells: result.cells };
  }

  // Explorer: list all files under workspace root; recursive tree when opts.recursive
  async listExplorer(
    dirRel?: string,
    opts?: { recursive?: boolean },
  ): Promise<{
    path: string;
    entries: Array<{ name: string; isDirectory: boolean; path: string; depth?: number; parent?: string }>;
    dirty: boolean;
    truncated?: boolean;
  }> {
    if (!this.workspaceRoot) throw new Error("no workspace open");
    const root = this.workspaceRoot;
    // Recursive tree: single DFS pre-order from workspace root, flat entries with depth + parent, cap 500
    if (opts?.recursive) {
      const MAX_ENTRIES = 500;
      const entries: Array<{ name: string; isDirectory: boolean; path: string; depth: number; parent: string }> = [];
      let truncated = false;
      const walk = async (dir: string, depth: number, parentRel: string): Promise<void> => {
        if (truncated || entries.length >= MAX_ENTRIES) { truncated = true; return; }
        let items;
        try {
          items = (await readdir(dir, { withFileTypes: true })) as unknown as Array<{ name: string; isDirectory: () => boolean }>;
        } catch {
          return;
        }
        // dirs-first sort per level
        items.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        for (const e of items) {
          if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
          const full = join(dir, e.name);
          if (!isInsideWorkspace(root, full) && resolve(full) !== resolve(root)) continue;
          const rel = parentRel ? parentRel + "/" + e.name : e.name;
          entries.push({ name: e.name, isDirectory: e.isDirectory(), path: full, depth, parent: parentRel });
          if (e.isDirectory()) {
            await walk(full, depth + 1, rel);
            if (truncated || entries.length >= MAX_ENTRIES) { truncated = true; break; }
          }
        }
      };
      await walk(root, 0, "");
      if (entries.length >= MAX_ENTRIES) truncated = true;
      return { path: root, entries, dirty: this.dirty, ...(truncated ? { truncated: true as const } : {}) };
    }
    const target = dirRel ? resolveInsideWorkspace(this.workspaceRoot, dirRel) : this.workspaceRoot;
    const entries: Array<{ name: string; isDirectory: boolean; path: string }> = [];
    try {
      const items = await readdir(target, { withFileTypes: true });
      for (const e of items) {
        entries.push({ name: e.name, isDirectory: e.isDirectory(), path: join(target, e.name) });
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      // empty on error
    }
    return { path: target, entries, dirty: this.dirty };
  }

  // Explorer rename: workspace-guarded, no clobber, dirty-active guard.
  async renameFile(
    oldRel: string,
    newRel: string,
  ): Promise<{ ok: true; oldPath: string; newPath: string } | { ok: false; needsConfirm: true; message: string; path: string }> {
    if (!this.workspaceRoot) throw new Error("no workspace open");
    if (!oldRel || !newRel) throw new Error("oldPath and newPath are required");
    const absOld = resolveInsideWorkspace(this.workspaceRoot, oldRel);
    const absNew = resolveInsideWorkspace(this.workspaceRoot, newRel);
    if (absOld === absNew) throw new Error("oldPath and newPath are the same");
    // source must exist
    try {
      await stat(absOld);
    } catch {
      throw new Error(`source not found: ${oldRel}`);
    }
    // no clobber
    if (existsSync(absNew)) throw new Error(`target already exists: ${newRel}`);
    // refuse rename of ACTIVE notebook while dirty (honest 409 path, like close)
    if (this.notebookPath && absOld === this.notebookPath && this.dirty) {
      return {
        ok: false,
        needsConfirm: true,
        message: `notebook has unsaved changes (${this.notebookPath}); save or close it before renaming`,
        path: this.notebookPath,
      };
    }
    await rename(absOld, absNew);
    // keep active notebook path in sync when renaming the clean active notebook
    if (this.notebookPath && absOld === this.notebookPath) {
      this.notebookPath = absNew;
    }
    return { ok: true, oldPath: absOld, newPath: absNew };
  }

  // Explorer copy: byte copy, first-free " copy" naming, never dir-copy.
  async copyFileOp(
    srcRel: string,
    destRel?: string,
  ): Promise<{ ok: true; src: string; dest: string }> {
    if (!this.workspaceRoot) throw new Error("no workspace open");
    if (!srcRel) throw new Error("path is required");
    const absSrc = resolveInsideWorkspace(this.workspaceRoot, srcRel);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(absSrc);
    } catch {
      throw new Error(`source not found: ${srcRel}`);
    }
    if (st.isDirectory()) throw new Error("cannot copy a directory (v1 — select files, not folders)");
    let absDest: string;
    if (destRel) {
      absDest = resolveInsideWorkspace(this.workspaceRoot, destRel);
      if (existsSync(absDest)) {
        const destStat = await stat(absDest).catch(() => null);
        if (destStat?.isDirectory()) {
          const baseName = basename(absSrc);
          absDest = join(absDest, baseName);
          if (existsSync(absDest)) {
            const dDir = dirname(absDest);
            const dExt = extname(baseName);
            const dBase = basename(baseName, dExt);
            let candidate = join(dDir, `${dBase} copy${dExt}`);
            if (!existsSync(candidate)) absDest = candidate;
            else {
              let n = 2;
              while (true) {
                candidate = join(dDir, `${dBase} copy ${n}${dExt}`);
                if (!existsSync(candidate)) { absDest = candidate; break; }
                n++;
                if (n > 100) throw new Error("too many copies");
              }
            }
          }
        } else {
          const dDir = dirname(absDest);
          const dExt = extname(absDest);
          const dBase = basename(absDest, dExt);
          let candidate = join(dDir, `${dBase} copy${dExt}`);
          if (!existsSync(candidate)) absDest = candidate;
          else {
            let n = 2;
            while (true) {
              candidate = join(dDir, `${dBase} copy ${n}${dExt}`);
              if (!existsSync(candidate)) { absDest = candidate; break; }
              n++;
              if (n > 100) throw new Error("too many copies");
            }
          }
        }
      }
    } else {
      const dir = dirname(absSrc);
      const ext = extname(absSrc);
      const base = basename(absSrc, ext);
      let candidate = join(dir, `${base} copy${ext}`);
      if (!existsSync(candidate)) {
        absDest = candidate;
      } else {
        let n = 2;
        while (true) {
          candidate = join(dir, `${base} copy ${n}${ext}`);
          if (!existsSync(candidate)) {
            absDest = candidate;
            break;
          }
          n++;
          if (n > 100) throw new Error("too many copies");
        }
      }
    }
    await copyFile(absSrc, absDest);
    return { ok: true, src: absSrc, dest: absDest };
  }

  // Explorer delete: multi-delete; refuse active notebook while dirty (409), close clean active.
  async deletePaths(
    rels: string[],
  ): Promise<{ ok: true; deleted: string[] } | { ok: false; needsConfirm: true; message: string; path: string }> {
    if (!this.workspaceRoot) throw new Error("no workspace open");
    if (!Array.isArray(rels) || rels.length === 0) throw new Error("paths is required");
    const absPaths: string[] = [];
    for (const rel of rels) {
      if (!rel || typeof rel !== "string") throw new Error("path is required");
      const abs = resolveInsideWorkspace(this.workspaceRoot, rel);
      absPaths.push(abs);
    }
    if (this.notebookPath && this.dirty) {
      for (const abs of absPaths) {
        if (abs === this.notebookPath) {
          return {
            ok: false,
            needsConfirm: true,
            message: `notebook has unsaved changes (${this.notebookPath}); save or close it before deleting`,
            path: this.notebookPath,
          };
        }
      }
    }
    const deleted: string[] = [];
    let activeDeletedClean = false;
    for (const abs of absPaths) {
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(abs);
      } catch {
        throw new Error(`source not found: ${abs}`);
      }
      if (st.isDirectory()) throw new Error("cannot delete a directory (v1 — select files, not folders)");
      await unlink(abs);
      deleted.push(abs);
      if (this.notebookPath && abs === this.notebookPath) activeDeletedClean = true;
    }
    if (activeDeletedClean) {
      if (this.kernel) {
        try { await this.kernel.shutdown?.(); } catch { /* ignore */ }
        this.kernel = null;
      }
      this.notebook = null;
      this.notebookPath = null;
      this.dirty = false;
      this.attribution.clear();
      this.executingCells.clear();
    }
    return { ok: true, deleted };
  }

  // --- file tools (S3): list_files / read_file / write_file via workspace guard ---

  async listFiles(relPath?: string, recursive?: boolean): Promise<{ path: string; entries: Array<{ name: string; isDirectory: boolean; path: string }>; truncated?: boolean }> {
    if (!this.workspaceRoot) throw new Error("no workspace open");
    const target = relPath ? resolveInsideWorkspace(this.workspaceRoot, relPath) : this.workspaceRoot;
    // Validate target is directory or workspace file
    const entries: Array<{ name: string; isDirectory: boolean; path: string }> = [];
    const MAX_ENTRIES = 500;
    if (recursive) {
      // Simple BFS up to budget
      const queue: string[] = [target];
      let count = 0;
      while (queue.length && count < MAX_ENTRIES) {
        const dir = queue.shift()!;
        try {
          const items = await readdir(dir, { withFileTypes: true });
          for (const e of items) {
            const full = join(dir, e.name);
            // Guard: must remain inside workspaceRoot
            if (!isInsideWorkspace(this.workspaceRoot, full) && resolve(full) !== resolve(this.workspaceRoot)) continue;
            entries.push({ name: e.name, isDirectory: e.isDirectory(), path: full });
            count++;
            if (e.isDirectory() && count < MAX_ENTRIES) queue.push(full);
            if (count >= MAX_ENTRIES) break;
          }
        } catch { /* ignore */ }
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
      return { path: target, entries, ...(count >= MAX_ENTRIES ? { truncated: true as const } : {}) };
    }
    // Non-recursive
    try {
      const items = await readdir(target, { withFileTypes: true });
      for (const e of items) {
        entries.push({ name: e.name, isDirectory: e.isDirectory(), path: join(target, e.name) });
      }
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      // If target is a file rather than directory, return single entry if inside workspace
      try {
        const st = await stat(target);
        if (st.isFile()) {
          entries.push({ name: basename(target), isDirectory: false, path: target });
        }
      } catch { /* empty */ }
    }
    return { path: target, entries };
  }

  async readFile(relPath: string): Promise<{ path: string; content: string; size: number; truncated?: boolean; mime?: string }> {
    if (!this.workspaceRoot) throw new Error("no workspace open");
    if (!relPath) throw new Error("path is required for read_file");
    const abs = resolveInsideWorkspace(this.workspaceRoot, relPath);
    const st = await stat(abs);
    if (st.isDirectory()) throw new Error(`read_file: path is a directory: ${relPath}`);
    const MAX_BYTES = 100_000;
    const MAX_CHARS = 8000;
    const fh = await open(abs, "r");
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, 0);
      const slice = bytesRead < MAX_BYTES ? buf.subarray(0, bytesRead) : buf;
      let content = slice.toString("utf-8");
      const truncated = st.size > MAX_BYTES || content.length > MAX_CHARS;
      if (content.length > MAX_CHARS) content = content.slice(0, MAX_CHARS);
      return truncated
        ? { path: abs, content, size: st.size, truncated: true }
        : { path: abs, content, size: st.size };
    } finally {
      await fh.close();
    }
  }

  async writeFile(relPath: string, content: string): Promise<{ written: string; bytes: number }> {
    if (!this.workspaceRoot) throw new Error("no workspace open");
    if (!relPath) throw new Error("path is required for write_file");
    const abs = resolveInsideWorkspace(this.workspaceRoot, relPath);
    // Ensure parent exists
    const dir = dirname(abs);
    await mkdir(dir, { recursive: true });
    await writeFile(abs, content, "utf-8");
    const bytes = Buffer.byteLength(content, "utf-8");
    // Spec: Write marks notebook dirty ONLY for .ipynb saves; plain file writes do not touch notebook state
    if (abs.endsWith(".ipynb")) {
      // If this ipynb matches the currently open notebook, writing via file tool
      // creates a divergence between in-memory model and disk — mark dirty so close-confirm fires.
      // For other ipynbs, we don't touch the active notebook's dirty flag (agent may create new notebooks on disk).
      // We still mark dirty if any notebook is open and path is ipynb, to preserve close-confirm invariant for active doc.
      // Heuristic: mark dirty only if open notebook path equals this file (most precise)
      if (this.notebook && this.notebookPath && abs === this.notebookPath) {
        this.dirty = true;
      } else if (this.notebook && !this.notebookPath) {
        // No known path but ipynb written under workspace — conservatively mark dirty
        this.dirty = true;
      }
    }
    return { written: abs, bytes };
  }

  // --- kernel introspection via jupyter_server REST sidecar (NOT raw ZMQ) ---
  // Probes reuse the jupyter-vscode-mcp v1.0.0 logic (MIT) re-expressed against the
  // NotebookService kernel WebSocket. Budgets: max 100 vars / 8000 chars, 200 packages.

  async getVariables(): Promise<{ kernelStatus: string; count: number; variables: unknown[]; truncated?: boolean; source: string }> {
    if (!this.kernel) throw new Error("no kernel available — select a kernel first");
    if (this.kernel.name === "echo-stub") {
      return { kernelStatus: "stub", count: 0, variables: [], source: "stub" };
    }
    const status = this.kernel.status();
    if (status.state === "busy") {
      return { kernelStatus: status.state, count: 0, variables: [], source: "busy" };
    }
    // Probe runs inside the kernel interpreter via the sidecar's WebSocket execute
    const probe = VARIABLES_PROBE;
    const outputs = await this.kernel.execute(probe, { timeoutMs: 15_000 });
    const text = outputs.map((o) => outputText(o)).join("\n");
    const marker = "JMCP_VARS:";
    const idx = text.indexOf(marker);
    if (idx === -1) {
      return { kernelStatus: status.state, count: 0, variables: [], source: "probe-no-marker" };
    }
    let jsonStr = text.slice(idx + marker.length).split("\n")[0].trim();
    // Handle case where marker line may have trailing content
    if (!jsonStr.startsWith("[") && text.includes("[")) {
      // Fallback: extract first JSON array
      const start = text.indexOf("[", idx);
      const end = text.lastIndexOf("]");
      if (start !== -1 && end !== -1 && end > start) jsonStr = text.slice(start, end + 1);
    }
    try {
      const parsed = JSON.parse(jsonStr) as unknown[];
      const truncated = parsed.length >= 100 || jsonStr.length >= 8000;
      return { kernelStatus: status.state, count: parsed.length, variables: parsed, source: "kernel-executeCode-probe", ...(truncated ? { truncated: true as const } : {}) };
    } catch {
      return { kernelStatus: status.state, count: 0, variables: [], source: "probe-parse-error" };
    }
  }

  async getPipPackages(): Promise<{ kernelStatus?: string; count: number; packages: Array<{ name: string; version: string }>; source: string; truncated?: boolean; error?: string }> {
    if (!this.kernel) throw new Error("no kernel available — select a kernel first");
    if (this.kernel.name === "echo-stub") {
      return { count: 0, packages: [], source: "stub" };
    }
    const status = this.kernel.status();
    const outputs = await this.kernel.execute(PIP_PROBE, { timeoutMs: 15_000 });
    const text = outputs.map((o) => outputText(o)).join("\n");
    const marker = "JMCP_PIP:";
    const idx = text.indexOf(marker);
    if (idx === -1) {
      return { count: 0, packages: [], source: "probe-no-marker" };
    }
    const jsonStr = text.slice(idx + marker.length).split("\n")[0].trim();
    try {
      const parsed = JSON.parse(jsonStr) as { count?: number; packages?: Array<{ name: string; version: string }>; error?: string };
      if (parsed.error) return { count: 0, packages: [], source: "kernel-executeCode-probe", error: parsed.error };
      const packages = parsed.packages ?? [];
      return {
        kernelStatus: status.state,
        count: parsed.count ?? packages.length,
        packages,
        source: "kernel-executeCode-probe",
        ...((parsed.count ?? 0) > packages.length ? { truncated: true as const } : {}),
      };
    } catch {
      return { count: 0, packages: [], source: "probe-parse-error" };
    }
  }

  async getCompletion(code: string, cursorPos: number): Promise<{ status: string; matches: string[]; cursorStart: number; cursorEnd: number; truncated?: boolean }> {
    if (!this.kernel) throw new Error("no kernel available — select a kernel first");
    if (this.kernel.name === "echo-stub") {
      return { status: "stub", matches: [], cursorStart: 0, cursorEnd: 0 };
    }
    const st = this.kernel.status();
    if (st.state === "busy") {
      return { status: "busy", matches: [], cursorStart: 0, cursorEnd: 0 };
    }
    const result = await this.kernel.complete(code, cursorPos, { timeoutMs: 10_000 });
    let matches = result.matches ?? [];
    const origLen = matches.length;
    const hadLong = matches.some((m) => m.length > 20);
    if (matches.length > 50) matches = matches.slice(0, 50);
    matches = matches.map((m) => (m.length > 20 ? m.slice(0, 20) : m));
    const truncated = origLen > 50 || hadLong;
    return {
      status: result.status,
      matches,
      cursorStart: result.cursorStart,
      cursorEnd: result.cursorEnd,
      ...(truncated ? { truncated: true as const } : {}),
    };
  }

  async installPackages(packages: string[], upgrade?: boolean): Promise<{ installed: boolean; exitCode?: number; resolvedVersions?: Record<string, string | null>; outputTail?: string; error?: string }> {
    if (!this.kernel) throw new Error("no kernel available — select a kernel first");
    if (this.kernel.name === "echo-stub") throw new Error("install_packages not available on echo-stub kernel");
    if (!Array.isArray(packages) || packages.length === 0) throw new Error("install_packages: packages array is required");
    if (packages.length > 30) throw new Error("Too many packages (max 30 per call)");
    if (packages.some((p) => typeof p !== "string" || p.trim().length === 0 || p.length > 200)) throw new Error("Invalid package spec (empty or too long)");
    const clean = packages.map((p) => p.trim());
    const probe = buildInstallProbe(clean, !!upgrade);
    const outputs = await this.kernel.execute(probe, { timeoutMs: 180_000 });
    const text = outputs.map((o) => outputText(o)).join("\n");
    const marker = "JMCP_INSTALL:";
    const idx = text.indexOf(marker);
    if (idx === -1) {
      return { installed: false, error: "Install probe did not return within budget. The install may still be running — check with get_pip_packages." };
    }
    const jsonStr = text.slice(idx + marker.length).split("\n")[0].trim();
    try {
      const parsed = JSON.parse(jsonStr) as { exit_code: number; resolved: Record<string, string | null>; tail: string };
      const missing = Object.entries(parsed.resolved ?? {}).filter(([, v]) => v === null).map(([k]) => k);
      return {
        installed: parsed.exit_code === 0,
        exitCode: parsed.exit_code,
        resolvedVersions: parsed.resolved ?? {},
        outputTail: parsed.tail ?? "",
        ...(missing.length ? { notResolvedAfterInstall: missing } as Record<string, unknown> : {}),
      } as unknown as { installed: boolean; exitCode?: number; resolvedVersions?: Record<string, string | null>; outputTail?: string; error?: string };
    } catch {
      return { installed: false, error: "Malformed install result", outputTail: jsonStr.slice(0, 400) };
    }
  }

  // --- attachment store (plain TS, zero new deps) ---
  #attachIndex = new Map<string, { id: string; name: string; mime: string; size: number; path: string }>();
  static readonly ATTACH_ALLOW = new Set(["image/png","image/jpeg","image/webp","image/gif","text/csv","text/markdown","text/plain","text/x-python"]);
  static readonly ATTACH_MAX_FILE = 5 * 1024 * 1024;
  static readonly ATTACH_MAX_FILES_PER_RUN = 10;
  static readonly ATTACH_MAX_TOTAL = 10 * 1024 * 1024;
  async attachFile(name: string, bytes: Uint8Array, mime: string): Promise<{ id: string; name: string; mime: string; size: number; path: string }> {
    if (!this.workspaceRoot) throw new Error("no workspace open — attach requires a workspace");
    const m = (mime || "").toLowerCase().split(";")[0].trim();
    const ext = (name.split(".").pop() || "").toLowerCase();
    const extMime: Record<string,string> = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", gif:"image/gif", csv:"text/csv", md:"text/markdown", markdown:"text/markdown", txt:"text/plain", py:"text/x-python" };
    const resolvedMime = m || extMime[ext] || "";
    if (!NotebookService.ATTACH_ALLOW.has(resolvedMime)) throw new Error(`unsupported file type: ${resolvedMime || ext || "unknown"} — allowed: ${[...NotebookService.ATTACH_ALLOW].join(", ")}`);
    if (bytes.length > NotebookService.ATTACH_MAX_FILE) throw new Error(`file too large: ${bytes.length} bytes (max ${NotebookService.ATTACH_MAX_FILE})`);
    const dir = join(this.workspaceRoot, ".jupibuddy-attachments");
    await mkdir(dir, { recursive: true });
    try { const gi = join(this.workspaceRoot, ".gitignore"); const cur = existsSync(gi) ? readFileSync(gi, "utf-8") : ""; if (!cur.includes(".jupibuddy-attachments")) { const { appendFileSync } = require("node:fs"); appendFileSync(gi, (cur.endsWith("\n") || cur === "" ? "" : "\n") + ".jupibuddy-attachments/\n"); } } catch {}
    const id = randomBytes(8).toString("hex");
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
    const filePath = join(dir, `${id}-${safe}`);
    await writeFile(filePath, bytes);
    const entry = { id, name: safe, mime: resolvedMime, size: bytes.length, path: filePath };
    this.#attachIndex.set(id, entry);
    return entry;
  }
  async getAttachment(id: string): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new Error("invalid attachment id");
    const meta = this.#attachIndex.get(id);
    if (!meta) throw new Error("attachment not found");
    const bytes = await readFile(meta.path);
    return { bytes: new Uint8Array(bytes), mime: meta.mime, name: meta.name };
  }

  async createVenv(opts: { name?: string; packages?: string[]; withIpykernel?: boolean }): Promise<{
    created: boolean;
    path: string;
    python: string;
    ipykernelOk: boolean;
    installedPackages?: string[];
    outputTail?: string;
    error?: string;
  }> {
    if (!this.workspaceRoot) throw new Error("no workspace open");
    const rawName = opts.name ?? ".venv";
    if (typeof rawName !== "string") throw new Error("name must be a string");
    const name = rawName.trim() || ".venv";
    // Validate packages — same validation as installPackages
    let packages: string[] = opts.packages ?? [];
    if (!Array.isArray(packages)) throw new Error("packages must be an array");
    if (packages.length > 30) throw new Error("Too many packages (max 30 per call)");
    if (packages.some((p) => typeof p !== "string" || p.trim().length === 0 || p.length > 200))
      throw new Error("Invalid package spec (empty or too long)");
    packages = packages.map((p) => p.trim());
    const withIpykernel = opts.withIpykernel !== undefined ? !!opts.withIpykernel : true;

    const target = resolveInsideWorkspace(this.workspaceRoot, name);

    // Reject if target exists and is non-empty (never clobber)
    if (existsSync(target)) {
      try {
        const st = lstatSync(target);
        if (st.isDirectory()) {
          const entries = await readdir(target);
          if (entries.length > 0) throw new Error(`target exists and is non-empty: ${name} -> ${target}`);
        } else {
          throw new Error(`target exists and is not a directory: ${name} -> ${target}`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes("target exists")) throw e;
        // readdir failed or other — treat as exists error
        throw new Error(`target exists: ${name} -> ${target}`);
      }
    }

    // Resolve python interpreter via same module the kernel uses
    let pythonPath: string | null = null;
    const specPython = (this.kernel as unknown as { selectedSpec?: { pythonPath: string } } | null)?.selectedSpec?.pythonPath;
    if (specPython && existsSync(specPython)) {
      pythonPath = specPython;
    } else {
      const best = await resolveBest({ workspaceRoot: this.workspaceRoot });
      if (!best) throw new Error("No Python interpreter found to create venv");
      pythonPath = best.pythonPath;
    }
    if (!pythonPath || !existsSync(pythonPath)) throw new Error(`Python interpreter not found: ${pythonPath}`);

    // Venv creation 120s budget — Bun.spawn argv arrays only, no shell
    const venvResult = await runSpawnWithTimeout([pythonPath, "-m", "venv", target], 120_000);
    if (venvResult.exitCode !== 0) {
      const tail = venvResult.tail.slice(-1600);
      throw new Error(`venv creation failed (exit ${venvResult.exitCode}): ${tail}`);
    }

    const needPip = withIpykernel || packages.length > 0;
    if (!needPip) {
      return { created: true, path: target, python: pythonPath, ipykernelOk: false };
    }

    const toInstall: string[] = [];
    if (withIpykernel) toInstall.push("ipykernel", "jupyter_server");
    toInstall.push(...packages);

    const pipPath = join(target, "bin", "pip");
    if (!existsSync(pipPath)) {
      return {
        created: true,
        path: target,
        python: pythonPath,
        ipykernelOk: false,
        installedPackages: [],
        outputTail: `pip not found at ${pipPath}`.slice(-1600),
        error: `pip not found at ${pipPath}`,
      };
    }

    const pipResult = await runSpawnWithTimeout([pipPath, "install", "--disable-pip-version-check", ...toInstall], 180_000);
    const pipTail = pipResult.tail.slice(-1600);
    if (pipResult.exitCode !== 0) {
      return {
        created: true,
        path: target,
        python: pythonPath,
        ipykernelOk: false,
        installedPackages: toInstall,
        outputTail: pipTail,
        error: `pip install failed (exit ${pipResult.exitCode})`,
      };
    }
    return {
      created: true,
      path: target,
      python: pythonPath,
      ipykernelOk: withIpykernel,
      installedPackages: toInstall,
      outputTail: pipTail,
    };
  }
}

async function runSpawnWithTimeout(argv: string[], timeoutMs: number): Promise<{ exitCode: number; tail: string; timedOut: boolean }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let stdout = "";
  let stderr = "";
  const readOut = (async () => {
    try {
      stdout = await new Response(proc.stdout).text();
    } catch {
      // ignore
    }
  })();
  const readErr = (async () => {
    try {
      stderr = await new Response(proc.stderr).text();
    } catch {
      // ignore
    }
  })();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
  });
  await Promise.race([proc.exited.then(() => {}), timeoutPromise]);
  if (timeoutId) clearTimeout(timeoutId);
  try {
    await proc.exited;
  } catch {
    // ignore
  }
  await Promise.all([readOut, readErr]);
  const combined = (stdout.slice(-1200) + "\n" + stderr.slice(-400)).slice(-1600);
  const exitCode = timedOut ? -1 : (proc.exitCode ?? -1);
  const tail = timedOut ? (`timeout after ${timeoutMs / 1000}s\n${combined}`).slice(-1600) : combined;
  return { exitCode, tail, timedOut };
}

// ---------------------------------------------------------------------------
// Probe code — adapted from hadiproz/jupyter-vscode-mcp v1.0.0 (MIT)
// Original: src/jupyterApi.ts VARIABLES_PROBE, PIP_PROBE, buildInstallProbe
// Preserved under MIT license (Copyright (c) 2026 hadiproz)
// ---------------------------------------------------------------------------

const VARIABLES_PROBE = [
  "import json as _jmcp_json, types as _jmcp_types",
  "def _jmcp_clip(_s, _n=120):",
  "    _s = _s.replace('\\n', ' ')",
  "    if len(_s) <= _n:",
  "        return _s",
  "    return _s[: _n - 3] + '...'",
  "def _jmcp_pack(_k, _v):",
  "    _d = {'name': _k, 'type': type(_v).__name__}",
  "    try:",
  "        if hasattr(_v, 'columns') and hasattr(_v, 'shape'):",
  "            _cols = [_jmcp_clip(str(c), 30) for c in list(_v.columns)[:8]]",
  "            _d['kind'] = 'dataframe'",
  "            _d['shape'] = list(_v.shape)",
  "            _d['n_columns'] = len(_v.columns)",
  "            _d['columns'] = _cols",
  "            try:",
  "                _rows = _v.head(2).values.tolist()",
  "                _d['head'] = [[_jmcp_clip(repr(c), 30) for c in row] for row in _rows]",
  "            except Exception:",
  "                pass",
  "        elif hasattr(_v, 'dtype') and hasattr(_v, 'shape'):",
  "            _d['kind'] = 'array'",
  "            _d['shape'] = list(_v.shape)",
  "            _d['dtype'] = str(_v.dtype)",
  "        elif isinstance(_v, (list, tuple, set, frozenset, dict)):",
  "            _d['length'] = len(_v)",
  "            _d['preview'] = _jmcp_clip(repr(_v))",
  "        else:",
  "            _d['preview'] = _jmcp_clip(repr(_v))",
  "    except Exception as _e:",
  "        _d['error'] = _jmcp_clip(str(_e), 60)",
  "    return _d",
  "_jmcp_out = []",
  "for _k in sorted(list(globals().keys())):",
  "    if _k.startswith('_') or _k in {'In', 'Out', 'exit', 'quit', 'get_ipython'}:",
  "        continue",
  "    try:",
  "        _v = globals()[_k]",
  "    except Exception:",
  "        continue",
  "    if isinstance(_v, _jmcp_types.ModuleType) or callable(_v):",
  "        continue",
  "    _jmcp_out.append(_jmcp_pack(_k, _v))",
  "_jmcp_text = _jmcp_json.dumps(_jmcp_out[:100], default=str)",
  "if len(_jmcp_text) > 8000:",
  "    _jmcp_text = _jmcp_text[:8000]",
  "print('JMCP_VARS:' + _jmcp_text)",
].join("\n");

const PIP_PROBE = [
  "import json as _jmcp_json",
  "try:",
  "    from importlib.metadata import distributions as _jmcp_dists",
  "    _pkgs = {}",
  "    for _dist in _jmcp_dists():",
  "        try:",
  "            _pkgs[_dist.metadata['Name']] = _dist.version",
  "        except Exception:",
  "            continue",
  "    _names = sorted(_pkgs)",
  "    print('JMCP_PIP:' + _jmcp_json.dumps({'count': len(_names), 'packages': [{'name': n, 'version': _pkgs[n]} for n in _names[:200]]}))",
  "except Exception as _e:",
  "    print('JMCP_PIP:' + _jmcp_json.dumps({'count': 0, 'packages': [], 'error': str(_e)[:120]}))",
].join("\n");

function buildInstallProbe(packages: string[], upgrade: boolean): string {
  const pkgJson = JSON.stringify(packages);
  return [
    "import json as _jmcp_json, sys as _jmcp_sys, subprocess as _jmcp_sp",
    "import importlib.metadata as _jmcp_im",
    `_pkgs = ${pkgJson}`,
    "_args = [_jmcp_sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check']",
    ...(upgrade ? ["_args.append('--upgrade')"] : []),
    "_args += _pkgs",
    "try:",
    "    _r = _jmcp_sp.run(_args, capture_output=True, text=True, timeout=170)",
    "    _tail = (_r.stdout[-1200:] + '\\n' + _r.stderr[-400:])[-1600:]",
    "    _code = _r.returncode",
    "except Exception as _e:",
    "    _tail, _code = str(_e)[:300], -1",
    "_resolved = {}",
    "for _spec in _pkgs:",
    "    _base = _spec",
    "    for _ch in '=<>!~':",
    "        _base = _base.split(_ch)[0]",
    "    _base = _base.strip()",
    "    try:",
    "        _resolved[_spec] = _jmcp_im.version(_base)",
    "    except Exception:",
    "        _resolved[_spec] = None",
    "print('JMCP_INSTALL:' + _jmcp_json.dumps({'exit_code': _code, 'resolved': _resolved, 'tail': _tail}))",
  ].join("\n");
}
