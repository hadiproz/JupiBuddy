// The notebook document model — the heart of JupiBuddy.
//
// Design rules inherited from the jupyter-vscode-mcp v1.0.0 defect log
// (treated as requirements, see SOURCES.md §7 — do not regress these):
//   1. Cell IDs are NEVER recycled. A deleted cell's ID stays retired for
//      the life of the notebook; new cells always get a fresh ID.
//   2. Delete reports what actually happened (the removed cell's ID and
//      its index) — never a placeholder like -1 on success.
//   3. ONE indexing convention everywhere: 0-based, in every tool and API.

import { randomBytes } from "node:crypto";

export type CellType = "code" | "markdown" | "raw";

export interface StreamOutput {
  kind: "stream";
  name: string;
  text: string;
}

export interface ErrorOutput {
  kind: "error";
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface ResultOutput {
  kind: "result";
  data: Record<string, string>;
  execution_count: number | null;
  metadata?: Record<string, unknown>;
}

export type CellOutput = StreamOutput | ErrorOutput | ResultOutput;

export interface Cell {
  /** Stable ID, e.g. "#JB-000001". Never reused after deletion. */
  id: string;
  type: CellType;
  source: string;
  outputs: CellOutput[];
  /** Kernel execution counter; null until the cell has run. */
  executionCount: number | null;
  /** Per-cell nbformat metadata preserved verbatim (attachments, tags, etc.). */
  metadata?: Record<string, unknown>;
}

/**
 * F7 execution state: a cell's last run counts as successful unless its
 * outputs carry an error. Derived, never stored — outputs are the only truth,
 * so a reload from disk, a re-run and a clear all agree without extra state.
 */
export function lastRunSuccess(cell: Cell): boolean {
  return !cell.outputs.some((o) => o.kind === "error");
}

export class Notebook {
  readonly cells: Cell[] = [];
  #execCounter = 0;

  #nextId(): string {
    let id: string;
    do {
      id = `#jb-${randomBytes(4).toString("hex")}`;
    } while (this.cells.some((c) => c.id === id));
    return id;
  }

  /** Index of a cell by ID, or -1. Internal lookups only — tool results
   *  never expose a bare -1 as a success value (rule 2). */
  indexOf(id: string): number {
    return this.cells.findIndex((c) => c.id === id);
  }

  insertCell(index: number, type: CellType, source = "", metadata?: Record<string, unknown>): Cell {
    const cell: Cell = {
      id: this.#nextId(),
      type,
      source,
      outputs: [],
      executionCount: null,
      ...(metadata ? { metadata } : {}),
    };
    const at = Math.max(0, Math.min(index, this.cells.length));
    this.cells.splice(at, 0, cell);
    return cell;
  }

  appendCell(type: CellType, source = "", metadata?: Record<string, unknown>): Cell {
    return this.insertCell(this.cells.length, type, source, metadata);
  }

  editCell(id: string, source: string): Cell {
    const i = this.indexOf(id);
    if (i < 0) throw new Error(`cell not found: ${id}`);
    this.cells[i].source = source;
    return this.cells[i];
  }

  /** Removes a cell and reports the removed cell and its former index. */
  deleteCell(id: string): { deletedId: string; deletedIndex: number } {
    const i = this.indexOf(id);
    if (i < 0) throw new Error(`cell not found: ${id}`);
    this.cells.splice(i, 1);
    return { deletedId: id, deletedIndex: i };
  }

  /** Changes a cell's type in place. Source, outputs and metadata survive. */
  setCellType(id: string, type: CellType): Cell {
    const i = this.indexOf(id);
    if (i < 0) throw new Error(`cell not found: ${id}`);
    this.cells[i].type = type;
    return this.cells[i];
  }

  /** Moves a cell to an absolute 0-based index; reports where it came from. */
  moveCell(id: string, toIndex: number): { id: string; from: number; to: number } {
    const from = this.indexOf(id);
    if (from < 0) throw new Error(`cell not found: ${id}`);
    if (!Number.isInteger(toIndex)) throw new Error(`index must be an integer (got ${toIndex})`);
    if (toIndex < 0 || toIndex >= this.cells.length) {
      throw new Error(`index ${toIndex} out of range (notebook has ${this.cells.length} cells)`);
    }
    if (toIndex === from) return { id, from, to: from };
    const [cell] = this.cells.splice(from, 1);
    this.cells.splice(toIndex, 0, cell);
    return { id, from, to: toIndex };
  }

  /** Drops every output and resets the execution counter (Jupyter clear-outputs). */
  clearOutputs(id: string): Cell {
    const i = this.indexOf(id);
    if (i < 0) throw new Error(`cell not found: ${id}`);
    this.cells[i].outputs = [];
    this.cells[i].executionCount = null;
    return this.cells[i];
  }

  /** Records an execution against a cell (called by the kernel layer). */
  recordRun(id: string, outputs: CellOutput[]): Cell {
    const i = this.indexOf(id);
    if (i < 0) throw new Error(`cell not found: ${id}`);
    this.#execCounter += 1;
    this.cells[i].executionCount = this.#execCounter;
    this.cells[i].outputs = outputs;
    return this.cells[i];
  }

  summary() {
    return {
      cellCount: this.cells.length,
      cells: this.cells.map((c, index) => ({
        index, // 0-based, like every other surface (rule 3)
        id: c.id,
        type: c.type,
        sourcePreview: c.source.slice(0, 120),
        executionCount: c.executionCount,
        outputCount: c.outputs.length,
      })),
    };
  }

  /** The kernelspec to write into the notebook metadata (set by select_kernel / auto-resolve). */
  kernelspec: { display_name: string; language: string; name: string } = {
    display_name: "Python 3",
    language: "python",
    name: "python3",
  };

  /**
   * Free-form document metadata as read from the file (A5). Every key the
   * document carried — Colab provenance, JupyterLab settings, anything else —
   * survives a load/save cycle untouched. `kernelspec` is the one key the
   * model interprets (it is kept in sync with the kernel picker on save);
   * `language_info` is preserved when the file had one.
   */
  metadata: Record<string, unknown> = {};

  /** Serialize to a minimal nbformat-4-shaped object. */
  toIpynb() {
    // A5: write the document metadata back as a whole. `kernelspec` and
    // `language_info` are updated in place (the model owns kernelspec); every
    // other key the file had is passed through untouched.
    const languageInfo =
      this.metadata.language_info && typeof this.metadata.language_info === "object"
        ? this.metadata.language_info
        : { name: "python" };
    return {
      cells: this.cells.map((c) => ({
        cell_type: c.type,
        id: c.id.replace(/^#jb-/i, "jb-"),
        metadata: c.metadata ?? {},
        source: c.source.split("\n").map((l) => l + "\n"),
        ...(c.type === "code"
          ? {
              execution_count: c.executionCount,
              outputs: c.outputs.map((o) => {
                if (o.kind === "error") {
                  return {
                    output_type: "error" as const,
                    ename: o.ename,
                    evalue: o.evalue,
                    traceback: o.traceback,
                  };
                }
                if (o.kind === "stream") {
                  return {
                    output_type: "stream" as const,
                    name: o.name,
                    text: o.text,
                  };
                }
                // result: execute_result with mime bundle
                return {
                  output_type: "execute_result" as const,
                  data: o.data,
                  metadata: o.metadata ?? {},
                  execution_count: o.execution_count,
                };
              }),
            }
          : {}),
      })),
      metadata: {
        ...this.metadata,
        kernelspec: this.kernelspec,
        language_info: languageInfo,
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
  }
}
