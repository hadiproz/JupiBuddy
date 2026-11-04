// Python / kernel discovery — metadata-only, no arbitrary code execution.
//
// Discovery priority (BRIEF §13, reordered 2026-11-02 — installed Pythons first,
// workspace .venv last):
//   1. JUPI_PYTHON / JUPI_KERNEL env override (highest)
//   2. conda env list --json + ~/.conda/environments.txt
//   3. PATH (python3 / python)
//   4. jupyter kernelspec list --json fallback
//   5. workspace .venv (last resort — only when no installed Python qualifies;
//      create_venv stays the explicit opt-in for isolation)
//
// Every probe is metadata-only: we read kernel.json / conda-meta or run
// `python --version`-level probes on candidate selection, never executing
// arbitrary user Python.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// Re-exported so callers can hold a reference to the chosen spec (e.g. for toIpynb).
export interface ResolvedCandidate {
  /** Kernelspec name (the key under kernelspecs). */
  name: string;
  displayName: string;
  /** Absolute path to the interpreter binary. */
  pythonPath: string;
  /** e.g. "3.14.6" or "" if unknown. */
  version: string;
  /** Where this candidate came from. */
  source: "env-override" | "conda" | "path" | "workspace-venv" | "kernelspec";
  /** Absolute kernelspec directory, when known. */
  specDir?: string;
  /** Raw argv from kernel.json, when known. */
  argv?: string[];
}

interface KernelspecEntry {
  name: string;
  spec: { argv: string[]; display_name: string; language: string; InterruptMode?: string };
  resource_dir: string;
}

// ---- small helpers ----

async function probeVersion(pythonPath: string): Promise<string> {
  try {
    const proc = Bun.spawn([pythonPath, "--version"], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;
    const m = out.match(/Python\s+(\S+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function pathExistsSync(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

async function tryReadJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const t = await Bun.file(path).text();
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function spawnJson(cmd: string, args: string[]): Promise<Record<string, unknown> | null> {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---- source 3: PATH ----

async function candidatesFromPath(): Promise<ResolvedCandidate[]> {
  const out: ResolvedCandidate[] = [];
  for (const bin of ["python3", "python"]) {
    try {
      // which -a: take EVERY match on PATH, not just the first — a conda
      // shim must not hide /usr/bin/python3 or brew Pythons (2026-11-02).
      const proc = Bun.spawn(["which", "-a", bin], { stdout: "pipe", stderr: "pipe" });
      const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((s) => s.trim()).filter(Boolean);
      await proc.exited;
      if (proc.exitCode !== 0) continue;
      for (const p of lines) {
        // de-dupe
        if (out.some((c) => c.pythonPath === p)) continue;
        const short = p.includes("python3") ? "python3" : "python";
        out.push({
          name: out.some((c) => c.name === short) ? `${short}-${out.length}` : short,
          displayName: `Python (${bin} — ${p})`,
          pythonPath: p,
          version: await probeVersion(p),
          source: "path",
        });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

// ---- source 2: conda ----

async function candidatesFromConda(): Promise<ResolvedCandidate[]> {
  const out: ResolvedCandidate[] = [];
  const seenEnvs = new Set<string>();

  // 2a. conda env list --json (covers managed envs)
  const condaData = await spawnJson("conda", ["env", "list", "--json"]);
  if (condaData && Array.isArray(condaData.envs)) {
    for (const envPath of condaData.envs as string[]) {
      if (!envPath) continue;
      if (seenEnvs.has(envPath)) continue;
      seenEnvs.add(envPath);
      const py = await pickPythonInEnv(envPath);
      if (!py) continue;
      const envName = envPath.split("/").pop() ?? envPath;
      out.push({
        name: `conda-${envName}`,
        displayName: `Conda: ${envName} (${envPath})`,
        pythonPath: py,
        version: await probeVersion(py),
        source: "conda",
      });
    }
  }

  // 2b. ~/.conda/environments.txt fallback (covers conda envs even when conda CLI is absent / slow)
  const envTxt = join(homedir(), ".conda", "environments.txt");
  try {
    const text = await Bun.file(envTxt).text();
    for (const line of text.split("\n")) {
      const envPath = line.trim();
      if (!envPath || envPath.startsWith("#") || seenEnvs.has(envPath)) continue;
      seenEnvs.add(envPath);
      const py = await pickPythonInEnv(envPath);
      if (!py) continue;
      const envName = envPath.split("/").pop() ?? envPath;
      out.push({
        name: `conda-${envName}`,
        displayName: `Conda: ${envName} (${envPath})`,
        pythonPath: py,
        version: await probeVersion(py),
        source: "conda",
      });
    }
  } catch {
    // file missing is fine
  }

  return out;
}

async function pickPythonInEnv(envPath: string): Promise<string | null> {
  for (const rel of ["bin/python3", "bin/python", "python.exe", "python3.exe"]) {
    const candidate = join(envPath, rel);
    if (pathExistsSync(candidate)) return candidate;
  }
  return null;
}

// ---- source 3b: workspace .venv ----

async function candidateFromWorkspaceVenv(workspaceRoot: string): Promise<ResolvedCandidate | null> {
  const venvPath = resolve(workspaceRoot, ".venv");
  const py = await pickPythonInEnv(venvPath);
  if (!py) return null;
  return {
    name: "workspace-venv",
    displayName: `Workspace .venv (${venvPath})`,
    pythonPath: py,
    version: await probeVersion(py),
    source: "workspace-venv",
  };
}

// ---- source 4: jupyter kernelspec list --json ----

async function candidatesFromKernelspecs(): Promise<ResolvedCandidate[]> {
  const out: ResolvedCandidate[] = [];
  // Try a few python binaries that might have jupyter installed; also bare `jupyter`.
  const tryBins: string[] = [];
  for (const b of ["jupyter", "python3", "python"]) {
    try {
      const proc = Bun.spawn(["which", b], { stdout: "pipe", stderr: "pipe" });
      const p = (await new Response(proc.stdout).text()).trim().split("\n")[0]?.trim();
      await proc.exited;
      if (p) tryBins.push(p);
    } catch {
      // ignore
    }
  }
  // Also include python from JUPI_PYTHON if it exists, as it may be the one with jupyter
  const extraPy = process.env.JUPI_PYTHON ?? Bun.env.JUPI_PYTHON;
  if (extraPy && !tryBins.includes(extraPy)) tryBins.push(extraPy);

  // The jupyter CLI case: `jupyter kernelspec list --json`
  const tryCommands: Array<[string, string[]]> = tryBins.map((bin) =>
    bin.endsWith("jupyter") || bin.includes("jupyter")
      ? [bin, ["kernelspec", "list", "--json"]]
      : [bin, ["-m", "jupyter", "kernelspec", "list", "--json"]],
  );

  let kernelspecData: Record<string, unknown> | null = null;
  for (const [cmd, args] of tryCommands) {
    kernelspecData = await spawnJson(cmd, args);
    if (kernelspecData) break;
  }
  if (!kernelspecData) return out;

  const kernelspecs = kernelspecData.kernelspecs as
    | Record<string, { resource_dir: string; spec: KernelspecEntry["spec"] }>
    | undefined;
  if (!kernelspecs) return out;

  for (const [name, entry] of Object.entries(kernelspecs)) {
    const argv = entry.spec?.argv ?? [];
    // The first argv element is typically the interpreter
    const pythonPath = argv[0] ?? "";
    out.push({
      name,
      displayName: entry.spec?.display_name ?? name,
      pythonPath,
      version: "", // kernelspec metadata has no version; resolved lazily when selected
      source: "kernelspec",
      specDir: entry.resource_dir,
      argv,
    });
  }
  return out;
}

// ---- env override ----

async function candidateFromEnv(): Promise<ResolvedCandidate | null> {
  const explicitPy = process.env.JUPI_PYTHON ?? Bun.env.JUPI_PYTHON;
  const explicitKernel = process.env.JUPI_KERNEL ?? Bun.env.JUPI_KERNEL;

  // JUPI_PYTHON takes precedence — it names an interpreter
  if (explicitPy) {
    if (!pathExistsSync(explicitPy)) {
      // Don't throw; let the caller report "not found" via empty list + status
      return null;
    }
    return {
      name: explicitKernel ?? "env-override",
      displayName: `Env override: ${explicitPy}`,
      pythonPath: resolve(explicitPy),
      version: await probeVersion(resolve(explicitPy)),
      source: "env-override",
    };
  }

  // JUPI_KERNEL alone names a kernelspec to select; we resolve it via kernelspec list below.
  // Return null here so the caller falls through to kernelspec discovery and matches by name.
  return null;
}

// ---- public API ----

export interface ResolveOptions {
  /** Workspace root for .venv discovery. Defaults to HOME. */
  workspaceRoot?: string;
  /** If set, filter to a single kernelspec name (from JUPI_KERNEL). */
  preferredKernelName?: string;
  /** If set, filter to a single interpreter path (from JUPI_PYTHON / select_kernel). */
  preferredInterpreterPath?: string;
}

/**
 * Discover available Python / kernel candidates.
 * Metadata-only scan; never executes user Python beyond `--version` probes.
 */
export async function resolveCandidates(opts: ResolveOptions = {}): Promise<ResolvedCandidate[]> {
  const workspaceRoot = opts.workspaceRoot ?? homedir();
  const preferredKernelName = opts.preferredKernelName ?? process.env.JUPI_KERNEL ?? Bun.env.JUPI_KERNEL ?? "";
  const preferredInterpreter = opts.preferredInterpreterPath ?? process.env.JUPI_PYTHON ?? Bun.env.JUPI_PYTHON ?? "";

  // If JUPI_PYTHON points to a concrete interpreter, it wins outright — but only for top-level
  // discovery. When caller explicitly asks for a kernel by name (select_kernel), do full discovery.
  const callerAsksByName = !!opts.preferredKernelName;
  if (preferredInterpreter && !preferredKernelName && !callerAsksByName) {
    const envCand = await candidateFromEnv();
    if (envCand) return [envCand];
  }

  const results: ResolvedCandidate[] = [];

  // Collect all sources in priority order (priority is encoded in rank below, but
  // we keep insertion order = priority for the ranking pass).
  const envCand = await candidateFromEnv();
  if (envCand) results.push(envCand);

  const condaCands = await candidatesFromConda();
  results.push(...condaCands);

  const pathCands = await candidatesFromPath();
  for (const c of pathCands) {
    if (!results.some((r) => r.pythonPath === c.pythonPath)) results.push(c);
  }

  const kernelspecCands = await candidatesFromKernelspecs();
  for (const c of kernelspecCands) {
    // Deduplicate only when both pythonPath and candidate name match an existing entry.
    // Different kernelspec names sharing the same interpreter (e.g. python3 vs jupibuddy-test
    // both on the same venv) are distinct and must both be kept — otherwise select_kernel
    // cannot find the alternate name.
    if (results.some((r) => r.pythonPath === c.pythonPath && r.name === c.name)) continue;
    results.push(c);
  }

  // Workspace .venv LAST (2026-11-02): installed Pythons first; a stale
  // experimental .venv must never hijack the default silently.
  const venvCand = await candidateFromWorkspaceVenv(workspaceRoot);
  if (venvCand && !results.some((r) => r.pythonPath === venvCand.pythonPath)) results.push(venvCand);

  // Filter by preferredKernelName if requested (JUPI_KERNEL)
  if (preferredKernelName) {
    const named = results.filter((r) => r.name === preferredKernelName);
    if (named.length) return rankCandidates(named, preferredKernelName, preferredInterpreter);
  }
  if (preferredInterpreter) {
    const matched = results.filter((r) => r.pythonPath === resolve(preferredInterpreter));
    if (matched.length) return rankCandidates(matched, preferredKernelName, preferredInterpreter);
  }

  return rankCandidates(results, preferredKernelName, preferredInterpreter);
}

function rankCandidates(
  cands: ResolvedCandidate[],
  preferredName: string,
  preferredPath: string,
): ResolvedCandidate[] {
  const priority: Record<ResolvedCandidate["source"], number> = {
    "env-override": 0,
    conda: 1,
    path: 2,
    kernelspec: 3,
    "workspace-venv": 4,
  };
  return [...cands].sort((a, b) => {
    if (preferredName) {
      const aHit = a.name === preferredName ? -1 : 1;
      const bHit = b.name === preferredName ? -1 : 1;
      if (aHit !== bHit) return aHit - bHit;
    }
    if (preferredPath) {
      const aHit = a.pythonPath === preferredPath ? -1 : 1;
      const bHit = b.pythonPath === preferredPath ? -1 : 1;
      if (aHit !== bHit) return aHit - bHit;
    }
    return (priority[a.source] ?? 99) - (priority[b.source] ?? 99);
  });
}

/** Convenience: return the single best candidate, or null if none found. */
export async function resolveBest(opts: ResolveOptions = {}): Promise<ResolvedCandidate | null> {
  const cands = await resolveCandidates(opts);
  return cands[0] ?? null;
}
