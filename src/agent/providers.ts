// Provider layer — minimal Provider interface re-expressed from opencode's
// provider.ts pattern in plain TypeScript (no Effect). ONE implementation over
// the OpenAI-compatible fetch surface that serves BOTH Chat Completions and
// Responses with streaming + function tools. No openai npm package is added:
// fetch is sufficient for OpenAI-compatible endpoints and keeps the dep set
// at zero (Bun-native).

import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderId = "Meta" | "Baseten" | "BasetenPublic" | "Custom";
export type Protocol = "chat" | "responses";
// Native reasoning tiers. Meta serves all seven; Baseten serves four and its
// host clamps none/minimal up to low. "ultra" is client-side only (Muse Code)
// and is deliberately not a wire tier — dev-notes/MUSE-MODELS.md.
export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Effort tiers each provider actually serves (dev-notes/MUSE-MODELS.md):
 * - Meta muse-spark-1.3-contributor (Responses): all seven — "Reasoning
 *   effort (Spark 1.3)".
 * - Baseten meta-models/muse-spark-open-1026 (Responses, chat fallback):
 *   low|medium|high|xhigh — no max, default xhigh, none/minimal clamped to low
 *   by the host — "Muse Spark Open".
 * - Custom: unverified OpenAI-compatible host, so expose the full protocol set
 *   and let the upstream reject what it does not serve.
 */
export const EFFORT_BY_PROVIDER: Record<ProviderId, readonly EffortLevel[]> = {
  Meta: EFFORT_LEVELS,
  Baseten: ["low", "medium", "high", "xhigh"],
  BasetenPublic: ["low", "medium", "high", "xhigh"],
  Custom: EFFORT_LEVELS,
};

export interface Provider {
  /** Human-facing id matching the composer switcher values. */
  id: ProviderId;
  /** OpenAI-compatible base URL, e.g. https://api.meta.ai/v1 or https://inference.baseten.co/v1 */
  baseUrl: string;
  /** API key for Authorization: Bearer */
  apiKey: string;
  /** Model slug to send */
  model: string;
  /** Preferred protocol — Responses for Meta and Baseten; Chat is the loop's 404/405 fallback */
  protocol: Protocol;
  /** Display label */
  displayName: string;
  /** Context window in tokens (verified 1_048_576 for Muse Spark presets; default 200_000 for unverified future presets) */
  contextWindow: number;
}

// ---------------------------------------------------------------------------
// Preset defaults (Baseten model is LOCKED per BRIEF §13)
// ---------------------------------------------------------------------------

const META_BASE_DEFAULT = "https://api.meta.ai/v1";
const BASETEN_BASE_DEFAULT = "https://inference.baseten.co/v1";

// Fixed model slugs — no env/file overrides (keys-only env per owner).
export const META_MODEL_LOCKED = "muse-spark-1.3-contributor";
// Baseten event model is LOCKED — do not accept overrides (2026-10-31, BRIEF §13)
export const BASETEN_MODEL_LOCKED = "meta-models/muse-spark-open-1026";
// Public post-event slug (meta-oss-cookbook/muse-spark/hosted/baseten.md):
// meta-models/muse-spark-open — same family, no "-1026" event suffix.
export const BASETEN_MODEL_PUBLIC = "meta-models/muse-spark-open";

// No Baseten model env knob — presets pin locked slugs directly.


// ---------------------------------------------------------------------------
// Shared display-label helper — single source of truth for `provider/model`
// ---------------------------------------------------------------------------

/** Resolve the effective model id for a given provider (Baseten is LOCKED). */
export function getProviderModel(id: ProviderId): string {
  if (id === "Baseten") return BASETEN_MODEL_LOCKED;
  if (id === "BasetenPublic") return BASETEN_MODEL_PUBLIC;
  if (id === "Custom") {
    return envOrFile("CUSTOM_MODEL") || "";
  }
  // Meta — fixed slug, no env override
  return META_MODEL_LOCKED;
}

/** Display label `Provider/model` for composer, chips, and session records. */
export function getProviderDisplayLabel(id: ProviderId): string {
  const norm = normalizeProviderInput(id as string);
  return `${norm}/${getProviderModel(norm)}`;
}

// ---------------------------------------------------------------------------
// Config file reading — ~/.jupibuddy/config.json flat keys override env
// ---------------------------------------------------------------------------

function readFileConfig(): Record<string, string> {
  try {
    const p = join(homedir(), ".jupibuddy", "config.json");
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    if (!existsSync(p)) return {};
    const text = readFileSync(p, "utf-8") as string;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
      // Support nested providers object: { providers: { baseten: { baseUrl, apiKey, model } } }
      if (k === "providers" && v && typeof v === "object") {
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
          if (pv && typeof pv === "object") {
            for (const [fk, fv] of Object.entries(pv as Record<string, unknown>)) {
              if (typeof fv === "string") {
                const flatKey = `${pk.toUpperCase()}_${fk.toUpperCase()}`; // e.g. BASETEN_BASEURL
                out[flatKey] = fv;
                // Also normalized variant with underscore
                const norm = `${pk.toUpperCase()}_${fk.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
                out[norm] = fv;
              }
            }
          }
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function envOrFile(key: string): string {
  const fileConf = readFileConfig();
  // Spec: "Keys from env with ~/.jupibuddy/config.json override" — file wins if present
  if (fileConf[key] && fileConf[key].length > 0) return fileConf[key];
  return Bun.env[key] ?? (process.env[key] as string | undefined) ?? "";
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

/** Normalise a raw provider name; unknown names throw (no silent fallback). */
export function normalizeProviderInput(raw?: string): ProviderId {
  if (!raw) return "Meta";
  const lower = raw.trim().toLowerCase();
  if (lower === "meta") return "Meta";
  if (lower === "baseten") return "Baseten";
  if (lower === "basetenpublic" || lower === "baseten-public" || lower === "baseten_public") return "BasetenPublic";
  if (lower === "custom") return "Custom";
  throw new Error(`unknown provider "${raw}" — served: Meta, Baseten, BasetenPublic, Custom`);
}

export function resolveProvider(name?: string): Provider {
  const id = normalizeProviderInput(name);
  const fileConf = readFileConfig();

  if (id === "Meta") {
    const apiKey = envOrFile("META_API_KEY");
    if (!apiKey) {
      throw new Error(
        `Provider Meta requires META_API_KEY (set env var or ~/.jupibuddy/config.json META_API_KEY) — no silent fallback`,
      );
    }
    const baseUrl = envOrFile("META_BASE_URL") || fileConf.META_BASE_URL || META_BASE_DEFAULT;
    const model = META_MODEL_LOCKED;
    return { id, baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model, protocol: "responses", displayName: "Meta", contextWindow: 1048576 };
  }

  if (id === "Baseten") {
    const apiKey = envOrFile("BASETEN_API_KEY");
    if (!apiKey) {
      throw new Error(
        `Provider Baseten requires BASETEN_API_KEY (set env var or ~/.jupibuddy/config.json BASETEN_API_KEY) — no silent fallback`,
      );
    }
    const baseUrl = envOrFile("BASETEN_BASE_URL") || fileConf.BASETEN_BASE_URL || BASETEN_BASE_DEFAULT;
    // Model is LOCKED — Baseten serves /v1/responses (live-probed 2026-11-02: HTTP 200 with real
    // reasoning output), so Responses is the default path; loop.ts still falls
    // back to Chat Completions on 404/405.
    return {
      id,
      baseUrl: baseUrl.replace(/\/$/, ""),
      apiKey,
      model: BASETEN_MODEL_LOCKED,
      protocol: "responses",
      displayName: "Baseten",
      contextWindow: 1048576,
    };
  }

  if (id === "BasetenPublic") {
    const apiKey = envOrFile("BASETEN_API_KEY");
    if (!apiKey) {
      throw new Error(
        `Provider BasetenPublic requires BASETEN_API_KEY (set env var or ~/.jupibuddy/config.json BASETEN_API_KEY) — no silent fallback`,
      );
    }
    const baseUrl = envOrFile("BASETEN_BASE_URL") || fileConf.BASETEN_BASE_URL || BASETEN_BASE_DEFAULT;
    return {
      id,
      baseUrl: baseUrl.replace(/\/$/, ""),
      apiKey,
      model: BASETEN_MODEL_PUBLIC,
      protocol: "responses",
      displayName: "Baseten",
      contextWindow: 1048576,
    };
  }

  // Custom OpenAI-compatible provider — all three env vars required, no defaults
  const customKey = envOrFile("CUSTOM_API_KEY");
  if (!customKey) {
    throw new Error(
      `Provider Custom requires CUSTOM_API_KEY (set env var or ~/.jupibuddy/config.json CUSTOM_API_KEY) — no silent fallback`,
    );
  }
  const customBase = envOrFile("CUSTOM_BASE_URL");
  if (!customBase) {
    throw new Error(
      `Provider Custom requires CUSTOM_BASE_URL (set env var or ~/.jupibuddy/config.json CUSTOM_BASE_URL) — no silent fallback`,
    );
  }
  const customModel = envOrFile("CUSTOM_MODEL");
  if (!customModel) {
    throw new Error(
      `Provider Custom requires CUSTOM_MODEL (set env var or ~/.jupibuddy/config.json CUSTOM_MODEL) — no silent fallback`,
    );
  }
  return { id, baseUrl: customBase.replace(/\/$/, ""), apiKey: customKey, model: customModel, protocol: "chat", displayName: "Custom", contextWindow: 200000 };
}

// Helper to list available providers (for UI/config introspection)
export function listProviders(): Array<{ id: ProviderId; baseUrl: string; model: string; protocol: Protocol; hasKey: boolean }> {
  const ids: ProviderId[] = ["Meta", "Baseten", "BasetenPublic", "Custom"];
  return ids.map((id) => {
    try {
      const p = resolveProvider(id);
      return { id, baseUrl: p.baseUrl, model: p.model, protocol: p.protocol, hasKey: true };
    } catch {
      // Return defaults with hasKey false for missing keys
      if (id === "Meta") return { id, baseUrl: META_BASE_DEFAULT, model: META_MODEL_LOCKED, protocol: "responses" as Protocol, hasKey: false };
      if (id === "Baseten") return { id, baseUrl: BASETEN_BASE_DEFAULT, model: BASETEN_MODEL_LOCKED, protocol: "responses" as Protocol, hasKey: false };
      if (id === "BasetenPublic") return { id, baseUrl: BASETEN_BASE_DEFAULT, model: BASETEN_MODEL_PUBLIC, protocol: "responses" as Protocol, hasKey: false };
      return { id, baseUrl: "", model: envOrFile("CUSTOM_MODEL") || "", protocol: "chat" as Protocol, hasKey: false };
    }
  });
}

// ---------------------------------------------------------------------------
// Unified fetch core — single implementation for both endpoints
// ---------------------------------------------------------------------------

interface FetchOpts {
  provider: Provider;
  endpoint: string; // "/chat/completions" or "/responses"
  body: Record<string, unknown>;
  stream?: boolean;
}

/**
 * Core fetch for any OpenAI-compatible endpoint. Handles auth, JSON + SSE.
 * This is the ONE implementation referenced in the spec — it serves both
 * Chat and Responses by switching endpoint + body shape.
 * Implements exponential backoff 2s→10s with jitter, retry-after, capped attempts,
 * abort signal propagation, and per-request timeout.
 */
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 10000;
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS_DEFAULT = 60_000;

function getRequestTimeoutMs(): number {
  const raw = (Bun.env.JUPI_REQUEST_TIMEOUT ?? process.env.JUPI_REQUEST_TIMEOUT ?? "") as string;
  if (!raw) return REQUEST_TIMEOUT_MS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : REQUEST_TIMEOUT_MS_DEFAULT;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function getBackoffDelay(attempt: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(base, MAX_DELAY_MS);
  // jitter up to 30%
  const jitter = capped * Math.random() * 0.3;
  return capped + jitter;
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const s = header.trim();
  const secs = parseInt(s, 10);
  if (Number.isFinite(secs) && String(secs) === s) return secs * 1000;
  // Also handle if header is numeric string with spaces
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(s);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

async function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Clear listener on resolve
    // Use .finally-like cleanup via timeout wrapper - not needed for simple
  });
}

async function doFetch(opts: FetchOpts & { signal?: AbortSignal; timeoutMs?: number }): Promise<Response> {
  const url = `${opts.provider.baseUrl}${opts.endpoint}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.provider.apiKey}`,
  };
  const bodyStr = JSON.stringify(opts.body);
  const timeoutMs = opts.timeoutMs ?? getRequestTimeoutMs();
  let timeoutRetries = 0;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

    let combinedSignal: AbortSignal | undefined;
    let perAttemptTimeout: AbortSignal | undefined;
    if (timeoutMs > 0) {
      try {
        perAttemptTimeout = AbortSignal.timeout(timeoutMs);
      } catch {
        // Fallback for env without AbortSignal.timeout
        perAttemptTimeout = undefined;
      }
    }
    if (opts.signal && perAttemptTimeout) {
      try {
        combinedSignal = AbortSignal.any([opts.signal, perAttemptTimeout]);
      } catch {
        combinedSignal = opts.signal;
      }
    } else {
      combinedSignal = opts.signal ?? perAttemptTimeout;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: combinedSignal,
      });
      if (res.ok) return res;
      if (res.status === 404 || res.status === 405) return res;
      if (isRetryableStatus(res.status) && attempt < MAX_RETRIES - 1) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const delay = retryAfterMs !== undefined ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : getBackoffDelay(attempt);
        await cancellableSleep(delay, opts.signal);
        continue;
      }
      return res;
    } catch (e) {
      if (isAbortError(e)) {
        if (opts.signal?.aborted) throw e;
        // Timeout abort — retry bounded (3 timeout retries)
        if (timeoutRetries < 3 && attempt < MAX_RETRIES - 1) {
          timeoutRetries++;
          const delay = getBackoffDelay(attempt);
          try { await cancellableSleep(delay, opts.signal); } catch (abort) { throw abort; }
          continue;
        }
        throw e;
      }
      // Network error — retry if attempts remain
      if (attempt < MAX_RETRIES - 1) {
        const delay = getBackoffDelay(attempt);
        try { await cancellableSleep(delay, opts.signal); } catch (abort) { throw abort; }
        continue;
      }
      throw e;
    }
  }
  throw new Error("fetch retry exhausted");
}

// ---------------------------------------------------------------------------
// Responses API helpers (Meta primary path)
// ---------------------------------------------------------------------------

/** Accept any of the seven wire tiers, case-insensitive; reject everything else. */
export function normalizeEffort(raw?: string): EffortLevel | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as EffortLevel) : undefined;
}

/** True when `effort` is a tier the given provider serves (MUSE-MODELS.md). */
export function validateEffort(providerId: ProviderId, effort: string): boolean {
  const tier = normalizeEffort(effort);
  if (!tier) return false;
  return EFFORT_BY_PROVIDER[providerId].includes(tier);
}

/**
 * Request shape for the generic OpenAI Responses endpoint (src/agent/providers.ts).
 * Native Meta dialect defaults mirrored from opencode-v2
 * packages/ai/src/providers/meta.ts responsesRoute.defaults.providerOptions:
 * { store: false, include: ["reasoning.encrypted_content"] }.
 * Valid include values: see open-responses-options.ts ResponseIncludables;
 * core body fields: see protocols/open-responses.ts coreFields.
 */
export interface ResponsesRequest {
  model?: string;
  instructions: string;
  input: unknown[];
  tools?: unknown[];
  stream?: boolean;
  /** Optional max tokens for cheap compaction calls (plain TS, no new deps). */
  maxTokens?: number;
  /** Stable cache key per session — Meta Responses prompt_cache_key (runId). */
  promptCacheKey?: string;
  /** Reasoning effort for Responses API — wired as reasoning.effort */
  effort?: EffortLevel;
  /** Native Meta dialect: store flag (opencode-v2 meta.ts default false). */
  store?: boolean;
  /** Native Meta dialect: include list (opencode-v2 meta.ts default ["reasoning.encrypted_content"]). */
  include?: string[];
}

/**
 * Generic OpenAI Responses caller used for BOTH Meta and Baseten
 * (protocol "responses" for both, chat fallback in src/agent/loop.ts).
 * Native Meta dialect applied here: when provider.id === "Meta" default
 * body.store to req.store ?? false and body.include to
 * req.include ?? ["reasoning.encrypted_content"] — mirroring
 * opencode-v2 packages/ai/src/providers/meta.ts responsesRoute defaults.
 * For non-Meta providers (Baseten/Custom) store/include are sent ONLY if
 * explicitly passed in req (never inject Meta defaults). loop.ts callers
 * pass nothing extra, so Meta gets native defaults automatically and Baseten
 * stays generic (Baseten native is chat-only per baseten.ts; JupiBuddy
 * intentionally diverges to generic /responses, so Meta-native fields must
 * not leak to Baseten). Existing fields
 * (model/instructions/input/tools/stream/max_output_tokens/prompt_cache_key/reasoning.effort)
 * are untouched.
 */
export async function callResponses(
  provider: Provider,
  req: ResponsesRequest,
  signal?: AbortSignal,
): Promise<Response> {
  // Clamp prompt_cache_key to 64 chars defensively
  let cacheKey = req.promptCacheKey;
  if (cacheKey && cacheKey.length > 64) cacheKey = cacheKey.slice(0, 64);
  // Sanitize outgoing function_call items so `arguments` is always a valid JSON
  // string. Mirrors opencode-v2 packages/ai/src/protocols/open-responses.ts:558
  // which re-encodes via ProviderShared.encodeJson(part.input ?? {}) instead of
  // replaying raw verbatim strings — empty/invalid becomes "{}".
  function sanitizeArguments(value: unknown): string {
    if (value === undefined || value === null) return "{}";
    if (typeof value !== "string") {
      try {
        return JSON.stringify(value);
      } catch {
        return "{}";
      }
    }
    if (value.trim() === "") return "{}";
    try {
      JSON.parse(value);
      return value;
    } catch {
      return "{}";
    }
  }
  const sanitizedInput = Array.isArray(req.input)
    ? (req.input as Array<Record<string, unknown>>).map((item) => {
        if (!item || typeof item !== "object" || item.type !== "function_call") return item;
        return { ...item, arguments: sanitizeArguments((item as Record<string, unknown>).arguments) };
      })
    : req.input;
  const body: Record<string, unknown> = {
    model: req.model ?? provider.model,
    instructions: req.instructions,
    input: sanitizedInput,
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.stream ? { stream: true } : {}),
    ...(req.maxTokens ? { max_output_tokens: req.maxTokens } : {}),
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
  };
  // Native Meta dialect — see opencode-v2 packages/ai/src/providers/meta.ts
  if (provider.id === "Meta") {
    body.store = req.store ?? false;
    body.include = req.include ?? ["reasoning.encrypted_content"];
  } else {
    if (req.store !== undefined) body.store = req.store;
    if (req.include !== undefined) body.include = req.include;
  }
  return doFetch({ provider, endpoint: "/responses", body, signal });
}

// ---------------------------------------------------------------------------
// Chat Completions helpers (portable fallback — loop.ts falls through on 404/405)
// ---------------------------------------------------------------------------

export interface ChatRequest {
  model?: string;
  messages: unknown[];
  tools?: unknown[];
  stream?: boolean;
  maxTokens?: number;
  extra?: Record<string, unknown>;
  /** Effort: rejected for chat protocol (no standard field); use Meta/Responses for effort */
  effort?: EffortLevel;
}

export async function callChatCompletions(
  provider: Provider,
  req: ChatRequest,
  signal?: AbortSignal,
): Promise<Response> {
  if (req.effort !== undefined) {
    throw new Error(`effort is not supported for provider ${provider.id} (chat protocol) — omit effort or use a Responses-protocol provider`);
  }
  const body: Record<string, unknown> = {
    model: req.model ?? provider.model,
    messages: req.messages,
    ...(req.tools && req.tools.length ? { tools: req.tools } : {}),
    ...(req.stream ? { stream: true } : {}),
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.extra ?? {}),
  };
  return doFetch({ provider, endpoint: "/chat/completions", body, signal });
}

// ---------------------------------------------------------------------------
// Usage extraction — honest zeros unless provider returns cache fields
// ---------------------------------------------------------------------------

export interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Extract usage from a provider JSON response. Handles both
 * Chat Completions (prompt_tokens / completion_tokens) and
 * Responses (input_tokens / output_tokens) shapes plus
 * cache-read variants (cached_tokens, prompt_cache_hit_tokens, etc.).
 * Returns null when usage is absent — caller keeps honest zeros.
 */
export function extractUsage(data: unknown): Usage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const raw = d.usage as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = num(raw.prompt_tokens) || num(raw.input_tokens) || 0;
  const output = num(raw.completion_tokens) || num(raw.output_tokens) || 0;
  const cachedDirect =
    num((raw as Record<string, unknown>).cached_tokens) ||
    num((raw as Record<string, unknown>).prompt_cache_hit_tokens) ||
    num((raw as Record<string, unknown>).cache_read_tokens) ||
    0;
  const details = (raw.prompt_tokens_details ?? raw.input_tokens_details) as Record<string, unknown> | undefined;
  const cachedFromDetails = details ? num(details.cached_tokens) || num(details.cache_read_tokens) || 0 : 0;
  const cacheRead = cachedDirect || cachedFromDetails;
  const compDetails = raw.completion_tokens_details as Record<string, unknown> | undefined;
  const outDetails = raw.output_tokens_details as Record<string, unknown> | undefined;
  const reasoning =
    num(compDetails?.reasoning_tokens) || num(outDetails?.reasoning_tokens) || num((raw as Record<string, unknown>).reasoning_tokens) || 0;
  const cacheWrite =
    num((raw as Record<string, unknown>).cache_write_tokens) || num((raw as Record<string, unknown>).cache_creation_tokens) || 0;
  if (!input && !output && !cacheRead && !reasoning && !cacheWrite) return null;
  return { input, output, reasoning, cacheRead, cacheWrite };
}

// ---------------------------------------------------------------------------
// Tool shape translators
// ---------------------------------------------------------------------------

/** Responses tool shape: {type:"function", name, description, parameters} */
export function toResponsesTools(toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>): unknown[] {
  return toolDefs.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

/** Chat Completions tool shape: {type:"function", function:{name, description, parameters}} */
export function toChatTools(toolDefs: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>): unknown[] {
  return toolDefs.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// ---------------------------------------------------------------------------
// Conversation translation: Responses items <-> Chat messages
// ---------------------------------------------------------------------------

/**
 * Convert a Responses-style `items` array (plus system instructions) into a
 * Chat messages array. This keeps a single source of truth in loop.ts (items)
 * while allowing chat providers to participate.
 */
export function responsesItemsToChatMessages(items: unknown[], systemInstructions: string): unknown[] {
  const messages: unknown[] = [];
  if (systemInstructions) messages.push({ role: "system", content: systemInstructions });

  // Group pending function calls that belong to the same assistant turn
  let pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];

  const flushPending = () => {
    if (pendingToolCalls.length) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: pendingToolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      pendingToolCalls = [];
    }
  };

  for (const raw of items as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") continue;
    const type = raw.type as string | undefined;
    const role = raw.role as string | undefined;

    if (role === "user" && !type) {
      flushPending();
      if (Array.isArray(raw.content)) {
        const parts = (raw.content as Array<Record<string, unknown>>).map((p) => p.type === "input_image" ? { type: "image_url", image_url: p.image_url } : p.type === "input_text" ? { type: "text", text: p.text } : p);
        messages.push({ role: "user", content: parts });
      } else messages.push({ role: "user", content: raw.content });
      continue;
    }
    if (type === "function_call") {
      pendingToolCalls.push({
        id: String(raw.call_id ?? raw.id ?? `call-${pendingToolCalls.length}`),
        name: String(raw.name ?? ""),
        arguments: typeof raw.arguments === "string" ? (raw.arguments as string) : JSON.stringify(raw.arguments ?? {}),
      });
      continue;
    }
    if (type === "function_call_output") {
      flushPending();
      messages.push({
        role: "tool",
        tool_call_id: String(raw.call_id ?? raw.tool_call_id ?? ""),
        content: String(raw.output ?? ""),
      });
      continue;
    }
    if (type === "message") {
      flushPending();
      // Try to extract text from content array
      const contentArr = raw.content as unknown[] | undefined;
      let text = "";
      if (Array.isArray(contentArr)) {
        text = contentArr
          .map((c) => {
            if (c && typeof c === "object" && "text" in (c as Record<string, unknown>)) return String((c as Record<string, unknown>).text ?? "");
            if (typeof c === "string") return c;
            return "";
          })
          .join("");
      } else if (typeof raw.content === "string") {
        text = raw.content as string;
      }
      messages.push({ role: "assistant", content: text });
      continue;
    }
    // Unknown item — treat as user content if it has content
    if (raw.content) {
      flushPending();
      messages.push({ role: "user", content: String(raw.content) });
    }
  }
  flushPending();
  return messages;
}

/**
 * Convert a Chat Completions response (choices[0].message) into Responses-style
 * output items so loop.ts can handle both protocols uniformly.
 */
export function chatResponseToResponsesItems(data: {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    finish_reason?: string;
  }>;
  id?: string;
  model?: string;
}): Array<Record<string, unknown>> {
  const choice = data.choices?.[0];
  if (!choice) return [];
  const msg = choice.message;
  const out: Array<Record<string, unknown>> = [];
  if (msg?.content && typeof msg.content === "string" && msg.content.trim()) {
    out.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: msg.content }],
    });
  }
  if (msg?.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      out.push({
        type: "function_call",
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streaming helpers — SSE parsing for both protocols
// ---------------------------------------------------------------------------

/**
 * Parse SSE lines from a streaming response into JSON objects.
 * Shared by both protocols; caller decides how to aggregate.
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed === "data: [DONE]") return;
        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") return;
          try {
            yield JSON.parse(jsonStr) as Record<string, unknown>;
          } catch {
            // ignore malformed line
          }
        }
      }
    }
    // Flush remaining buffered data
    const remaining = buf.trim();
    if (remaining.startsWith("data: ") && remaining !== "data: [DONE]") {
      try {
        yield JSON.parse(remaining.slice(6)) as Record<string, unknown>;
      } catch { /* ignore */ }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Accumulate a streaming Chat Completions response into non-streaming shape */
export async function accumulateChatStream(stream: ReadableStream<Uint8Array>): Promise<{
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  rawChunks: number;
  usage?: unknown;
}> {
  let content = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let rawChunks = 0;
  let usage: unknown = null;
  // Tool call index map for delta accumulation (OpenAI streams tool calls by index)
  const toolDeltas: Map<number, { id: string; name: string; args: string }> = new Map();

  for await (const evt of parseSSE(stream)) {
    rawChunks++;
    if ((evt as Record<string, unknown>).usage) usage = (evt as Record<string, unknown>).usage;
    const choices = (evt.choices as Array<Record<string, unknown>> | undefined) ?? [];
    for (const ch of choices) {
      const delta = ch.delta as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (typeof delta.content === "string") content += delta.content;
      const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (tcs) {
        for (const tc of tcs) {
          const idx = (tc.index as number) ?? 0;
          const existing = toolDeltas.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) existing.id = String(tc.id);
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn?.name) existing.name = String(fn.name);
          if (fn?.arguments) existing.args += String(fn.arguments);
          toolDeltas.set(idx, existing);
        }
      }
    }
  }
  for (const v of toolDeltas.values()) {
    if (v.name) toolCalls.push({ id: v.id || `call-${toolCalls.length}`, name: v.name, arguments: v.args });
  }
  return { content, toolCalls, rawChunks, usage };
}

/** Accumulate a streaming Responses response — collect text and function calls */
export async function accumulateResponsesStream(stream: ReadableStream<Uint8Array>): Promise<{
  text: string;
  output: unknown[];
  rawChunks: number;
  usage?: unknown;
  status?: "completed" | "incomplete" | "failed";
  error?: string;
  incompleteReason?: string;
}> {
  let text = "";
  const output: unknown[] = [];
  let rawChunks = 0;
  let usage: unknown = null;
  let status: "completed" | "incomplete" | "failed" | undefined;
  let error: string | undefined;
  let incompleteReason: string | undefined;
  // Dedupe by wire identity — mirrors opencode-v2 meta-responses.ts completedItems/output_index rule:
  // each output item arrives as output_item.added (shell) then output_item.done (complete, same id);
  // without dedupe both land in output and replay as duplicate ids next turn (Meta 400).
  // Track seen ids + output_index positions; done replaces added at same index.
  const seenIds = new Set<string>();
  const indexPos = new Map<number, number>();
  const pushDeduped = (item: unknown, outputIndex?: number) => {
    const rec = item as Record<string, unknown> | null;
    const id = rec && typeof rec.id === "string" ? (rec.id as string) : undefined;
    if (typeof outputIndex === "number" && indexPos.has(outputIndex)) {
      const pos = indexPos.get(outputIndex)!;
      output[pos] = item;
      if (id) seenIds.add(id);
      return;
    }
    if (id && seenIds.has(id)) return;
    if (typeof outputIndex === "number") indexPos.set(outputIndex, output.length);
    if (id) seenIds.add(id);
    output.push(item);
  };
  for await (const evt of parseSSE(stream)) {
    rawChunks++;
    // Capture usage from top-level or nested response.completed
    if ((evt as Record<string, unknown>).usage) usage = (evt as Record<string, unknown>).usage;
    const respCompleted = (evt as Record<string, unknown>).response as Record<string, unknown> | undefined;
    if (respCompleted?.usage && !usage) usage = respCompleted.usage;
    // Handle terminal events
    const type = evt.type as string | undefined;
    if (type === "response.completed" || type === "response.complete") {
      status = "completed";
      const responseObj = (evt as Record<string, unknown>).response as Record<string, unknown> | undefined;
      if (responseObj) {
        if (responseObj.usage) usage = responseObj.usage;
        if (Array.isArray(responseObj.output) && !output.length) output.push(...(responseObj.output as unknown[]));
      }
      // Also capture usage from nested response.response
      const nested = (evt as Record<string, unknown>).response as Record<string, unknown> | undefined;
      if (nested && (nested as Record<string, unknown>).usage) usage = (nested as Record<string, unknown>).usage;
      continue;
    } else if (type === "response.incomplete" || type === "response.incomplete_details") {
      status = "incomplete";
      const details = (evt as Record<string, unknown>).incomplete_details ?? (evt as Record<string, unknown>).details;
      if (details && typeof details === "object") incompleteReason = (details as Record<string, unknown>).reason as string | undefined;
      else if (typeof (evt as Record<string, unknown>).reason === "string") incompleteReason = (evt as Record<string, unknown>).reason as string;
      continue;
    } else if (type === "response.failed" || type === "response.error") {
      status = "failed";
      error = (evt as Record<string, unknown>).error as string | undefined ?? (evt as Record<string, unknown>).message as string | undefined;
      continue;
    }
    if (type === "response.output_text.delta" && typeof evt.delta === "string") {
      text += evt.delta;
    } else if (type?.includes("output_text") && typeof (evt as Record<string, unknown>).delta === "string") {
      text += (evt as Record<string, unknown>).delta as string;
    } else if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = evt.item as unknown;
      if (item) {
        const outputIndex = typeof (evt as Record<string, unknown>).output_index === "number"
          ? ((evt as Record<string, unknown>).output_index as number)
          : undefined;
        pushDeduped(item, outputIndex);
      }
    } else if (Array.isArray((evt as Record<string, unknown>).output)) {
      for (const el of ((evt as Record<string, unknown>).output as unknown[])) pushDeduped(el);
    } else if (typeof (evt as Record<string, unknown>).content === "string") {
      text += (evt as Record<string, unknown>).content as string;
    }
    // Also handle usage in response.completed wrapper already above
    if ((evt as Record<string, unknown>).response && typeof (evt as Record<string, unknown>).response === "object") {
      const r = (evt as Record<string, unknown>).response as Record<string, unknown>;
      if (r.usage && !usage) usage = r.usage;
    }
  }
  if (text && !output.some((o) => (o as Record<string, unknown>).type === "message")) {
    output.push({ type: "message", content: [{ text }] });
  }
  // Prefer completed status if we saw it; default to completed when stream ended normally
  if (!status && output.length) status = "completed";
  return { text, output, rawChunks, usage, status, error, incompleteReason };
}

// ---------------------------------------------------------------------------
// Streaming with progressive emit — reuse parseSSE + delta accumulation
// Justified: plain TypeScript, no new deps, reuses existing helpers
// ---------------------------------------------------------------------------

/**
 * Chat streaming that emits text deltas as they arrive.
 * Reuses the same index-based tool-call accumulation as accumulateChatStream
 * (opencode-v2 llm.ts pattern) but calls onDelta for live UI.
 */
export async function accumulateChatStreamWithEmit(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; rawChunks: number; usage?: unknown }> {
  let content = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let rawChunks = 0;
  let usage: unknown = null;
  const toolDeltas: Map<number, { id: string; name: string; args: string }> = new Map();
  for await (const evt of parseSSE(stream)) {
    rawChunks++;
    if ((evt as Record<string, unknown>).usage) usage = (evt as Record<string, unknown>).usage;
    const choices = (evt.choices as Array<Record<string, unknown>> | undefined) ?? [];
    for (const ch of choices) {
      const delta = ch.delta as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (typeof delta.content === "string") {
        const chunk = delta.content as string;
        content += chunk;
        if (onDelta && chunk) onDelta(chunk);
      }
      const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (tcs) {
        for (const tc of tcs) {
          const idx = (tc.index as number) ?? 0;
          const existing = toolDeltas.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) existing.id = String(tc.id);
          const fn = tc.function as Record<string, unknown> | undefined;
          if (fn?.name) existing.name = String(fn.name);
          if (fn?.arguments) existing.args += String(fn.arguments);
          toolDeltas.set(idx, existing);
        }
      }
    }
  }
  for (const v of toolDeltas.values()) {
    if (v.name) toolCalls.push({ id: v.id || `call-${toolCalls.length}`, name: v.name, arguments: v.args });
  }
  return { content, toolCalls, rawChunks, usage };
}

/**
 * Responses streaming with progressive emit.
 * Reuses same event-shape handling as accumulateResponsesStream
 * (output_item events for Responses) but emits text deltas live.
 */
export async function accumulateResponsesStreamWithEmit(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<{ text: string; output: unknown[]; rawChunks: number; usage?: unknown; status?: "completed" | "incomplete" | "failed"; error?: string; incompleteReason?: string }> {
  let text = "";
  const output: unknown[] = [];
  let rawChunks = 0;
  let usage: unknown = null;
  let status: "completed" | "incomplete" | "failed" | undefined;
  let error: string | undefined;
  let incompleteReason: string | undefined;
  // Dedupe by wire identity — mirrors opencode-v2 meta-responses.ts completedItems/output_index rule:
  // each output item arrives as output_item.added (shell) then output_item.done (complete, same id);
  // without dedupe both land in output and replay as duplicate ids next turn (Meta 400).
  // Track seen ids + output_index positions; done replaces added at same index.
  const seenIds = new Set<string>();
  const indexPos = new Map<number, number>();
  const pushDeduped = (item: unknown, outputIndex?: number) => {
    const rec = item as Record<string, unknown> | null;
    const id = rec && typeof rec.id === "string" ? (rec.id as string) : undefined;
    if (typeof outputIndex === "number" && indexPos.has(outputIndex)) {
      const pos = indexPos.get(outputIndex)!;
      output[pos] = item;
      if (id) seenIds.add(id);
      return;
    }
    if (id && seenIds.has(id)) return;
    if (typeof outputIndex === "number") indexPos.set(outputIndex, output.length);
    if (id) seenIds.add(id);
    output.push(item);
  };
  for await (const evt of parseSSE(stream)) {
    rawChunks++;
    if ((evt as Record<string, unknown>).usage) usage = (evt as Record<string, unknown>).usage;
    const respObj = (evt as Record<string, unknown>).response as Record<string, unknown> | undefined;
    if (respObj?.usage && !usage) usage = respObj.usage;
    const type = evt.type as string | undefined;
    if (type === "response.completed" || type === "response.complete") {
      status = "completed";
      const responseObj = (evt as Record<string, unknown>).response as Record<string, unknown> | undefined;
      if (responseObj) {
        if (responseObj.usage) usage = responseObj.usage;
        if (Array.isArray(responseObj.output) && output.length === 0) output.push(...(responseObj.output as unknown[]));
      }
      continue;
    } else if (type === "response.incomplete" || type === "response.incomplete_details") {
      status = "incomplete";
      const details = (evt as Record<string, unknown>).incomplete_details ?? (evt as Record<string, unknown>).details;
      if (details && typeof details === "object") incompleteReason = (details as Record<string, unknown>).reason as string | undefined;
      else if (typeof (evt as Record<string, unknown>).reason === "string") incompleteReason = (evt as Record<string, unknown>).reason as string;
      continue;
    } else if (type === "response.failed" || type === "response.error") {
      status = "failed";
      error = (evt as Record<string, unknown>).error as string | undefined ?? (evt as Record<string, unknown>).message as string | undefined;
      continue;
    }
    if (type === "response.output_text.delta" && typeof evt.delta === "string") {
      const chunk = evt.delta as string;
      text += chunk;
      if (onDelta && chunk) onDelta(chunk);
    } else if (type?.includes("output_text") && typeof (evt as Record<string, unknown>).delta === "string") {
      const chunk = (evt as Record<string, unknown>).delta as string;
      text += chunk;
      if (onDelta && chunk) onDelta(chunk);
    } else if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = evt.item as unknown;
      if (item) {
        const outputIndex = typeof (evt as Record<string, unknown>).output_index === "number"
          ? ((evt as Record<string, unknown>).output_index as number)
          : undefined;
        pushDeduped(item, outputIndex);
      }
    } else if (Array.isArray((evt as Record<string, unknown>).output)) {
      for (const el of ((evt as Record<string, unknown>).output as unknown[])) pushDeduped(el);
    } else if (typeof (evt as Record<string, unknown>).content === "string") {
      const chunk = (evt as Record<string, unknown>).content as string;
      text += chunk;
      if (onDelta && chunk) onDelta(chunk);
    }
    if (respObj?.usage && !usage) usage = respObj.usage;
  }
  if (text && !output.some((o) => (o as Record<string, unknown>).type === "message")) {
    output.push({ type: "message", content: [{ text }] });
  }
  if (!status && output.length) status = "completed";
  return { text, output, rawChunks, usage, status, error, incompleteReason };
}

export function messagesWithImages(messages: unknown[], images: Array<{ mime: string; b64: string }>): unknown[] {
  if (!images.length) return messages;
  const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
  if (!last || last.role !== "user") return messages;
  const base = typeof last.content === "string" ? last.content as string : String(last.content ?? "");
  const parts: unknown[] = [{ type: "text", text: base }];
  for (const im of images) parts.push({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.b64}` } });
  return [...messages.slice(0, -1), { role: "user", content: parts }];
}
export function responsesInputWithImages(input: unknown[], images: Array<{ mime: string; b64: string }>): unknown[] {
  if (!images.length) return input;
  const last = input[input.length - 1] as Record<string, unknown> | undefined;
  if (!last) return input;
  const base = typeof last.content === "string" ? last.content as string : String((last as Record<string,unknown>).content ?? "");
  const parts: unknown[] = [{ type: "input_text", text: base }];
  for (const im of images) parts.push({ type: "input_image", image_url: `data:${im.mime};base64,${im.b64}` });
  return [...input.slice(0, -1), { role: "user", content: parts }];
}

// ---------------------------------------------------------------------------
// Ghost completion — tiny one-shot suggestion call (additive).
//
// Used by POST /api/complete/ghost. Same routing rules as the agent loop:
// resolveProvider() with no silent fallback (a missing key is reported, not
// papered over by another provider), and the provider's preferred protocol
// (Responses for Meta and Baseten, Chat as fallback). No tools are offered to
// the model, so the agent loop's approval gate does not apply here.
// Never logs: no code content, no keys.
// ---------------------------------------------------------------------------

/** Deliberately tiny instruction — the whole feature is one short completion. */
const SUGGEST_INSTRUCTION =
  "You are a Python autocomplete engine. Complete this python code, return ONLY the completion text, max 200 chars, no explanations.";

const SUGGEST_MAX_SOURCE_CHARS = 2000;
const SUGGEST_TIMEOUT = Symbol("suggest-timeout");

export interface SuggestOptions {
  /** Active cell source (already budget-checked by the route). */
  code: string;
  /** Cursor offset into `code` (clamped into range). */
  cursorPos: number;
  /** Raw provider name from `?provider=` — default Baseten. */
  provider?: string;
  /** Wall-clock budget; on expiry the ghost is null. Default 15000 ms. */
  timeoutMs?: number;
  /** Max characters returned. Default 500. */
  maxChars?: number;
  /**
   * Max output tokens for the completion call. Default 1024 — muse-spark
   * spends most of the budget on reasoning before the visible completion
   * (verified live 2026-10-31: 256 → finish "length", content null; 800 → "2)").
   */
  maxTokens?: number;
}

export interface SuggestResult {
  /** Raw model text, trimmed and capped at maxChars; null when nothing usable. */
  ghost: string | null;
  model?: string;
  /** Honest failure text — never contains request code or keys. */
  error?: string;
  /** True when the requested provider has no key (route answers 503). */
  noKey?: boolean;
  /** True when the call exceeded timeoutMs (route answers 200 + null ghost). */
  timedOut?: boolean;
}

/**
 * Build the tiny prompt: at most 2000 chars of source around the cursor with
 * a `<|cursor|>` marker. When the cell is longer, the window is biased so the
 * cursor stays visible; truncation is marked honestly.
 */
function buildSuggestPrompt(code: string, cursorPos: number): string {
  const pos = Math.max(0, Math.min(code.length, Math.floor(cursorPos)));
  let windowStart = 0;
  let snippet = code;
  let truncatedHead = false;
  let truncatedTail = false;

  if (code.length > SUGGEST_MAX_SOURCE_CHARS) {
    const bias = Math.floor(SUGGEST_MAX_SOURCE_CHARS * 0.75);
    windowStart = Math.max(0, Math.min(pos - bias, code.length - SUGGEST_MAX_SOURCE_CHARS));
    snippet = code.slice(windowStart, windowStart + SUGGEST_MAX_SOURCE_CHARS);
    truncatedHead = windowStart > 0;
    truncatedTail = windowStart + SUGGEST_MAX_SOURCE_CHARS < code.length;
  }

  const localCursor = pos - windowStart;
  const marked = `${snippet.slice(0, localCursor)}<|cursor|>${snippet.slice(localCursor)}`;
  const head = truncatedHead ? "[...earlier code truncated...]\n" : "";
  const tail = truncatedTail ? "\n[...later code truncated...]" : "";
  return `${head}${marked}${tail}`;
}

export async function suggestCompletion(opts: SuggestOptions): Promise<SuggestResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxChars = opts.maxChars ?? 500;
  const maxTokens = opts.maxTokens ?? 1024;

  let provider: Provider;
  try {
    provider = resolveProvider(opts.provider ?? "Baseten");
  } catch (e) {
    // Missing key OR unknown provider — no silent fallback to another.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("unknown provider")) return { ghost: null, error: msg };
    return { ghost: null, noKey: true, error: "no provider key" };
  }

  const prompt = buildSuggestPrompt(opts.code, opts.cursorPos);

  const work: Promise<{ text: string; model?: string }> = (async () => {
    if (provider.protocol === "responses") {
      const res = await callResponses(provider, {
        instructions: SUGGEST_INSTRUCTION,
        input: [{ role: "user", content: prompt }],
        maxTokens,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      const data = (await res.json()) as {
        output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
        model?: string;
      };
      const text = (data.output ?? [])
        .filter((o) => o.type === "message")
        .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .join("");
      return { text, model: data.model };
    }

    const res = await callChatCompletions(provider, {
      messages: [
        { role: "system", content: SUGGEST_INSTRUCTION },
        { role: "user", content: prompt },
      ],
      maxTokens,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      model?: string;
    };
    return { text: data.choices?.[0]?.message?.content ?? "", model: data.model };
  })();

  // A late rejection after the timeout must not surface as unhandled.
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(SUGGEST_TIMEOUT), timeoutMs);
      }),
    ]);
    const trimmed = result.text.trim();
    return {
      ghost: trimmed ? trimmed.slice(0, maxChars) : null,
      model: result.model ?? provider.model,
    };
  } catch (e) {
    if (e === SUGGEST_TIMEOUT) return { ghost: null, timedOut: true, error: "timeout" };
    const msg = e instanceof Error ? e.message : String(e);
    return { ghost: null, error: msg.slice(0, 300) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
