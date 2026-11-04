# MCP Tools

The same MCP surface the internal agent uses, served at the app's `/mcp` endpoint (protocol 2025-11-25).

## Inspect (read-only, parallel-safe)

| Tool | Arguments | Mode | Use it for |
|---|---|---|---|
| `list_open_notebooks` | `{}` | Read-only | List open notebooks to confirm active notebook. |
| `get_summary` | `{}` | Read-only | Cell-by-cell summary (0-based) of notebook structure. |
| `get_cell_source` | `{cellId}` | Read-only | Get full source of one cell by stable ID. |
| `get_outputs` | `{index}` | Read-only | Get outputs of one cell by index as artifact summaries. |
| `get_status` | `{}` | Read-only | Check kernel idle/busy state and cell count. |
| `wait_until_idle` | `{}` | Read-only | Poll until kernel reports idle (default 30 s). |
| `list_files` | `{}` | Read-only | List files under workspace root (guarded, optional recursive). |
| `read_file` | `{path}` | Read-only | Read a file inside workspace (guarded, truncated if large). |
| `get_variables` | `{}` | Read-only | Inspect kernel variables with type-aware summaries. |
| `get_pip_packages` | `{}` | Read-only | List Python packages in the kernel environment. |
| `complete_code` | `{code, cursorPos}` | Read-only | Code completion via kernel complete request. |

## Edit cells (serialize)

| Tool | Arguments | Mode | Use it for |
|---|---|---|---|
| `insert_cell` | `{}` | Serializes | Insert a cell at index or append (code/markdown). |
| `new_cell` | `{}` | Serializes | Alias → `insert_cell` |
| `create_cell` | `{}` | Serializes | Alias → `insert_cell` |
| `add_cell` | `{}` | Serializes | Alias → `insert_cell` |
| `edit_cell` | `{cellId, source}` | Serializes | Replace a cell’s source by ID. |
| `delete_cell` | `{cellId}` | Serializes | Delete a cell by ID. |
| `change_cell_type` | `{cellId, type}` | Serializes | Change cell type (code/markdown/raw) in place. |
| `move_cell` | `{cellId}` | Serializes | Move a cell to index or one step up/down. |
| `split_cell` | `{cellId}` | Serializes | Split a cell at character offset or line number. |
| `join_cells` | `{cellId}` | Serializes | Join a cell with neighbour or explicit selection. |
| `clear_cell_outputs` | `{cellId}` | Serializes | Clear one cell’s outputs and reset execution count. |
| `undo_edit` | `{}` | Serializes | Undo last human structural edit. |
| `redo_edit` | `{}` | Serializes | Redo last undone human edit. |

## Run & kernel (serialize)

| Tool | Arguments | Mode | Use it for |
|---|---|---|---|
| `run_cells` | `{from, to}` | Serializes | Run code cells in [from,to) range; stops on first failure unless continue on error. |
| `interrupt_kernel` | `{}` | Serializes | Interrupt the running kernel. |
| `restart_kernel` | `{}` | Serializes | Restart kernel (execution state is reset). |
| `select_kernel` | `{}` | Serializes | Select kernel by name or interpreter path. |

## Notebook files (serialize)

| Tool | Arguments | Mode | Use it for |
|---|---|---|---|
| `create_notebook` | `{}` | Serializes | Clear current notebook to a single blank cell. |
| `save_notebook` | `{path}` | Serializes | Save notebook as .ipynb file. |
| `open_notebook` | `{path}` | Serializes | Open a notebook file inside workspace (guarded). |
| `close_notebook` | `{}` | Serializes | Close current notebook (needs force if dirty). |
| `revert_notebook` | `{}` | Serializes | Discard in-memory changes and re-read from saved file. |
| `write_file` | `{path, content}` | Serializes | Write a file inside workspace (guarded). |

## Environment (serialize, long-running)

| Tool | Arguments | Mode | Use it for |
|---|---|---|---|
| `install_packages` | `{packages}` | Serializes (long-running) | Install Python packages into kernel environment via pip. |
| `create_venv` | `{}` | Serializes (long-running) | Create a Python venv inside workspace, optionally with ipykernel. |
