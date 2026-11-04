// Central configuration. Every environment read in the app goes through
// this module — nothing else touches process.env / Bun.env.

import { homedir } from "node:os";
import { join } from "node:path";

export type AgentMode = "chat-only" | "mcp-only" | "hybrid";

export interface JupiConfig {
  /** Port for the localhost editor server. */
  port: number;
  /** Meta Model API key. Empty string = agent loop reports "not configured". */
  metaApiKey: string;
  /** Meta Model API base URL (OpenAI-style versioned root). */
  metaBaseUrl: string;
  /** Fixed Muse Spark model slug (hardcoded — no env knob). */
  metaModel: string;
  /** Baseten key for Muse Spark Open (event-scoped credit, burn first). */
  basetenApiKey: string;
  /** Baseten base URL (default https://inference.baseten.co/v1). */
  basetenBaseUrl: string;

  // --- S1 additions (BRIEF §13 / §15) ---

  /** Explicit interpreter path override (JUPI_PYTHON). Empty = auto-resolve. */
  jupiPython: string;
  /** Explicit kernelspec name override (JUPI_KERNEL). Empty = auto-resolve. */
  jupiKernel: string;
  /** Workspace root for notebook / file operations. Defaults to $HOME. */
  workspaceRoot: string;

  // --- S2 additions (BRIEF §14 / §15) ---

  /** Agent mode toggle (default hybrid). Env JUPI_MODE overrides config file. */
  mode: AgentMode;

  /**
   * Test-harness switch (env JUPI_TEST_FAKE_STEPS=1). Enables the scripted
   * no-model step sequence in the agent loop. Deliberately an explicit flag:
   * the fake path must never be selected from task text.
   */
  testFakeSteps: boolean;
}

// Read ~/.jupibuddy/config.json if it exists (sync, called at startup only).
function readFileConfig(): Partial<Record<string, string>> {
  try {
    const p = join(homedir(), ".jupibuddy", "config.json");
    const raw = Bun.file(p);
    // Use sync read via node fs to avoid async loadConfig contract
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    if (!existsSync(p)) return {};
    const text = readFileSync(p, "utf-8") as string;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function parseMode(v: string | undefined): AgentMode | undefined {
  if (v === "chat-only" || v === "mcp-only" || v === "hybrid") return v;
  return undefined;
}

export function loadConfig(argv: string[] = Bun.argv.slice(2)): JupiConfig {
  const fileConf = readFileConfig();
  const portFlag = argv.indexOf("--port");
  const port =
    portFlag >= 0 ? Number(argv[portFlag + 1]) : Number(Bun.env.PORT ?? fileConf.PORT ?? 3777);

  // workspaceRoot: env JUPI_WORKSPACE wins over file config; empty = welcome (no auto-open)
  // For S2, boot is unresolved-friendly (no workspace = welcome screen).
  // Config's workspaceRoot is therefore optional — it controls auto-open, not kernel fallback.
  // Kernel discovery falls back to homedir separately in index.ts when workspaceRoot is empty.
  const workspaceFromEnv = Bun.env.JUPI_WORKSPACE ?? process.env.JUPI_WORKSPACE;
  const workspaceFromFile = fileConf.workspaceRoot ?? fileConf.JUPI_WORKSPACE;
  const workspaceRoot = workspaceFromEnv ?? workspaceFromFile ?? "";

  // mode: env JUPI_MODE wins over file config
  const modeFromEnv = parseMode(Bun.env.JUPI_MODE ?? process.env.JUPI_MODE);
  const modeFromFile = parseMode(fileConf.mode ?? fileConf.JUPI_MODE);

  return {
    port: Number.isFinite(port) && port > 0 ? port : 3777,
    metaApiKey: Bun.env.META_API_KEY ?? fileConf.META_API_KEY ?? "",
    metaBaseUrl: Bun.env.META_BASE_URL ?? fileConf.META_BASE_URL ?? "https://api.meta.ai/v1",
    metaModel: "muse-spark-1.3-contributor",
    basetenApiKey: Bun.env.BASETEN_API_KEY ?? fileConf.BASETEN_API_KEY ?? "",
    basetenBaseUrl: Bun.env.BASETEN_BASE_URL ?? fileConf.BASETEN_BASE_URL ?? "https://inference.baseten.co/v1",
    jupiPython: Bun.env.JUPI_PYTHON ?? process.env.JUPI_PYTHON ?? fileConf.JUPI_PYTHON ?? "",
    jupiKernel: Bun.env.JUPI_KERNEL ?? process.env.JUPI_KERNEL ?? fileConf.JUPI_KERNEL ?? "",
    workspaceRoot,
    mode: modeFromEnv ?? modeFromFile ?? "hybrid",
    testFakeSteps: (Bun.env.JUPI_TEST_FAKE_STEPS ?? process.env.JUPI_TEST_FAKE_STEPS) === "1",
  };
}
