// JupiBuddy's own services, exposed as MCP tools.
//
// The tool surface deliberately mirrors the proven 18-tool shape of
// jupyter-vscode-mcp v1.0.0 (base logic — see SOURCES.md §7), re-expressed
// against JupiBuddy's own notebook instead of a host editor's. Indexing is
// 0-based in every tool (SOURCES.md §7, defect 3). Tools marked
// status "stub" are registered for surface parity and return an explicit
// not-implemented result until their slice lands.

import type { NotebookService } from "../notebook/service";
import type { Writer } from "../notebook/service";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  status: "implemented" | "stub";
  handler: (args: Record<string, never>) => Promise<unknown>;
  // For MCP alias enforcement: alias names share the exact same handler reference
  aliasOf?: string;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };

// Legacy factory removed — NotebookService is the only backend.
// Kept as explicit throw so external imports fail loudly.
export function createTools(): never {
  throw new Error("createTools legacy factory removed — use createToolsWithService(service)");
}

// Single source of truth: NotebookService owns notebook + kernel + workspace.
// Handlers use `service` directly; missing workspace/notebook/kernel emit the
// honest existing errors (e.g. "no workspace open", "no notebook open",
// "no kernel available — select a kernel first") instead of falling back.
export function createToolsWithService(
  service: NotebookService | null,
): ToolDef[] {
  const requireService = (): NotebookService => {
    if (!service) throw new Error("no workspace open — open a folder first");
    return service;
  };

  // Insert cell handler — single function shared by insert_cell and aliases
  const insertCellHandler = async ({ index, type, source }: { index?: number; type?: string; source?: string }) => {
    const s = requireService();
    const writer: Writer = s.currentWriter ?? "human";
    return s.insertCell(index, type ?? "code", source ?? "", writer);
  };

  const tools: ToolDef[] = [
    {
      name: "list_open_notebooks",
      description: "List notebooks open in JupiBuddy (stage 1: exactly one). Use to confirm active notebook before editing. No args. Read-only, parallel-safe with other inspection calls.",
      inputSchema: obj({}),
      status: "implemented",
      handler: async () => {
        const s = requireService();
        if (!s.notebook) return [];
        return [{ name: s.notebookPath ? s.notebookPath.split("/").pop() : "untitled.ipynb", cells: s.notebook.cells.length, path: s.notebookPath }];
      },
    },
    {
      name: "get_summary",
      description: "Cell-by-cell summary of the notebook (0-based indexes). Start every task by inspecting structure; shows ids, types and exec counts. No args. Example: {}. Read-only, parallel-safe with get_cell_source/get_outputs.",
      inputSchema: obj({}),
      status: "implemented",
      handler: async () => {
        const s = requireService();
        if (!s.notebook) throw new Error("no notebook open");
        return s.notebook.summary();
      },
    },
    {
      name: "get_cell_source",
      description: "Full source of one cell, by stable cell ID. Use after get_summary to inspect before editing. Example: {\"cellId\":\"JB-abc123\"}. Read-only, parallel-safe.",
      inputSchema: obj({ cellId: str }, ["cellId"]),
      status: "implemented",
      handler: async ({ cellId }) => {
        const s = requireService();
        if (!s.notebook) throw new Error("no notebook open");
        const target = s.notebook;
        const i = target.indexOf(cellId);
        if (i < 0) throw new Error(`cell not found: ${cellId}`);
        return { index: i, id: cellId, source: target.cells[i].source };
      },
    },
    {
      name: "insert_cell",
      description: "Insert a cell at a 0-based index (or append when omitted). Use to create small runnable code/markdown cells. Example: {\"index\":2,\"type\":\"code\",\"source\":\"print(1)\"}. Serializes via single-writer queue.",
      inputSchema: obj({ index: num, type: str, source: str }),
      status: "implemented",
      handler: insertCellHandler as (args: Record<string, never>) => Promise<unknown>,
    },
    {
      name: "edit_cell",
      description: "Replace the source of a cell, by stable cell ID. Use to patch a cell after reading it; keep edits targeted. Example: {\"cellId\":\"JB-abc123\",\"source\":\"x=1\"}. Serializes.",
      inputSchema: obj({ cellId: str, source: str }, ["cellId", "source"]),
      status: "implemented",
      handler: async ({ cellId, source }) => {
        const s = requireService();
        return s.editCell(cellId, source, s.currentWriter ?? "human");
      },
    },
    {
      name: "delete_cell",
      description: "Delete a cell by ID. Returns the deleted ID and former index. Use to clean scratch cells. Example: {\"cellId\":\"JB-abc123\"}. Serializes.",
      inputSchema: obj({ cellId: str }, ["cellId"]),
      status: "implemented",
      handler: async ({ cellId }) => {
        const s = requireService();
        return s.deleteCell(cellId, s.currentWriter ?? "human");
      },
    },
    {
      name: "change_cell_type",
      description: "Change a cell's type in place (code|markdown|raw). Source, outputs and metadata are preserved. Example: {\"cellId\":\"JB-abc123\",\"type\":\"markdown\"}. Serializes.",
      inputSchema: obj({ cellId: str, type: str }, ["cellId", "type"]),
      status: "implemented",
      handler: async ({ cellId, type }) => {
        const s = requireService();
        return s.changeCellType(cellId, type, s.currentWriter ?? "human");
      },
    },
    {
      name: "move_cell",
      description: "Move a cell to a 0-based index (to) or one step (direction: up|down). Directional moves clamp at ends and report moved:false. Example: {\"cellId\":\"JB-abc123\",\"direction\":\"up\"}. Serializes.",
      inputSchema: obj({ cellId: str, to: num, direction: str }, ["cellId"]),
      status: "implemented",
      handler: async ({ cellId, to, direction }) => {
        const s = requireService();
        return s.moveCell(cellId, { to, direction }, s.currentWriter ?? "human");
      },
    },
    {
      name: "split_cell",
      description: "Split a cell at a character offset or at a 1-based line (exactly one; new cell starts at that line). Tail becomes new cell below; head keeps ID. Example: {\"cellId\":\"JB-abc123\",\"offset\":10}. Serializes.",
      inputSchema: obj({ cellId: str, offset: num, line: num }, ["cellId"]),
      status: "implemented",
      handler: async ({ cellId, offset, line }) => {
        const s = requireService();
        return s.splitCell(cellId, { offset, line }, s.currentWriter ?? "human");
      },
    },
    {
      name: "join_cells",
      description: "Join a cell with neighbour (direction: next|previous) or explicit selection (cellIds, >=2). Sources join with newline; earliest survives. Example: {\"cellId\":\"JB-abc123\",\"direction\":\"next\"}. Serializes.",
      inputSchema: obj({ cellId: str, direction: str, cellIds: { type: "array", items: str } }, ["cellId"]),
      status: "implemented",
      handler: async ({ cellId, direction, cellIds }) => {
        const s = requireService();
        return s.joinCells(cellId, s.currentWriter ?? "human", { direction, with: cellIds });
      },
    },
    {
      name: "clear_cell_outputs",
      description: "Clear one cell's outputs and reset its execution count. Returns count removed. Use to reset stale outputs. Example: {\"cellId\":\"JB-abc123\"}. Serializes.",
      inputSchema: obj({ cellId: str }, ["cellId"]),
      status: "implemented",
      handler: async ({ cellId }) => {
        const s = requireService();
        return s.clearCellOutputs(cellId, s.currentWriter ?? "human");
      },
    },
    {
      name: "undo_edit",
      description: "Undo the last human structural edit (delete, move, change-type, split, join, clear-outputs), restoring cells with outputs/metadata. Separate from agent undo; steps defaults to 1. Example: {\"steps\":1}. Serializes.",
      inputSchema: obj({ steps: num }),
      status: "implemented",
      handler: async ({ steps }) => {
        const s = requireService();
        return s.undoLastEdit(typeof steps === "number" ? steps : 1);
      },
    },
    {
      name: "redo_edit",
      description: "Redo the last undone human edit (text edit, delete, move, change-type, split, join, clear-outputs). Redo history cleared by new human edit. Example: {\"steps\":1}. Serializes.",
      inputSchema: obj({ steps: num }),
      status: "implemented",
      handler: async ({ steps }) => {
        const s = requireService();
        return s.redoLastEdit(typeof steps === "number" ? steps : 1);
      },
    },
    {
      name: "run_cells",
      description:
        "Run code cells in 0-based range [from,to) — `to` exclusive. Stops at first failing cell by default; pass continue_on_error:true to keep running. Artifact summary for new outputs (no raw base64). Example: {\"from\":0,\"to\":2}. Serializes; single-writer queue.",
      inputSchema: obj({ from: num, to: num, continue_on_error: bool }, ["from", "to"]),
      status: "implemented",
      handler: async ({ from, to, continue_on_error }) => {
        const s = requireService();
        if (!s.notebook) throw new Error("no notebook open");
        if (!s.kernel) throw new Error("no kernel available — select a kernel first");
        // runCells now returns artifact summaries (no raw base64 blobs)
        return s.runCells(from, to, s.currentWriter ?? "human", { continueOnError: continue_on_error === true });
      },
    },
    {
      name: "get_outputs",
      description: "Outputs of one cell (0-based index) as artifact summaries — no raw base64. Use to read execution results after run_cells. Example: {\"index\":0}. Read-only, parallel-safe.",
      inputSchema: obj({ index: num }, ["index"]),
      status: "implemented",
      handler: async ({ index }) => {
        const s = requireService();
        if (!s.notebook) throw new Error("no notebook open");
        // artifact path per jupyterApi.ts:501-539 + format.ts:18-39 — file on disk, not blob in JSON
        return s.writeOutputArtifacts(index);
      },
    },
    {
      name: "get_status",
      description: "Kernel and notebook status. Use to check kernel idle/busy and cell count. No args. Example: {}. Read-only, parallel-safe.",
      inputSchema: obj({}),
      status: "implemented",
      handler: async () => {
        const s = requireService();
        const st = s.getState();
        return { ...st, cells: st.cellCount };
      },
    },
    {
      name: "wait_until_idle",
      description: "Block until kernel reports idle, polling every 100ms up to timeout_ms (default 30000, max 300000). Returns {idle,state,waitedMs,timedOut}. Example: {\"timeout_ms\":10000}. Read-only poll; serializes lightly.",
      inputSchema: obj({ timeout_ms: num }),
      status: "implemented",
      handler: async ({ timeout_ms }) => {
        const s = requireService();
        if (!s.kernel) throw new Error("no kernel available — select a kernel first");
        const timeout =
          typeof timeout_ms === "number" && Number.isFinite(timeout_ms) && timeout_ms > 0
            ? Math.min(timeout_ms, 300_000)
            : 30_000;
        const started = Date.now();
        let st = s.kernel.status();
        while (st.state === "busy" && Date.now() - started < timeout) {
          await Bun.sleep(100);
          st = s.kernel.status();
        }
        const waitedMs = Date.now() - started;
        const idle = st.state !== "busy";
        return { idle, state: st.state, kernel: st.kernel, waitedMs, timedOut: !idle };
      },
    },
    {
      name: "interrupt_kernel",
      description: "Interrupt the running kernel. Use to stop a hung execution. No args. Example: {}. Serializes.",
      inputSchema: obj({}),
      status: "implemented",
      handler: async () => {
        const s = requireService();
        if (!s.kernel) throw new Error("no kernel available — select a kernel first");
        await s.kernel.interrupt();
        return { interrupted: true };
      },
    },
    {
      name: "restart_kernel",
      description: "Restart the kernel (execution state is reset). Use when kernel is wedged; variables are lost. No args. Example: {}. Serializes.",
      inputSchema: obj({}),
      status: "implemented",
      handler: async () => {
        const s = requireService();
        if (!s.kernel) throw new Error("no kernel available — select a kernel first");
        await s.kernel.restart();
        return { restarted: true };
      },
    },
    {
      name: "create_notebook",
      description: "Clear the current notebook back to a single blank cell. Use for fresh starts. No args. Serializes.",
      inputSchema: obj({}),
      status: "implemented",
      handler: async () => {
        const s = requireService();
        if (!s.notebook) throw new Error("no notebook open");
        const target = s.notebook;
        while (target.cells.length) target.deleteCell(target.cells[0].id);
        const cell = target.appendCell("code", "");
        s.dirty = true;
        s.attribution.set(cell.id, s.currentWriter ?? "human");
        return { id: cell.id, cells: target.cells.length };
      },
    },
    {
      name: "save_notebook",
      description: "Save the notebook as an .ipynb file. Use to persist after edits. Example: {\"path\":\"analysis.ipynb\"}. Serializes.",
      inputSchema: obj({ path: str }, ["path"]),
      status: "implemented",
      handler: async ({ path }) => {
        const s = requireService();
        if (!s.notebook) throw new Error("no notebook open");
        return s.saveNotebook(path);
      },
    },
    {
      name: "select_kernel",
      description: "Select a kernel by name or interpreter path (restarts the kernel). Example: {\"name\":\"python3\"}. Serializes.",
      inputSchema: obj({ name: str, interpreterPath: str }),
      status: "implemented",
      handler: async ({ name, interpreterPath }) => {
        const s = requireService();
        // No notebook open yet: open a blank one so there is something to attach the kernel to.
        if (!s.notebook) {
          await s.openNotebook("Untitled.ipynb", s.currentWriter ?? "external-agent");
        }
        // No kernel yet (first-ever select): boot the sidecar kernel directly instead of
        // failing with "select a kernel first" — that message is for run paths, not select itself.
        if (!s.kernel) {
          const { createKernelAsync } = await import("../notebook/kernel");
          const k = await createKernelAsync(s.workspaceRoot ?? "");
          (s as unknown as { kernel: unknown }).kernel = k;
        }
        const k = s.kernel;
        if (!k) throw new Error("kernel failed to start — check the sidecar logs");
        if (!k.selectKernel) throw new Error("kernel does not support select_kernel");
        const chosen = await k.selectKernel({ name, interpreterPath });
        if (!s.notebook) throw new Error("no notebook open");
        s.notebook.kernelspec = {
          display_name: chosen.displayName,
          language: "python",
          name: chosen.name,
        };
        return { selected: chosen };
      },
    },
    // --- S2: notebook open/close as first-class ops ---
    {
      name: "open_notebook",
      description: "Open a notebook file inside the workspace root (workspace-relative, guards against escapes). Example: {\"path\":\"notebooks/demo.ipynb\"}. Serializes.",
      inputSchema: obj({ path: str }, ["path"]),
      status: "implemented",
      handler: async ({ path }) => {
        const s = requireService();
        return s.openNotebook(path, s.currentWriter ?? "human");
      },
    },
    {
      name: "close_notebook",
      description: "Close the current notebook. If dirty, requires force=true (human only) or returns needsConfirm. Example: {\"force\":false}. Serializes.",
      inputSchema: obj({ force: bool }),
      status: "implemented",
      handler: async ({ force }) => {
        const s = requireService();
        return s.closeNotebook({ writer: s.currentWriter ?? "human", force: !!force });
      },
    },
    {
      name: "revert_notebook",
      description: "Discard in-memory changes and re-read the notebook from its saved file. Refuses when no notebook or never saved. Clears undo stacks; kernel keeps running. No args. Serializes.",
      inputSchema: obj({}),
      status: "implemented",
      handler: async () => {
        const s = requireService();
        return s.revertNotebook();
      },
    },
    // --- S3: file tools via workspace guard (single-writer queue + mode gating symmetric) ---
    {
      name: "list_files",
      description: "List files under workspace root (workspace-relative, guards against escapes/symlinks). Supports recursive listing with truncation budget. Example: {\"path\":\".\",\"recursive\":true}. Read-only, parallel-safe.",
      inputSchema: obj({ path: str, recursive: bool }),
      status: "implemented",
      handler: async ({ path, recursive }) => {
        const s = requireService();
        return s.listFiles(path as string | undefined, !!recursive);
      },
    },
    {
      name: "read_file",
      description: "Read a file inside workspace root (workspace-relative, guarded). Truncates large files with budget. Example: {\"path\":\"data.csv\"}. Read-only, parallel-safe with other reads.",
      inputSchema: obj({ path: str }, ["path"]),
      status: "implemented",
      handler: async ({ path }) => {
        const s = requireService();
        return s.readFile(path);
      },
    },
    {
      name: "write_file",
      description: "Write a file inside workspace root (workspace-relative, guarded). Plain writes do not touch notebook dirty state; .ipynb writes mark dirty only for active path. Example: {\"path\":\"out.txt\",\"content\":\"hello\"}. Serializes.",
      inputSchema: obj({ path: str, content: str }, ["path", "content"]),
      status: "implemented",
      handler: async ({ path, content }) => {
        const s = requireService();
        return s.writeFile(path, content);
      },
    },
    // --- S3: kernel introspection via jupyter_server REST sidecar (NOT raw ZMQ) ---
    {
      name: "get_variables",
      description: "Inspect kernel variables — type-aware summaries with truncation budgets (max 100 vars/8000 chars). Runs via jupyter_server sidecar. No args. Example: {}. Read-only, parallel-safe.",
      inputSchema: obj({}),
      status: "implemented",
      handler: async () => {
        const s = requireService();
        if (!s.kernel) throw new Error("no kernel available — select a kernel first");
        return s.getVariables();
      },
    },
    {
      name: "get_pip_packages",
      description: "List Python packages in the kernel environment (via importlib.metadata probe on sidecar kernel). No args. Example: {}. Read-only, parallel-safe.",
      inputSchema: obj({}),
      status: "implemented",
      handler: async () => {
        const s = requireService();
        if (!s.kernel) throw new Error("no kernel available — select a kernel first");
        return s.getPipPackages();
      },
    },
    {
      name: "complete_code",
      description: "Code completion via kernel complete_request (real Jupyter message, not a Python probe). Returns matches with cursor range (max 50/20 chars). Example: {\"code\":\"import os\",\"cursorPos\":9}. Read-only; low-cost.",
      inputSchema: obj({ code: str, cursorPos: num }, ["code", "cursorPos"]),
      status: "implemented",
      handler: async ({ code, cursorPos }) => {
        const s = requireService();
        if (!s.kernel) throw new Error("no kernel available — select a kernel first");
        return s.getCompletion(code as unknown as string, cursorPos as unknown as number);
      },
    },
    {
      name: "install_packages",
      description: "Install Python packages into kernel environment (pip inside kernel interpreter, 180s budget, max 30). Example: {\"packages\":[\"pandas\"],\"upgrade\":false}. Serializes; long-running.",
      inputSchema: obj({ packages: { type: "array", items: str }, upgrade: bool }, ["packages"]),
      status: "implemented",
      handler: async ({ packages, upgrade }) => {
        const s = requireService();
        if (!s.kernel) throw new Error("no kernel available — select a kernel first");
        return s.installPackages(packages as unknown as string[], !!upgrade);
      },
    },
    {
      name: "create_venv",
      description: "Create a Python venv inside workspace (workspace-relative, guarded, never clobbers non-empty). Optionally installs ipykernel+jupyter_server and extra packages (max 30, 180s). Example: {\"name\":\"myenv\"}. Serializes; long-running.",
      inputSchema: obj({ name: str, packages: { type: "array", items: str }, withIpykernel: bool }),
      status: "implemented",
      handler: async ({ name, packages, withIpykernel }) => {
        const s = requireService();
        return s.createVenv({
          name: name as unknown as string | undefined,
          packages: packages as unknown as string[] | undefined,
          withIpykernel: withIpykernel as unknown as boolean | undefined,
        });
      },
    },
  ];

  // --- new_cell-family aliases: must map to the exact same handler reference ---
  // Allowed per spec, but must point to the same handler as insert_cell.
  const insertCellTool = tools.find((t) => t.name === "insert_cell")!;
  for (const alias of ["new_cell", "create_cell", "add_cell"]) {
    tools.push({
      name: alias,
      description: insertCellTool.description,
      inputSchema: insertCellTool.inputSchema,
      status: insertCellTool.status,
      handler: insertCellTool.handler,
      aliasOf: "insert_cell",
    });
  }

  return tools;
}

export async function callTool(
  tools: ToolDef[],
  name: string,
  args: Record<string, never>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await tool.handler(args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
}
