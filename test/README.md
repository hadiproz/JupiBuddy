# Reproducibility

One-command reproducibility harness for judges. Zero new dependencies (Bun + plain TS).

## Flow

```
preflight → reset → boot server → demo-case (offline) → verify-demo → demo-case --with-agent (JUPI_FAKE_MODEL=1)
```

### 1. preflight

```bash
bun run test/preflight.ts [--port 3777]
```

Checks: `bun check` clean, port free, python sidecar (`import jupyter_server` + `ipykernel` ok on `JUPI_PYTHON` or auto-resolved), `BASETEN_API_KEY` hasKey true/false (value never printed), workspace dir exists/writable. Prints `PASS/FAIL` per check, exits 1 on any FAIL.

### 2. reset

```bash
bun run test/reset.ts --port 3777 --yes
```

Demo-clean: kills test servers on that port (only bun processes matching JupiBuddy), backs up `~/.jupibuddy/sessions.json` to `sessions.bak-<ts>` then clears it, removes `/tmp/jupi-*` scratch. Leaves `.venv` and repo untouched. Without `--yes` it prompts.

### 3. demo-case

```bash
# Core (no key needed):
JUPI_KERNEL_STUB=1 bun run src/index.ts --port 3888 &
bun run test/demo-case.ts --port 3888
# writes test/ground-truth.json

# With deterministic fake agent (offline, no provider call):
JUPI_FAKE_MODEL=1 JUPI_KERNEL_STUB=1 bun run src/index.ts --port 3888 &
bun run test/demo-case.ts --port 3888 --with-agent
```

What it does: creates a small `fixture.csv` in `workspaceDir`, drives the running server via HTTP (`/healthz`, `/api/workspace/open`, `/api/notebook/open`, `/api/cell/insert` `print(1+1)`, `/api/cell/run`, `/api/notebook/content`, `/api/workspace/files`), optionally triggers `POST /api/agent/run` and checks `GET /api/agent/sessions`, writes `test/ground-truth.json`.

### 4. verify-demo

```bash
bun run test/verify-demo.ts --port 3888
```

Re-checks a fresh run against `ground-truth.json` (workspace files present, cell count, expected outputs contain `2` or echo stub, session summary contains `FAKE`/`42` when `withAgent`). Prints `PASS/FAIL` per assertion.

## What judges run

Offline (no key): `preflight`, `reset --yes`, boot on test port with `JUPI_KERNEL_STUB=1`, `demo-case` without `--with-agent`, `verify-demo`, then with `JUPI_FAKE_MODEL=1` boot + `demo-case --with-agent` (deterministic agent path).

## What needs a key vs offline

- **Offline (no key):** `preflight` (all but python check pass without key), `reset`, `demo-case` without `--with-agent`, `verify-demo`, `demo-case --with-agent` with `JUPI_FAKE_MODEL=1` (fake branch, no provider call).
- **Live model:** `demo-case --with-agent` without `JUPI_FAKE_MODEL=1` requires `BASETEN_API_KEY` (or `META_API_KEY`) and real `jupyter_server`. Mark as NOT-VERIFIED if not run.

## Fake-model mode

Set `JUPI_FAKE_MODEL=1` — `POST /api/agent/run` returns a deterministic canned sequence (insert deterministic cell `FAKE_VALUE=42`, `run_cells`, summary containing `FAKE:42`) without calling any provider. Env-gated, clearly marked in `src/server.ts`, never active otherwise. Curl-provable:

```bash
JUPI_FAKE_MODEL=1 JUPI_KERNEL_STUB=1 bun run src/index.ts --port 3889 &
curl -s http://127.0.0.1:3889/api/agent/run -H 'content-type: application/json' -d '{"task":"hello"}' | jq .summary
```
