# JupiBuddy

**A real Jupyter notebook editor with an agent that does the analysis end-to-end inside your notebook.**

JupiBuddy is a standalone, AI-native Jupyter notebook editor. It opens to a
blank notebook in a folder you choose; an AI agent then works *inside*
(that agent currently supports Muse Spark and Muse Spark Open only)
that notebook — it plans the analysis, writes and runs cells on a real Python
kernel, reads the outputs and errors, fixes its own mistakes, compares models,
and reports back, while you supervise. Nothing about it is a chat window bolted
onto a notebook: the agent and you operate the same notebook through the same
tools.

JupiBuddy was built during the Meta AI Hackathon (28 Oct – 5 Nov 2026). It
opens empty by default and sits on top of no existing editor. Its pre-existing
foundation is `jupyter-vscode-mcp`, used here as inspiration and base logic
only; everything in this repository — the web-native Bun frontend, the live
JupyterServerKernel, the MCP tools, and the three-pane workbench UI — was
built during the event window. The repository runs standalone from this
README.

## Why

Few tools let you work with Jupyter notebooks well, and the well-known ones
are big and heavy. JupiBuddy is the alternative for users who want to process
data in notebooks with AI help — plus a precise, lightweight Jupyter notebook
editor.

## What it does

**Real Jupyter, not a simulation.** Notebooks are real `.ipynb` files executed
by a stock Python kernel through `jupyter_server` — rich outputs, `In[n]`
execution counts, interrupt and restart included. Files saved by JupiBuddy
stay valid in JupyterLab and Colab; cell and document metadata survive the
round trip.

**The agent works in the open.** Every cell knows its writer — human or
agent — and shows its state (pending, running, ok, failed) while work happens.
A live plan tracks the agent's steps, and supervision controls let you pause
the run, approve steps, cancel queued work, and undo what the agent did.
Agent work is a visible process you direct, not a result that appears by
magic.

**The human always wins.** A single-writer queue serializes all changes; a
running cell is read-only; your edits are never blocked by the agent. Undo,
redo, and revert make a misclick cheap, and closing a dirty notebook always
asks first.

**Comfortable manual editing.** Find and replace, multi-select, drag-and-drop
cell reordering, a per-cell toolbar, copyable outputs, and a notebook-level
run progress bar — the everyday notebook ergonomics, not just the agent path.

**Environments without ceremony.** JupiBuddy discovers the Python you already
have — an explicit override, your conda environments, a `.venv` in the
workspace, Python on your PATH, or any installed kernelspec — and you can
switch kernels at any time. The agent can also provision an isolated
environment inside the workspace (`create_venv`) and install packages into the
active kernel environment (`install_packages`), so "set up a clean analysis
environment and start" is one request, not a terminal session.

**One tool surface, two doors.** The web UI and the agent call the *same*
NotebookService operations — there is no private UI back-channel. Those
operations are also exposed as MCP tools (protocol 2025-11-25) on the app's
own `/mcp` endpoint, so an external MCP client can drive the same notebook.
Agent modes: `chat-only`, `mcp-only`, or `hybrid`.

MCP tools (33 + 3 aliases, 5 groups): 11 inspect · 10 cell edits (+3 aliases) · 4 run/kernel · 6 notebook files · 2 environment.
Inspect tools are read-only and parallel-safe; all others serialize through a single-writer queue.
Environment tools (`install_packages`, `create_venv`) are long-running.
Aliases `new_cell`, `create_cell`, and `add_cell` all map to `insert_cell`.
Full table with arguments, modes, and usage notes: [`docs/MCP-TOOLS.md`](docs/MCP-TOOLS.md).

## Models

All runtime model calls are **Meta models**, offered as three fixed
options in the composer (no model slugs to configure — `.env` holds keys
only):

- **Meta** — Muse Spark 1.3 Contributor via the Meta Model API (Responses
  API with encrypted-reasoning replay) — the primary agent.
- **Baseten** — Muse Spark Open via Baseten (`meta-models/muse-spark-open-1026`,
  event credit) — the open-weight stage.
- **BasetenPublic** — Muse Spark Open via Baseten (`meta-models/muse-spark-open`,
  public slug) — the post-event path for the same model.

The agent currently supports Muse Spark and Muse Spark Open only.

## Quick start

Prerequisites: [Bun](https://bun.sh) and a Python 3 environment with
`jupyter_server` and `ipykernel` that the resolver can find (any conda env,
venv, or system Python — or point `JUPI_PYTHON` at one).

```bash
cp .env.example .env    # set META_API_KEY; BASETEN_API_KEY is optional
bun run start           # → http://localhost:3777   (add --port N to change)
```

No install step: the backend has zero runtime dependencies and the editor
loads from CDN, so there is nothing to install — `bun run start` is the
first and only command.

Open the page, choose a folder as your workspace, and either start writing
cells yourself or give the agent a task in the chat panel — for example:
*"Create an isolated environment with pandas and scikit-learn, load this CSV,
and compare two models for predicting the target column."*

To reproduce the demo video: open the `demo/` folder as the workspace, open
`bike-sharing-exam.ipynb`, pick (or provision) a kernel with pandas, numpy,
scikit-learn, and matplotlib, and give the agent the instruction quoted in
`demo/README.md`.

A background service mode is also available (`jupibuddy service
start|status|stop|restart|logs`) once the CLI is on your PATH.

## Verify it yourself

`test/` contains a one-command reproducibility harness (zero dependencies
beyond Bun). It boots the app on a scratch port, drives it over HTTP, and
checks the results against a recorded ground truth — including a fully
offline, deterministic fake-model mode (`JUPI_FAKE_MODEL=1`) that exercises
the agent path without any provider call. See `test/README.md` for the exact
sequence judges can run, and which steps need a live key.

## Configuration

| Variable | Purpose |
| --- | --- |
| `META_API_KEY` | Meta Model API key for the primary agent (required for live runs). |
| `BASETEN_API_KEY` | Optional. Enables both Baseten options (event `…-1026` + public). |
| `JUPI_PYTHON` | Optional. Interpreter that runs `jupyter_server`. |
| `JUPI_KERNEL` | Optional. Kernelspec name to select by default. |
| `PORT` / `--port` | HTTP port. Default: `3777`. |

Never commit your `.env`; `.env.example` documents exactly these keys (models
are fixed in code, not configurable).

## Layout

```
src/index.ts            entry point — boots workspace, service, server
src/cli.ts              service management (start/status/stop/restart/logs)
src/config.ts           all environment and config reads
src/server.ts           HTTP routes: workbench UI, /mcp, agent API, modes
src/transcript.ts       durable session transcripts (~/.jupibuddy)
src/web/                three-pane workbench UI (CodeMirror 6)
src/notebook/
  service.ts            NotebookService — the single source of truth
  kernel.ts             JupyterServerKernel (jupyter_server REST + WS)
  kernelResolve.ts      interpreter / kernelspec discovery and ranking
  notebook.ts           document model — stable cell IDs, 0-based indexing
src/mcp/                the notebook's own services, exposed as MCP tools
src/agent/              the AI agent loop and model providers (Muse Spark / Open)
test/                   reproducibility harness (see test/README.md)
```

## Design rules this project holds itself to

- **Stable cell IDs, never recycled; 0-based indexing in every tool; honest
  delete results** — the three recorded defects of `jupyter-vscode-mcp`
  v1.0.0, treated here as requirements.
- **One source of truth.** NotebookService owns notebook, kernel, and
  workspace; the UI and the agent both go through it.
- **No path coupling.** No reference-tree or machine-specific path appears in
  source, config, or shipped docs; reference projects are design inputs,
  never runtime dependencies.
- **License hygiene.** Code portions adapted from other projects keep their
  original copyright and license notices in place.

## License

MIT — see `LICENSE`. The foundation project, `jupyter-vscode-mcp`, is also
MIT (same author); probe code adapted from it carries its attribution in
`src/notebook/service.ts`.
