// The agent loop: model call → tool calls → observe → next step.
//
// Mechanics borrowed conceptually from the opencode-v2 runner reference
// (SOURCES.md §5): a hard step budget with a "stop and summarize" ending,
// and one retry on transient model-call failure. Protocol: Meta Model API
// **Responses API** — the recommended path for multi-turn agents, using
// stateless encrypted reasoning replay: the client resends the item list
// each turn and the model's reasoning items travel with it (BRIEF.md §5).
// Chat Completions is the portable fallback for Custom hosts and 404/405 fallback.

import type { JupiConfig } from "../config";
import { callTool, type ToolDef } from "../mcp/tools";
import {
  resolveProvider,
  callResponses,
  callChatCompletions,
  toResponsesTools,
  toChatTools,
  responsesItemsToChatMessages,
  chatResponseToResponsesItems,
  accumulateChatStreamWithEmit,
  accumulateResponsesStreamWithEmit,
  messagesWithImages,
  responsesInputWithImages,
  extractUsage,
  type Provider,
  type Usage,
} from "./providers";
import type { NotebookService } from "../notebook/service";
import type { TranscriptWriter } from "../transcript";
import { existsSync, readFileSync } from "node:fs";

export interface AgentRunResult {
  ok: boolean;
  steps: number;
  summary: string;
  /** Echoed provider id/model for verification */
  provider?: string;
  model?: string;
  /** Compaction bookkeeping */
  compacted?: boolean;
  turnsDropped?: number;
  streamed?: boolean;
  cancelled?: boolean;
  steered?: boolean;
  approvals?: Array<{ tool: string; decision: string }>;
  stuck?: boolean;
  effort?: string;
}

const RISKY_TOOLS = new Set(["write_file", "install_packages", "create_venv", "run_cells"]);

export type AttachmentInput = { id?: string; data?: string; mime?: string; name?: string };
export interface SupervisionOpts {
  signal?: AbortSignal | null;
  requireApproval?: boolean;
  service?: NotebookService | null;
  runId?: string;
  attachments?: AttachmentInput[];
  transcript?: TranscriptWriter | null;
  effort?: string;
}

export interface ContinuationHistory {
  sessionId: string;
  items: unknown[];
  summary?: Record<string, unknown> | null;
}
async function resolveAttachments(attachments: AttachmentInput[] | undefined, service: NotebookService | null | undefined): Promise<{ textItems: unknown[]; images: Array<{ mime: string; b64: string }>; totalBytes: number; note?: string; ids: string[] }> {
  const textItems: unknown[] = [];
  const images: Array<{ mime: string; b64: string }> = [];
  let totalBytes = 0; const ids: string[] = []; let note: string | undefined;
  if (!attachments?.length) return { textItems, images, totalBytes, ids };
  if (attachments.length > 10) return { textItems, images, totalBytes, note: `too many attachments: ${attachments.length} (max 10 per run)`, ids };
  for (const a of attachments) {
    let name = a.name || "attachment", mime = (a.mime || "").toLowerCase().split(";")[0].trim(), b64 = "", text = "";
    if (a.id) {
      if (!service) { note = (note ? note + " " : "") + `skip ${a.id}: no service`; continue; }
      try { const got = await service.getAttachment(a.id); mime = got.mime; name = got.name; b64 = Buffer.from(got.bytes).toString("base64"); if (mime.startsWith("text/")) text = Buffer.from(got.bytes).toString("utf-8"); totalBytes += got.bytes.length; ids.push(a.id); } catch (e) { note = (note ? note + " " : "") + `skip ${a.id}: ${e instanceof Error ? e.message : String(e)}`; continue; }
    } else if (a.data) {
      b64 = a.data; if (mime.startsWith("text/")) try { text = Buffer.from(b64, "base64").toString("utf-8"); } catch {} totalBytes += Math.ceil(b64.length * 3 / 4);
    } else continue;
    if (totalBytes > 10 * 1024 * 1024) return { textItems, images, totalBytes, note: "attachments exceed 10MB total — refusing run", ids };
    if (mime.startsWith("image/")) {
      if (images.length >= 5) { note = (note ? note + " " : "") + `image cap 5 reached, skipped ${name}`; continue; }
      images.push({ mime, b64 });
    } else if (mime.startsWith("text/")) {
      textItems.push({ role: "user", content: `[attachment ${name}]\n${text.slice(0, 4000)}` });
    }
  }
  return { textItems, images, totalBytes, note, ids };
}

function isTestApprovalTask(task: string): boolean {
  return task.toLowerCase().includes("approval") || task.toLowerCase().includes("__approval__");
}

// Artifact image handling — mirrors jupyter-vscode-mcp artifact flow
// Base64 lives ONLY at the edge (here), never in tool JSON. Text caps match
// service thresholds (preview 1000, text 8192) handled server-side.
function extractArtifactImages(outText: string): Array<{ mime: string; b64: string }> {
  const images: Array<{ mime: string; b64: string }> = [];
  if (!outText || outText.length < 20) return images;
  try {
    const parsed = JSON.parse(outText) as unknown;
    const visit = (obj: unknown) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) { for (const el of obj) visit(el); return; }
      const rec = obj as Record<string, unknown>;
      if (typeof rec.mime === "string" && typeof rec.artifactPath === "string" && (rec.mime as string).startsWith("image/")) {
        if (images.length >= 5) return;
        const p = rec.artifactPath as string;
        try {
          if (existsSync(p)) {
            const buf = readFileSync(p);
            // guard: ignore empty or huge (>5MB) artifact at edge
            if (buf.length > 0 && buf.length <= 5 * 1024 * 1024) {
              images.push({ mime: rec.mime as string, b64: buf.toString("base64") });
            }
          }
        } catch {}
      }
      for (const v of Object.values(rec)) visit(v);
    };
    visit(parsed);
  } catch {}
  return images;
}

/** Hard cap on model→tool rounds. When hit, the loop stops asking for
 *  tools and requests a plain summary instead — the runaway guard. */
export const MAX_STEPS = 25;

/** Mirrors opencode max-steps.ts: final summary must be text-only, no tools. */
export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`;

const SYSTEM_PROMPT = [
  "You are JupiBuddy, an AI data-science agent inside a live Jupyter notebook.",
  "Be natural and concise: greet briefly, answer directly, and use headers, bullets or code fences only when they help. Never announce your name or role unless asked — just help.",
  "You may only act through the provided notebook tools. For notebook tasks work step by step: inspect data first, write small cells, run them, read outputs and errors, fix your own errors, and finish with a short summary of what the notebook now shows. Never claim a result you did not observe in a tool output. For plain chat (greetings, questions, explanations) just reply — no tools needed.",
  "Prefer parallel independent tool calls in one turn for read-only inspection (e.g. get_summary, get_cell_source, get_outputs, get_status, list_files, read_file, get_variables, get_pip_packages); writes and runs serialize via the single-writer queue.",
  "Avoid repeating the exact same tool call with identical arguments; if an observation repeats, vary arguments or inspect state first.",
].join(" ");

// ---------------------------------------------------------------------------
// Safe tool-args parsing — returns honest error instead of throwing raw
// ---------------------------------------------------------------------------

function safeParseToolArgs(rawArgs: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const str = String(rawArgs ?? "{}");
  if (str.trim() === "") return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(str) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, args: parsed as Record<string, unknown> };
    if (parsed === null || typeof parsed !== "object") return { ok: true, args: {} };
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid tool arguments JSON: ${msg} — raw: ${str.slice(0, 500)}` };
  }
}

interface OutputItem {
  type: string;
  [key: string]: unknown;
}

// Helper to extract text from Responses output items
function extractText(output: OutputItem[]): string {
  return output
    .filter((o) => o.type === "message")
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .map((c) => (typeof (c as Record<string, unknown>).text === "string" ? String((c as Record<string, unknown>).text) : ""))
    .join("");
}

/**
 * Resolve provider selection. Demo default stays Meta (§13). Fail explicit
 * + honest when the selected provider key is missing (no silent fallback).
 */
function getProvider(cfg: JupiConfig, providerName?: string): Provider {
  const name = providerName?.trim() || "Meta";
  return resolveProvider(name);
}

// ---------------------------------------------------------------------------
// Token estimation + context budget (compaction)
// ---------------------------------------------------------------------------

function getContextCeiling(provider: Provider): number {
  const raw = (Bun.env.JUPI_CONTEXT_BUDGET ?? process.env.JUPI_CONTEXT_BUDGET ?? "") as string;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const window = provider.contextWindow;
  if (!window || window <= 0) return Infinity;
  return window - Math.max(Math.floor(window * 0.15), window >= 32000 ? 16000 : 0);
}

function getContextKeepTokens(): number {
  const raw = (Bun.env.JUPI_CONTEXT_KEEP ?? process.env.JUPI_CONTEXT_KEEP ?? "") as string;
  if (!raw) return 15_000;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 15_000;
  // Back-compat: legacy item-count values (< 100) are treated as token estimate (500 tokens/item)
  if (n > 0 && n < 100) return n * 500;
  return n;
}

function isUserTurnItem(it: unknown): boolean {
  if (!it || typeof it !== "object") return false;
  const r = it as Record<string, unknown>;
  return r.role === "user" && !r.type;
}

function estimateTokens(items: unknown[]): number {
  try {
    return Math.ceil(JSON.stringify(items).length / 4);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Auto notebook context (spec §3)
// ---------------------------------------------------------------------------

export interface NotebookContextInfo {
  service?: NotebookService | null;
  // Optional hint from client (active cell index); if null server infers
  activeCellHint?: number | null;
  providerLabel?: string;
  userTask?: string;
}

function collectNotebookContext(info: NotebookContextInfo, provider: Provider): string {
  const service = info.service ?? null;
  const providerLabel = info.providerLabel ?? `${provider.id}/${provider.model}`;
  if (!service || !service.notebook) {
    const ws = service?.workspaceRoot ?? "";
    return `[jupibuddy context]\nactive notebook: (no notebook open)\nworkspace: ${ws}\nprovider: ${providerLabel}\nkernelspec: (no kernel)\nactive cell: (no cell)\nlast error: none`;
  }
  const nbPath = service.notebookPath ?? "(unsaved notebook)";
  const cellCount = service.notebook.cells.length;
  let activeIdx: number | null = null;
  let activeSource: string | null = null;
  let lastError: string | null = null;
  // Explicit cell references via #JB-<id> have priority over automatic active-cell context.
  // If the user task contains one or more #JB- patterns, fetch those cells' sources into context.
  const userTaskForRefs = info.userTask ?? "";
  const explicitIds = [...new Set((userTaskForRefs.match(/#JB-[A-Za-z0-9_-]+/g) ?? []))];
  if (explicitIds.length) {
    const explicitCells = explicitIds
      .map((id) => service.notebook!.cells.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c);
    if (explicitCells.length) {
      const explicitContext = explicitCells
        .map((c) => {
          const idx = service.notebook!.cells.indexOf(c);
          const src = c.source.length > 2000 ? c.source.slice(0, 2000) + "\u2026 [truncated 2000 chars]" : c.source;
          return `Cell ${idx + 1}/${cellCount} ${c.id}: ${src.replace(/\r/g, "")}`;
        })
        .join("\n---\n");
      const kernelspecExplicit = service.notebook.kernelspec?.name ?? (service.kernel as unknown as { selectedSpec?: { name: string } })?.selectedSpec?.name ?? service.kernel?.name ?? "no kernel";
      const wsExplicit = service.workspaceRoot ?? "";
      let lastErrorExplicit: string | null = null;
      for (let i = cellCount - 1; i >= 0; i--) {
        for (const o of service.notebook.cells[i].outputs) {
          if (o.kind === "error") {
            const msg = o.evalue ? `${o.ename}: ${o.evalue}` : o.ename;
            const tb = o.traceback?.join("\n") ?? "";
            const full = tb ? `${msg}\n${tb}` : msg;
            lastErrorExplicit = full.slice(0, 1000);
            break;
          }
        }
        if (lastErrorExplicit) break;
      }
      const errPreviewExplicit = lastErrorExplicit ? lastErrorExplicit.replace(/\n/g, " ").slice(0, 1200) : "none";
      return `[jupibuddy context]\nexplicit cell refs: ${explicitIds.join(", ")}\nactive notebook: ${nbPath}\nexplicit cells:\n${explicitContext}\nlast error: ${errPreviewExplicit}\nkernelspec: ${kernelspecExplicit}\nprovider: ${providerLabel}\nworkspace: ${wsExplicit}`;
    }
  }
  // Find last error output; that cell becomes active if found
  for (let i = cellCount - 1; i >= 0; i--) {
    const c = service.notebook.cells[i];
    for (const o of c.outputs) {
      if (o.kind === "error") {
        if (!lastError) {
          const msg = o.evalue ? `${o.ename}: ${o.evalue}` : o.ename;
          const tb = o.traceback?.join("\n") ?? "";
          const full = tb ? `${msg}\n${tb}` : msg;
          lastError = full.slice(0, 1000);
        }
        if (activeIdx === null) {
          activeIdx = i;
          activeSource = c.source;
        }
        break;
      }
    }
    if (lastError && activeIdx !== null) break;
  }
  // If no error, use hint or default to min(1, cells-1) like frontend
  if (activeIdx === null) {
    const hint = info.activeCellHint;
    if (typeof hint === "number" && hint >= 0 && hint < cellCount) {
      activeIdx = hint;
      activeSource = service.notebook.cells[hint].source;
    } else {
      activeIdx = cellCount ? Math.min(1, cellCount - 1) : null;
      if (activeIdx !== null && activeIdx >= 0) activeSource = service.notebook.cells[activeIdx].source;
    }
  }
  if (activeSource && activeSource.length > 2000) activeSource = activeSource.slice(0, 2000) + "… [truncated 2000 chars]";
  const kernelspec = service.notebook.kernelspec?.name ?? (service.kernel as unknown as { selectedSpec?: { name: string } })?.selectedSpec?.name ?? service.kernel?.name ?? "no kernel";
  const ws = service.workspaceRoot ?? "";
  const cellLabel = activeIdx !== null ? `Cell ${activeIdx + 1}/${cellCount}` : "No cell";
  const srcPreview = activeSource ? activeSource.replace(/\r/g, "").slice(0, 2000) : "(empty)";
  const errPreview = lastError ? lastError.replace(/\n/g, " ").slice(0, 1200) : "none";
  return `[jupibuddy context]\nactive notebook: ${nbPath}\nactive cell ${cellLabel}: ${srcPreview}\nlast error: ${errPreview}\nkernelspec: ${kernelspec}\nprovider: ${providerLabel}\nworkspace: ${ws}`;
}

function buildAutoContextItem(info: NotebookContextInfo, provider: Provider): unknown {
  const text = collectNotebookContext(info, provider);
  return { role: "user", content: text };
}

// ---------------------------------------------------------------------------
// Compaction helpers (spec §2)
// ---------------------------------------------------------------------------

async function cheapSummarize(provider: Provider, headItems: unknown[]): Promise<string | null> {
  // Build a truncated head string for summarization (avoid huge payload)
  let headStr: string;
  try {
    headStr = JSON.stringify(headItems).slice(0, 20000);
  } catch {
    headStr = String(headItems).slice(0, 20000);
  }
  const prompt = `Summarize the following earlier conversation history concisely for context preservation. Focus on key facts, decisions, tool outputs, and errors. Keep under 500 tokens:\n\n${headStr}`;
  try {
    if (provider.protocol === "responses") {
      const res = await callResponses(provider, {
        instructions: "You are a context summarizer. Summarize concisely, preserving key facts.",
        input: [{ role: "user", content: prompt }],
        tools: [],
        maxTokens: 500,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { output?: OutputItem[] };
      const txt = extractText((data.output ?? []) as OutputItem[]);
      return txt?.trim() ? txt.trim().slice(0, 2000) : null;
    } else {
      const res = await callChatCompletions(provider, {
        messages: [
          { role: "system", content: "You are a context summarizer. Summarize concisely, preserving key facts." },
          { role: "user", content: prompt },
        ],
        tools: [],
        maxTokens: 500,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
      const txt = data.choices?.[0]?.message?.content?.trim() ?? "";
      return txt ? txt.slice(0, 2000) : null;
    }
  } catch {
    return null;
  }
}

async function maybeCompact(
  items: unknown[],
  provider: Provider,
  toolDefs: ToolDef[],
): Promise<{ items: unknown[]; compacted: boolean; turnsDropped: number }> {
  const ceiling = getContextCeiling(provider);
  const keepTokens = getContextKeepTokens();
  const est = estimateTokens(items);
  if (est <= ceiling) return { items, compacted: false, turnsDropped: 0 };
  // Need compaction: build tail by token budget
  let tailTokens = 0;
  let tailStartIdx = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const tok = estimateTokens([items[i]]);
    if (tailTokens + tok > keepTokens && tailStartIdx < items.length) break;
    tailTokens += tok;
    tailStartIdx = i;
    if (tailTokens >= keepTokens) break;
  }
  if (tailStartIdx >= items.length) tailStartIdx = Math.max(0, items.length - 1);
  // Snap boundary to a user turn so call/result pairs stay together
  let snapIdx = tailStartIdx;
  for (let i = tailStartIdx; i >= 0; i--) {
    if (isUserTurnItem(items[i])) {
      snapIdx = i;
      break;
    }
    if (i === 0) break;
  }
  // Ensure last complete call/result pair is not cut: if snap lands on output, walk back to include its call(s)
  if (snapIdx > 0) {
    const first = items[snapIdx] as Record<string, unknown> | undefined;
    if (first?.type === "function_call_output") {
      for (let i = snapIdx - 1; i >= 0; i--) {
        const it = items[i] as Record<string, unknown>;
        if (!it) continue;
        if (it.type === "function_call") {
          // Snap further to the user turn before this call group to keep turn atomic
          let userSnap = i;
          for (let j = i; j >= 0; j--) {
            if (isUserTurnItem(items[j])) { userSnap = j; break; }
            if (j === 0) break;
          }
          snapIdx = userSnap;
          break;
        } else if (it.type === "function_call_output") {
          snapIdx = i;
          continue;
        } else if (it.type === "message" || isUserTurnItem(it)) {
          break;
        }
      }
    }
  }
  // Guard against too-large tail after snap: if still over ceiling, fall back to token-budget tail
  let tail = items.slice(snapIdx);
  let tailEst = estimateTokens(tail);
  if (tailEst > keepTokens * 1.5) {
    // Snap caused bloat; revert to strict token tail
    tail = items.slice(tailStartIdx);
    snapIdx = tailStartIdx;
  }
  const head = items.slice(0, snapIdx);
  const turnsDropped = head.length;
  if (!head.length) {
    // Not enough to summarize meaningfully — still flag compacted for caller bookkeeping
    return { items: tail, compacted: true, turnsDropped: 0 };
  }
  const summary = await cheapSummarize(provider, head);
  if (summary) {
    const compactItem = { role: "user", content: `[context compacted: ${summary}]` };
    return { items: [compactItem, ...tail], compacted: true, turnsDropped };
  }
  // Fallback: plain truncation (drop oldest non-system items) — never crash
  return { items: tail, compacted: true, turnsDropped };
}

// ---------------------------------------------------------------------------
// Unified turn caller: Responses primary, Chat fallback (non-streaming)
// ---------------------------------------------------------------------------

async function callModelTurn(
  provider: Provider,
  items: unknown[],
  toolDefs: ToolDef[],
  finalStep: boolean,
  promptCacheKey?: string,
  effort?: string,
  signal?: AbortSignal | null,
): Promise<{ output: OutputItem[]; rawModel?: string; usage?: Usage | null }> {
  const responseTools = toResponsesTools(toolDefs);
  const chatTools = toChatTools(toolDefs);
  const effectiveItems: unknown[] = finalStep
    ? [...items, { role: "user", content: MAX_STEPS_PROMPT }]
    : items;

  if (provider.protocol === "responses") {
    let res: Response | undefined;
    try {
      res = await callResponses(
        provider,
        {
          instructions: SYSTEM_PROMPT,
          input: effectiveItems,
          tools: finalStep ? [] : (responseTools as unknown[]),
          ...(promptCacheKey ? { promptCacheKey } : {}),
          ...(effort ? { effort: effort as import("./providers").EffortLevel } : {}),
        },
        signal ?? undefined,
      );
      if (res.ok) {
        const data = (await res.json()) as { output?: OutputItem[]; model?: string; usage?: unknown };
        return { output: data.output ?? [], rawModel: data.model, usage: extractUsage(data) };
      }
      if (res && (res.status === 404 || res.status === 405)) {
        // fall through to chat
      } else if (res && !res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Model call failed (HTTP ${res.status}) at provider ${provider.id}: ${body.slice(0, 500)}`);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // Non-404/405 will be handled by fallback; rethrow if it's a hard failure
      if (res && res.ok === false && res.status !== 404 && res.status !== 405) {
        throw e;
      }
      // For 404/405, fall through — ensure res is undefined to trigger fallback
      if (res && (res.status === 404 || res.status === 405)) {
        // fall through
      } else if (!res) {
        // Network error already retried inside provider; fall through to chat and let it try
      }
    }
    if (res?.ok === true) {
      // already returned
    } else if (res && res.status !== 404 && res.status !== 405 && !res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Model call failed (HTTP ${res.status}) at provider ${provider.id}: ${body.slice(0, 500)}`);
    }
    if (res && (res.status === 404 || res.status === 405)) {
      // fall through
    } else if (res && !res.ok) {
      // already thrown
    }
  }

  const messages = responsesItemsToChatMessages(effectiveItems, SYSTEM_PROMPT);
  const chatRes = await callChatCompletions(
    provider,
    {
      messages,
      tools: finalStep ? [] : (chatTools as unknown[]),
    },
    signal ?? undefined,
  );
  if (!chatRes?.ok) {
    const body = await chatRes.text().catch(() => "");
    throw new Error(`Model call failed (HTTP ${chatRes.status}) at provider ${provider.id}: ${body.slice(0, 500)}`);
  }
  const chatData = (await chatRes.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    model?: string;
    id?: string;
    usage?: unknown;
  };
  const output = chatResponseToResponsesItems(chatData as Parameters<typeof chatResponseToResponsesItems>[0]) as OutputItem[];
  return { output, rawModel: chatData.model, usage: extractUsage(chatData) };
}

// ---------------------------------------------------------------------------
// Streaming turn caller — emits text-delta live, reuses existing helpers
// ---------------------------------------------------------------------------

async function callModelTurnStreaming(
  provider: Provider,
  items: unknown[],
  toolDefs: ToolDef[],
  finalStep: boolean,
  onDelta?: (text: string) => void,
  promptCacheKey?: string,
  effort?: string,
  signal?: AbortSignal | null,
): Promise<{ output: OutputItem[]; rawModel?: string; usage?: Usage | null }> {
  const responseTools = toResponsesTools(toolDefs);
  const chatTools = toChatTools(toolDefs);
  let effectiveItems: unknown[] = finalStep
    ? [...items, { role: "user", content: MAX_STEPS_PROMPT }]
    : items;

  // Try Responses streaming first if provider prefers it — with bounded continue on incomplete
  if (provider.protocol === "responses") {
    let continuations = 0;
    const MAX_CONTINUATIONS = 2;
    let aggregatedOutput: OutputItem[] = [];
    let aggregatedUsage: Usage | null = null;
    let aggregatedModel: string | undefined;
    let currentInput = effectiveItems;
    while (true) {
      let res: Response | undefined;
      try {
        res = await callResponses(
          provider,
          {
            instructions: SYSTEM_PROMPT,
            input: currentInput,
            tools: finalStep ? [] : (responseTools as unknown[]),
            stream: true,
            ...(promptCacheKey ? { promptCacheKey } : {}),
            ...(effort ? { effort: effort as import("./providers").EffortLevel } : {}),
          },
          signal ?? undefined,
        );
        if (!res.ok && (res.status === 404 || res.status === 405)) {
          res = undefined;
          break;
        }
        if (!res?.ok) {
          const body = res ? await res.text().catch(() => "") : "no response";
          throw new Error(`Model call failed (HTTP ${res?.status ?? "?"}) at provider ${provider.id}: ${body.slice(0, 500)}`);
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        // 404/405 already handled; rethrow other errors to chat fallback
        if (res && (res.status === 404 || res.status === 405)) break;
        throw e;
      }
      if (!res?.ok) break;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("text/event-stream") || ct.includes("event-stream")) {
        const body = res.body as ReadableStream<Uint8Array> | null;
        if (body) {
          const acc = await accumulateResponsesStreamWithEmit(body, onDelta);
          // Merge output and usage
          if (acc.output.length) aggregatedOutput.push(...(acc.output as OutputItem[]));
          else if (acc.text) {
            aggregatedOutput.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: acc.text }] } as unknown as OutputItem);
          }
          if (acc.usage) {
            const u = extractUsage({ usage: acc.usage });
            if (u) aggregatedUsage = u;
            else if (acc.usage && typeof acc.usage === "object") {
              const maybeNested = (acc.usage as Record<string, unknown>).response as unknown;
              if (maybeNested) {
                const nu = extractUsage({ usage: (maybeNested as Record<string, unknown>).usage });
                if (nu) aggregatedUsage = nu;
              }
            }
          }
          if ((acc as unknown as { model?: string }).model) aggregatedModel = (acc as unknown as { model?: string }).model;
          // Handle incomplete/failed semantics from Responses stream
          if (acc.status === "failed") {
            throw new Error(`Model stream failed: ${acc.error ?? "unknown"}`);
          }
          if (acc.status === "incomplete" && continuations < MAX_CONTINUATIONS) {
            continuations++;
            // Continue with accumulated output as context
            currentInput = [...currentInput, ...(acc.output as unknown[])];
            if (onDelta) onDelta("\n[continuing truncated response...]\n");
            continue;
          }
          return {
            output: aggregatedOutput.length ? aggregatedOutput : (acc.output as OutputItem[]),
            rawModel: aggregatedModel ?? (acc as unknown as { model?: string }).model,
            usage: aggregatedUsage ?? extractUsage({ usage: (acc as unknown as { usage?: unknown }).usage }),
          };
        }
      }
      // Fallback: not actually streaming, parse as JSON — check for incomplete
      try {
        const data = (await res.json()) as { output?: OutputItem[]; model?: string; usage?: unknown; status?: string; incomplete_details?: unknown };
        const txt = extractText((data.output ?? []) as OutputItem[]);
        if (txt && onDelta) onDelta(txt);
        // Detect incomplete in non-stream JSON
        if ((data as Record<string, unknown>).status === "incomplete" && continuations < MAX_CONTINUATIONS) {
          continuations++;
          aggregatedOutput.push(...((data.output ?? []) as OutputItem[]));
          currentInput = [...currentInput, ...((data.output ?? []) as unknown[])];
          if (onDelta) onDelta("\n[continuing truncated response...]\n");
          continue;
        }
        const combined = aggregatedOutput.length ? [...aggregatedOutput, ...((data.output ?? []) as OutputItem[])] : ((data.output ?? []) as OutputItem[]);
        return { output: combined, rawModel: aggregatedModel ?? data.model, usage: aggregatedUsage ?? extractUsage(data) };
      } catch {
        // if json parse fails, fall through to chat
        break;
      }
    }
    // If we broke out due to 404/405, fall through to chat
  }

  // Chat streaming path (primary for Custom, 404/405 fallback for Meta+Baseten)
  const messages = responsesItemsToChatMessages(effectiveItems, SYSTEM_PROMPT);
  const chatRes = await callChatCompletions(
    provider,
    {
      messages,
      tools: finalStep ? [] : (chatTools as unknown[]),
      stream: true,
    },
    signal ?? undefined,
  );
  if (!chatRes?.ok) {
    const body = await chatRes.text().catch(() => "") ;
    throw new Error(`Model call failed (HTTP ${chatRes.status}) at provider ${provider.id}: ${body.slice(0, 500)}`);
  }
  const ct2 = chatRes.headers.get("content-type") ?? "";
  if (ct2.includes("text/event-stream") || ct2.includes("event-stream")) {
    const body = chatRes.body as ReadableStream<Uint8Array> | null;
    if (body) {
      const acc = await accumulateChatStreamWithEmit(body, onDelta);
      const output: OutputItem[] = [];
      if (acc.content) {
        output.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: acc.content }],
        });
      }
      for (const tc of acc.toolCalls) {
        output.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
      // Usage may be in acc.usage (from response.completed)
      const usage = acc.usage ? extractUsage({ usage: acc.usage }) : undefined;
      return { output, rawModel: undefined, usage: usage ?? undefined };
    }
  }
  // Non-streaming JSON fallback
  const chatData = (await chatRes.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    model?: string;
    id?: string;
    usage?: unknown;
  };
  const out = chatResponseToResponsesItems(chatData as Parameters<typeof chatResponseToResponsesItems>[0]) as OutputItem[];
  const txt2 = extractText(out);
  if (txt2 && onDelta) onDelta(txt2);
  return { output: out, rawModel: chatData.model, usage: extractUsage(chatData) };
}

// ---------------------------------------------------------------------------
// Core loop shared by streaming + non-streaming
// ---------------------------------------------------------------------------

async function runAgentCore(
  cfg: JupiConfig,
  tools: ToolDef[],
  userTask: string,
  providerName: string | undefined,
  ctxInfo: NotebookContextInfo | undefined,
  emit: ((evt: Record<string, unknown>) => void) | undefined,
  supervision?: SupervisionOpts,
  history?: ContinuationHistory,
): Promise<AgentRunResult> {
  const startTime = Date.now();
  const transcript = supervision?.transcript ?? null;
  // Honest usage aggregation — zeros until provider returns usage with cache fields
  let aggregatedUsage: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const mergeUsage = (u: Usage | null | undefined): void => {
    if (!u) return;
    aggregatedUsage.input += u.input;
    aggregatedUsage.output += u.output;
    aggregatedUsage.reasoning += u.reasoning;
    aggregatedUsage.cacheRead += u.cacheRead;
    aggregatedUsage.cacheWrite += u.cacheWrite;
  };
  // Helper to write transcript system/summary without crashing run
  const writeTranscriptSummary = (result: AgentRunResult) => {
    if (!transcript || transcript.isDisabled) return;
    try {
      const effects = transcript.currentEffects;
      // If provider returned usage (incl. cacheRead/cacheWrite), use it; else honest zeros
      const usage =
        aggregatedUsage.input || aggregatedUsage.output || aggregatedUsage.cacheRead || aggregatedUsage.cacheWrite || aggregatedUsage.reasoning
          ? { ...aggregatedUsage }
          : { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
      transcript.appendSummary({
        ok: result.ok,
        steps: result.steps,
        time: Date.now() - startTime,
        summary: result.summary,
        compacted: result.compacted,
        turnsDropped: result.turnsDropped,
        cancelled: result.cancelled,
        steered: result.steered,
        approvals: result.approvals,
        stuck: result.stuck,
        attachmentIds: (supervision?.attachments ?? []).filter((a) => typeof a.id === "string").map((a) => a.id as string),
        usage,
        effects,
        ...(supervision?.effort ? { effort: supervision.effort } : {}),
      });
    } catch (e) {
      console.warn(`[transcript] summary write failed:`, e instanceof Error ? e.message : String(e));
    }
  };
  const flushCancelAndSummarize = (result: AgentRunResult, reason?: string): AgentRunResult => {
    if (transcript && !transcript.isDisabled) {
      try {
        transcript.appendSystem("cancel", { reason: reason ?? result.summary, step: result.steps });
      } catch (e) {
        console.warn(`[transcript] cancel write failed:`, e instanceof Error ? e.message : String(e));
      }
    }
    writeTranscriptSummary(result);
    return result;
  };

  let provider: Provider;
  try {
    provider = getProvider(cfg, providerName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const res: AgentRunResult = { ok: false, steps: 0, summary: msg, provider: providerName ?? "Meta" };
    writeTranscriptSummary(res);
    return res;
  }

  const att = await resolveAttachments(supervision?.attachments, supervision?.service ?? ctxInfo?.service);
  if (att.note && (att.note.includes("exceed 10MB") || att.note.includes("too many attachments"))) {
    const res: AgentRunResult = { ok: false, steps: 0, summary: att.note, provider: provider.id, model: provider.model };
    writeTranscriptSummary(res);
    return res;
  }
  let attachNote = att.note && !att.note.includes("skip") ? att.note : undefined;
  if (att.note && att.note.includes("cap")) attachNote = att.note;
  // Stable prefix order for implicit prefix caching (Baseten + Meta):
  // 1) SYSTEM_PROMPT (instructions) + tool definitions — constant per run (providers.ts:242 / loop.ts:360)
  // 2) conversation history (history.items) — monotonically growing, never reordered
  // 3) newest task + attachments + auto-context at tail — volatile bits isolated
  // Verified: items[] assembly loop.ts:632-645 satisfies this; auto-context is frozen
  // once at run start (collectNotebookContext snapshot) so cellCount/activeCell
  // mutations mid-run do not churn the prefix. Across continued runs, history
  // already contains the prior auto-context snapshot; only the new tail diverges.
  let historyLen = 0;
  let items: unknown[] = [];
  if (history?.items?.length) {
    items.push(...history.items);
    historyLen = history.items.length;
  }
  items.push({ role: "user", content: userTask });
  for (const ti of att.textItems) items.push(ti);
  if (att.images.length) {
    const taskItem = items[historyLen] as Record<string, unknown>;
    if (taskItem) taskItem.content = [{ type: "input_text", text: userTask }, ...att.images.map((im) => ({ type: "input_image", image_url: `data:${im.mime};base64,${im.b64}` }))];
  }
  if (ctxInfo?.service) {
    const ctxWithTask: NotebookContextInfo = { ...ctxInfo, userTask };
    items.push(buildAutoContextItem(ctxWithTask, provider));
  }
  if (history?.sessionId && transcript && !transcript.isDisabled) {
    try { transcript.appendSystem("continuedFrom", { continuedFrom: history.sessionId }); } catch {}
  }
  const withNote = (s: string) => attachNote ? `${s}\n[${attachNote}]` : s;

  // Transcript: opening user line (task + attachment ids as attachment blocks if present)
  if (transcript && !transcript.isDisabled) {
    try {
      const blocks: unknown[] = [{ type: "text", text: userTask }];
      for (const id of att.ids) blocks.push({ type: "attachment", id });
      transcript.appendUser(blocks);
    } catch {}
  }

  let lastText = "";
  let totalTurnsDropped = 0;
  let didCompact = false;
  // doom-loop guard: track last 3 executed tool calls
  const doomHistory: Array<{ name: string; argsJson: string; argsPreview: string }> = [];
  let lastToolResultText = "";
  let doomStrikes = 0;
  let doomStrikeTool = "";
  let modelRetryDone = false;
  // A1-8: empty-turn guard — never count empty output as success
  let emptyTurnRetries = 0;
  const MAX_EMPTY_RETRIES = 2;
  // Stable cache key for Meta Responses — per SESSION, clamped 64 chars, omitted when caching disabled
  const getPromptCacheKey = (): string | undefined => {
    const cachingOff =
      (Bun.env.JUPI_PROMPT_CACHE ?? process.env.JUPI_PROMPT_CACHE ?? "") === "0" ||
      (Bun.env.JUPI_CACHE_ENABLED ?? process.env.JUPI_CACHE_ENABLED ?? "") === "0" ||
      (Bun.env.JUPI_PROMPT_CACHE_ENABLED ?? process.env.JUPI_PROMPT_CACHE_ENABLED ?? "") === "0";
    if (cachingOff) return undefined;
    const raw = history?.sessionId ?? supervision?.runId ?? undefined;
    if (!raw) return undefined;
    // Clamp to 64 chars per shared.ts:95-96
    return raw.slice(0, 64);
  };
  const promptCacheKey: string | undefined = getPromptCacheKey();

  // Helpers for transcript per-turn writes
  const buildAssistantBlocks = (text: string, calls: OutputItem[]): unknown[] => {
    const blocks: unknown[] = [];
    if (text) blocks.push({ type: "text", text });
    for (const c of calls) {
      const parsed = safeParseToolArgs(c.arguments);
      const input = parsed.ok ? parsed.args : {};
      blocks.push({ type: "tool_call", id: String(c.call_id ?? c.id ?? `call-${blocks.length}`), name: String(c.name ?? ""), input });
    }
    return blocks;
  };
  const truncatedToolResult = (s: string): string => s.slice(0, 2000);

  // Final-answer helper: every failed run must still produce readable answer text.
  // (a) Composes concise answer from lastText + cause + observation + next step.
  // (b) Emits as text-delta (frontend sendChat accumulates text-delta into visible message).
  // (c) Appends assistant transcript line (guarded).
  // (d) Sets summary = answer and calls writeTranscriptSummary before returning.
  const composeFailureAnswer = (cause: string): string => {
    const parts: string[] = [];
    if (lastText && lastText.trim()) parts.push(lastText.trim().slice(0, 2000));
    // One-line cause — cap and flatten to avoid dumping raw server blobs.
    const causeLine = cause.replace(/\s+/g, " ").trim().slice(0, 200);
    if (causeLine) parts.push(causeLine);
    // One-line capped observation (no multi-hundred-char blobs).
    const obsRaw = (lastToolResultText || "").trim().replace(/\s+/g, " ");
    if (obsRaw) parts.push("Seen: " + obsRaw.slice(0, 200));
    // Short next-step line.
    parts.push("Try: rephrase, check notebook state, or list files.");
    return parts.join("\n\n");
  };
  const finishFailure = (
    r: AgentRunResult,
    cause: string,
  ): AgentRunResult => {
    // Log full detail server-side; user sees only the capped SIMPLE output.
    try { console.error("[loop] failure:", cause); } catch {}
    const answer = composeFailureAnswer(cause);
    if (emit) {
      try { emit({ type: "text-delta", text: answer }); } catch {}
    }
    if (transcript && !transcript.isDisabled) {
      try {
        transcript.appendAssistant({ model: r.model ?? provider.model, blocks: [{ type: "text", text: answer }] });
      } catch {}
    }
    r.summary = answer;
    writeTranscriptSummary(r);
    return r;
  };

  // --- test-fake fast path: deterministic steps with cancellable sleeps (no model needed) ---
  // Enabled only by JUPI_TEST_FAKE_STEPS=1 (cfg.testFakeSteps) — never derived from task
  // text, so a real task that merely mentions "slow" and "run" still reaches the model.
  if (cfg.testFakeSteps) {
    const svc = supervision?.service ?? ctxInfo?.service ?? null;
    const signal = supervision?.signal ?? null;
    const requireApproval = !!supervision?.requireApproval;
    const isApprovalProbe = isTestApprovalTask(userTask) || requireApproval;
    for (let step = 1; step <= 4; step++) {
      if (signal?.aborted) {
        const r: AgentRunResult = { ok: false, steps: step - 1, summary: `cancelled by user at step ${step - 1}`, provider: provider.id, model: provider.model, cancelled: true, steered: !!svc?.steeredFlag, approvals: svc?.currentApprovals ?? [], streamed: !!emit };
        return flushCancelAndSummarize(r, "cancelled at test-slow step");
      }
      // handle steered tasks: fold into context
      if (svc && svc.steerBuffer.length) {
        const toFold = svc.steerBuffer.splice(0);
        for (const t of toFold) {
          items.push({ role: "user", content: `[steered] ${t}` });
          if (emit) emit({ type: "steered", task: t });
        }
        if (transcript && !transcript.isDisabled) {
          try {
            transcript.appendSystem("steer", { tasks: toFold, step });
            for (const t of toFold) transcript.appendUser([{ type: "text", text: `[steered] ${t}` }]);
          } catch {}
        }
      }
      if (emit) emit({ type: "step", n: step });
      // step 1: insert cell
      if (step === 1) {
        if (emit) emit({ type: "tool-call", name: "insert_cell", argsPreview: JSON.stringify({ type: "code", source: `print("slow step ${step}")` }).slice(0, 200) });
        // transcript assistant for this tool step
        if (transcript && !transcript.isDisabled) {
          try {
            const blocks = [{ type: "tool_call", id: `test-${step}-a`, name: "insert_cell", input: { type: "code", source: `print("slow step ${step}")` } }];
            transcript.appendAssistant({ model: provider.model, blocks });
          } catch {}
        }
        if (svc?.notebook) {
          try {
            await svc.withWriter("internal-agent", async () => {
              svc.insertCell(undefined, "code", `# slow test step ${step} for ${userTask.slice(0, 30)}`, "internal-agent");
            });
          } catch {}
        } else {
          await callTool(tools, "insert_cell", { type: "code", source: `print("slow step ${step}")` } as unknown as Record<string, never>);
        }
        if (emit) emit({ type: "tool-result", name: "insert_cell", ok: true, summary: `inserted step ${step}` });
        items.push({ type: "function_call_output", call_id: `test-${step}-a`, output: `inserted step ${step}` });
        if (transcript && !transcript.isDisabled) {
          try { transcript.appendUser([{ type: "tool_result", tool_use_id: `test-${step}-a`, content: truncatedToolResult(`inserted step ${step}`) }]); } catch {}
        }
      } else if (step === 2) {
        if (emit) emit({ type: "tool-call", name: "edit_cell", argsPreview: JSON.stringify({ step }).slice(0, 200) });
        if (transcript && !transcript.isDisabled) {
          try {
            const blocks = [{ type: "tool_call", id: `test-${step}-a`, name: "edit_cell", input: { cellId: "target", source: `# edited in step ${step}` } }];
            transcript.appendAssistant({ model: provider.model, blocks });
          } catch {}
        }
        if (svc?.notebook) {
          const target = userTask.toLowerCase().includes("undo") && svc.notebook.cells.length > 0 ? svc.notebook.cells[0] : svc.notebook.cells[svc.notebook.cells.length - 1];
          if (target) {
            try {
              await svc.withWriter("internal-agent", async () => {
                svc.editCell(target.id, `# edited in step ${step} undotest ${Date.now()}`, "internal-agent");
              });
            } catch {}
          }
        }
        if (emit) emit({ type: "tool-result", name: "edit_cell", ok: true, summary: `edited step ${step}` });
        items.push({ type: "function_call_output", call_id: `test-${step}-a`, output: `edited step ${step}` });
        if (transcript && !transcript.isDisabled) {
          try { transcript.appendUser([{ type: "tool_result", tool_use_id: `test-${step}-a`, content: truncatedToolResult(`edited step ${step}`) }]); } catch {}
        }
      } else if (step === 3 && isApprovalProbe) {
        const tool = "write_file";
        const argsPreview = JSON.stringify({ path: "test_approval.txt", content: "hello" }).slice(0, 500);
        if (emit) emit({ type: "tool-call", name: tool, argsPreview });
        if (transcript && !transcript.isDisabled) {
          try {
            const blocks = [{ type: "tool_call", id: `test-${step}`, name: tool, input: { path: "test_approval.txt", content: "hello" } }];
            transcript.appendAssistant({ model: provider.model, blocks });
          } catch {}
        }
        if (requireApproval && svc && supervision?.runId) {
          if (emit) emit({ type: "approval-needed", tool, argsPreview, runId: supervision.runId });
          const decision = await svc.waitForApproval(supervision.runId, tool, argsPreview);
          if (transcript && !transcript.isDisabled) {
            try { transcript.appendSystem("approval", { tool, decision, argsPreview }); } catch {}
          }
          if (decision === "deny") {
            const deniedMsg = `${tool} denied by user`;
            items.push({ type: "function_call_output", call_id: `test-${step}-deny`, output: deniedMsg });
            if (emit) emit({ type: "tool-result", name: tool, ok: false, summary: deniedMsg });
            if (transcript && !transcript.isDisabled) {
              try { transcript.appendUser([{ type: "tool_result", tool_use_id: `test-${step}`, content: truncatedToolResult(deniedMsg), isError: true }]); } catch {}
            }
            continue;
          } else {
            await callTool(tools, tool, { path: "test_approval.txt", content: "hello" } as unknown as Record<string, never>);
            items.push({ type: "function_call_output", call_id: `test-${step}-ok`, output: `wrote test_approval.txt` });
            if (emit) emit({ type: "tool-result", name: tool, ok: true, summary: "wrote test_approval.txt" });
            if (transcript && !transcript.isDisabled) {
              try { transcript.appendUser([{ type: "tool_result", tool_use_id: `test-${step}`, content: truncatedToolResult(`wrote test_approval.txt`) }]); } catch {}
            }
          }
        } else {
          const r = await callTool(tools, tool, { path: "test_approval.txt", content: "hello" } as unknown as Record<string, never>);
          const outText = r.content.map((c) => c.text).join("\n");
          items.push({ type: "function_call_output", call_id: `test-${step}`, output: outText });
          if (emit) emit({ type: "tool-result", name: tool, ok: !r.isError, summary: outText.slice(0, 500) });
          if (transcript && !transcript.isDisabled) {
            try { transcript.appendUser([{ type: "tool_result", tool_use_id: `test-${step}`, content: truncatedToolResult(outText), isError: !!r.isError }]); } catch {}
          }
        }
      } else if (step === 3) {
        if (emit) emit({ type: "tool-call", name: "get_status", argsPreview: "{}" });
        if (transcript && !transcript.isDisabled) {
          try {
            const blocks = [{ type: "tool_call", id: `test-${step}`, name: "get_status", input: {} }];
            transcript.appendAssistant({ model: provider.model, blocks });
          } catch {}
        }
        await callTool(tools, "get_status", {} as Record<string, never>);
        if (emit) emit({ type: "tool-result", name: "get_status", ok: true, summary: "ok" });
        items.push({ type: "function_call_output", call_id: `test-${step}`, output: "status ok" });
        if (transcript && !transcript.isDisabled) {
          try { transcript.appendUser([{ type: "tool_result", tool_use_id: `test-${step}`, content: truncatedToolResult("status ok") }]); } catch {}
        }
      } else if (step === 4) {
        lastText = `Slow test done after ${step} steps. Task was: ${userTask.slice(0, 80)}` + (svc?.steeredFlag ? " (steered context applied)" : "");
        if (emit) { emit({ type: "text-delta", text: lastText }); }
        if (transcript && !transcript.isDisabled) {
          try { transcript.appendAssistant({ model: provider.model, blocks: [{ type: "text", text: lastText }] }); } catch {}
        }
        break;
      }
      for (let s = 0; s < 8; s++) {
        if (signal?.aborted) break;
        await Bun.sleep(100);
      }
      if (signal?.aborted) {
        const r: AgentRunResult = { ok: false, steps: step, summary: `cancelled by user at step ${step}`, provider: provider.id, model: provider.model, cancelled: true, steered: !!svc?.steeredFlag, approvals: svc?.currentApprovals ?? [], streamed: !!emit };
        return flushCancelAndSummarize(r, "cancelled at test-slow step sleep");
      }
      lastText = `step ${step} done`;
    }
    const finalRes: AgentRunResult = {
      ok: true,
      steps: 4,
      summary: lastText + (supervision?.service?.steeredFlag ? " (steered)" : ""),
      provider: provider.id,
      model: provider.model,
      compacted: didCompact || undefined,
      turnsDropped: totalTurnsDropped || undefined,
      streamed: !!emit,
      cancelled: false,
      steered: !!supervision?.service?.steeredFlag,
      approvals: supervision?.service?.currentApprovals ?? [],
    };
    writeTranscriptSummary(finalRes);
    return finalRes;
  }

  // Safety net: unexpected throws inside step loop must still produce readable answer
  try {
  for (let step = 1; step <= MAX_STEPS; step++) {
    if (supervision?.signal?.aborted) {
      const r: AgentRunResult = { ok: false, steps: step - 1, summary: `cancelled by user at step ${step - 1}`, provider: provider.id, model: provider.model, cancelled: true, steered: !!supervision?.service?.steeredFlag, approvals: supervision?.service?.currentApprovals ?? [], streamed: !!emit };
      return flushCancelAndSummarize(r, "cancelled at step boundary");
    }
    if (supervision?.service && supervision.service.steerBuffer.length) {
      const toFold = supervision.service.steerBuffer.splice(0);
      for (const t of toFold) {
        items.push({ role: "user", content: `[steered task] ${t}` });
        if (emit) emit({ type: "steered", task: t });
      }
      supervision.service.steeredFlag = true;
      lastText += toFold.map((t) => ` [steered:${t.slice(0, 40)}]`).join("");
      if (transcript && !transcript.isDisabled) {
        try {
          transcript.appendSystem("steer", { tasks: toFold, step });
          for (const t of toFold) transcript.appendUser([{ type: "text", text: `[steered] ${t}` }]);
        } catch {}
      }
    }
    const finalStep = step === MAX_STEPS;
    const compaction = await maybeCompact(items, provider, tools);
    if (compaction.compacted) {
      items = compaction.items;
      didCompact = true;
      totalTurnsDropped += compaction.turnsDropped;
      if (transcript && !transcript.isDisabled) {
        try {
          const leafUuid = transcript.lastLineUuid;
          transcript.appendSystem("compact", { leafUuid, turnsDropped: compaction.turnsDropped, step });
        } catch {}
      }
    }

    if (emit) emit({ type: "step", n: step });

    let output: OutputItem[] = [];
    let rawModel: string | undefined;
    try {
      const eff = supervision?.effort ?? undefined;
      if (emit) {
        const turn = await callModelTurnStreaming(
          provider,
          items,
          tools,
          finalStep,
          (chunk) => {
            if (chunk) emit({ type: "text-delta", text: chunk });
          },
          promptCacheKey,
          eff,
          supervision?.signal ?? null,
        );
        output = turn.output;
        rawModel = turn.rawModel;
        mergeUsage(turn.usage);
      } else {
        const turn = await callModelTurn(provider, items, tools, finalStep, promptCacheKey, eff, supervision?.signal ?? null);
        output = turn.output;
        rawModel = turn.rawModel;
        mergeUsage(turn.usage);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /HTTP\s+(429|500|502|503|504)/.test(msg) || /network|timeout|fetch|ECONN|ETIMEDOUT/i.test(msg);
      const isAuthOrDenied = /HTTP\s+(401|403|404|405)/.test(msg) || /denied/i.test(msg);
      if (retryable && !isAuthOrDenied && !modelRetryDone) {
        modelRetryDone = true;
        if (transcript && !transcript.isDisabled) {
          try { transcript.appendSystem("model_retry", { message: msg.slice(0, 500), step }); } catch {}
        }
        if (emit) emit({ type: "model-retry", message: msg.slice(0, 200), step });
        await Bun.sleep(1200);
        step--;
        continue;
      }
      const r: AgentRunResult = {
        ok: false,
        steps: step,
        summary: msg,
        provider: provider.id,
        model: rawModel ?? provider.model,
        compacted: didCompact || undefined,
        turnsDropped: totalTurnsDropped || undefined,
        streamed: !!emit,
      };
      if (transcript && !transcript.isDisabled) {
        try { transcript.appendSystem("error", { message: msg, step }); } catch {}
      }
      return finishFailure(r, "The model did not respond: " + msg.slice(0, 500));
    }

    if (supervision?.signal?.aborted) {
      const r: AgentRunResult = { ok: false, steps: step, summary: `cancelled by user at step ${step}`, provider: provider.id, model: rawModel ?? provider.model, cancelled: true, steered: !!supervision?.service?.steeredFlag, approvals: supervision?.service?.currentApprovals ?? [], streamed: !!emit };
      return flushCancelAndSummarize(r, "cancelled after model turn");
    }

    items.push(...output);

    // Globally unique call_id normalization — prevents duplicate function_call_output
    // across turns when the model omits or reuses ids (Meta 400 otherwise).
    // We mutate the call objects in place; output was pushed into items by reference
    // so the replay `function_call` entries in items stay consistent with outputs.
    if (output.some((o) => o.type === "function_call")) {
      const tailStart = items.length - output.length;
      const seenIds = new Set<string>();
      for (let i = 0; i < tailStart; i++) {
        const r = items[i] as Record<string, unknown>;
        const id = typeof r.call_id === "string" ? r.call_id : typeof r.id === "string" ? r.id : "";
        if (r.type === "function_call" || r.type === "function_call_output") {
          if (id) seenIds.add(String(id));
        }
      }
      const turnSeen = new Set<string>();
      for (let ti = tailStart; ti < items.length; ti++) {
        const it = items[ti] as Record<string, unknown>;
        if (it.type !== "function_call") continue;
        const raw = typeof it.call_id === "string" ? String(it.call_id).trim() : typeof it.id === "string" ? String(it.id).trim() : "";
        let effective = raw;
        const collidesGlobal = effective !== "" && seenIds.has(effective);
        const collidesTurn = effective !== "" && turnSeen.has(effective);
        if (!effective || collidesGlobal || collidesTurn) {
          let n = 0;
          do { effective = `call-${step}-${ti - tailStart + n}`; n++; } while (seenIds.has(effective) || turnSeen.has(effective));
        }
        if ((it as Record<string, unknown>).call_id !== effective) (it as Record<string, unknown>).call_id = effective;
        seenIds.add(effective);
        turnSeen.add(effective);
      }
    }

    const calls = output.filter((o) => o.type === "function_call");
    const text = extractText(output);
    if (text) lastText = text;

    // Transcript: assistant line for this turn (text + tool_calls)
    if (transcript && !transcript.isDisabled) {
      try {
        if (text || calls.length > 0) {
          const blocks = buildAssistantBlocks(text, calls as OutputItem[]);
          transcript.appendAssistant({ model: rawModel ?? provider.model, blocks });
        }
      } catch {}
    }

    // A1-8: empty turn is retryable, never ok:true with zero assistant lines
    const isEmptyTurn = !text.trim() && calls.length === 0;
    if (isEmptyTurn) {
      console.warn(`[loop] empty turn at step ${step}, retrying (${emptyTurnRetries + 1}/${MAX_EMPTY_RETRIES})`);
      if (transcript && !transcript.isDisabled) {
        try { transcript.appendSystem("empty_turn", { step, retry: emptyTurnRetries + 1 }); } catch {}
      }
      if (emptyTurnRetries < MAX_EMPTY_RETRIES) {
        emptyTurnRetries++;
        // Nudge the model to produce output and retry without counting as success
        items.push({ role: "user", content: "[system: empty response — please provide a text summary or tool call]" });
        continue;
      }
      const r: AgentRunResult = {
        ok: false,
        steps: step,
        summary: `Model returned empty response after ${MAX_EMPTY_RETRIES} retries at step ${step}`,
        provider: provider.id,
        model: rawModel ?? provider.model,
        compacted: didCompact || undefined,
        turnsDropped: totalTurnsDropped || undefined,
        streamed: !!emit,
        steered: !!supervision?.service?.steeredFlag,
        approvals: supervision?.service?.currentApprovals ?? [],
        stuck: false,
      };
      if (transcript && !transcript.isDisabled) {
        try { transcript.appendSystem("error", { message: r.summary, step }); } catch {}
      }
      return finishFailure(r, `The model returned no answer after ${MAX_EMPTY_RETRIES} retries.`);
    }

    if (calls.length === 0 || finalStep) {
      let sum = lastText || "Done (no summary text returned).";
      if (supervision?.service?.steeredFlag) sum += " (steered context applied)";
      if (typeof attachNote !== "undefined" && attachNote) sum = withNote(sum);
      const r: AgentRunResult = { ok: true, steps: step, summary: sum,
        provider: provider.id,
        model: rawModel ?? provider.model,
        compacted: didCompact || undefined,
        turnsDropped: totalTurnsDropped || undefined,
        streamed: !!emit,
        steered: !!supervision?.service?.steeredFlag,
        approvals: supervision?.service?.currentApprovals ?? [],
      };
      writeTranscriptSummary(r);
      return r;
    }

    // Execute tool calls for this turn — dedupe same-step duplicates, run read-only in parallel
    const READONLY_TOOLS = new Set(["get_summary","get_cell_source","get_outputs","get_status","list_files","read_file","get_variables","get_pip_packages","list_open_notebooks"]);
    const pendingToolResults: unknown[] = [];
    // Same-step duplicate guard: two identical calls in ONE turn -> execute once, feed result to both
    const callKeys = new Map<string, number>();
    const dedupIndex: Array<number | null> = [];
    const canonicalCalls: typeof calls = [];
    const canonicalIdxMap: number[] = [];
    for (let ci = 0; ci < calls.length; ci++) {
      const c = calls[ci] as unknown as Record<string, unknown>;
      const k = String(c.name) + "\0" + String(c.arguments ?? "");
      if (callKeys.has(k)) {
        const first = callKeys.get(k)!;
        dedupIndex.push(first);
      } else {
        callKeys.set(k, canonicalCalls.length);
        dedupIndex.push(null);
        canonicalCalls.push(calls[ci]);
        canonicalIdxMap.push(ci);
      }
    }
    // Decide execution mode: if every canonical call is read-only, run concurrently; else sequential for determinism
    const allReadOnly = canonicalCalls.length > 1 && canonicalCalls.every((c) => READONLY_TOOLS.has(String((c as unknown as Record<string, unknown>).name)));
    type ToolExecResult = { outText: string; isError?: boolean; parsedOk: boolean; parseError?: string; denied?: boolean };
    let canonicalResults: ToolExecResult[] = [];
    if (allReadOnly) {
      const results = await Promise.all(canonicalCalls.map(async (call, idx) => {
        const tname = String((call as unknown as Record<string, unknown>).name);
        const callId = String((call as unknown as Record<string, unknown>).call_id ?? (call as unknown as Record<string, unknown>).id ?? `call-${step}-${idx}`);
        if (emit) {
          const preview = String((call as unknown as Record<string, unknown>).arguments ?? "").slice(0, 500);
          emit({ type: "tool-call", name: tname, argsPreview: preview });
        }
        if (supervision?.signal?.aborted) return { outText: "cancelled", isError: true, parsedOk: true } as ToolExecResult;
        const parsed = safeParseToolArgs((call as unknown as Record<string, unknown>).arguments);
        if (!parsed.ok) {
          const outText = `Tool argument parse error for ${tname}: ${parsed.error}`;
          if (emit) emit({ type: "tool-result", name: tname, ok: false, summary: parsed.error.slice(0, 500) });
          return { outText, isError: true, parsedOk: false, parseError: parsed.error } as ToolExecResult;
        }
        // Approval for risky tools still sequential — but read-only set has no risky tools, so skip
        const result = await callTool(tools, tname, parsed.args as Record<string, never>);
        const outText = result.content.map((c) => c.text).join("\n");
        if (emit) emit({ type: "tool-result", name: tname, ok: !result.isError, summary: outText.slice(0, 500) });
        return { outText, isError: !!result.isError, parsedOk: true } as ToolExecResult;
      }));
      canonicalResults = results;
      // Deterministic transcript order: sort by original call order already, so emit in canonical order
      // Push items in canonical order
      for (let i = 0; i < canonicalCalls.length; i++) {
        const call = canonicalCalls[i];
        const res = canonicalResults[i];
        if (!res.parsedOk) {
          items.push({ type: "function_call_output", call_id: (call as unknown as Record<string, unknown>).call_id, output: res.outText });
          pendingToolResults.push({ type: "tool_result", tool_use_id: String((call as unknown as Record<string, unknown>).call_id), content: truncatedToolResult(res.outText), isError: true });
          continue;
        }
        items.push({ type: "function_call_output", call_id: (call as unknown as Record<string, unknown>).call_id, output: res.outText });
        pendingToolResults.push({ type: "tool_result", tool_use_id: String((call as unknown as Record<string, unknown>).call_id), content: truncatedToolResult(res.outText), isError: !!res.isError });
        // doom tracking for read-only also (rare but keep)
        {
          const tname2 = String((call as unknown as Record<string, unknown>).name);
          let argsJson = "";
          try { argsJson = JSON.stringify(safeParseToolArgs((call as unknown as Record<string, unknown>).arguments).ok ? safeParseToolArgs((call as unknown as Record<string, unknown>).arguments) : {}); } catch { argsJson = String((call as unknown as Record<string, unknown>).arguments ?? ""); }
          const argsPreview = String((call as unknown as Record<string, unknown>).arguments ?? "").slice(0, 500);
          lastToolResultText = res.outText;
          doomHistory.push({ name: tname2, argsJson, argsPreview });
          if (doomStrikeTool && tname2 !== doomStrikeTool) { doomStrikes = 0; doomStrikeTool = ""; }
        }
      }
      // Deduplicated calls: record as system note, not a second function_call_output.
      // Parse-FAILED canonicals are never deduped: each failed call_id keeps its
      // own honest error output (one per call_id, Responses-correct) instead of
      // one failure fanned into N red boxes via dedup notes (2026-11-02 incident:
      // 6x empty get_cell_source produced 5 phantom [deduped] errors on top).
      for (let oi = 0; oi < calls.length; oi++) {
        const dup = dedupIndex[oi];
        if (dup !== null) {
          if (!canonicalResults[dup].parsedOk) {
            const dupCall = calls[oi] as unknown as Record<string, unknown>;
            const tname = String(dupCall.name);
            const outText = `Tool argument parse error for ${tname}: ${canonicalResults[dup].parseError ?? "invalid arguments"}`;
            items.push({ type: "function_call_output", call_id: dupCall.call_id, output: outText });
            pendingToolResults.push({ type: "tool_result", tool_use_id: String(dupCall.call_id), content: truncatedToolResult(outText), isError: true });
            if (emit) {
              emit({ type: "tool-call", name: tname, argsPreview: String(dupCall.arguments ?? "").slice(0, 500) });
              emit({ type: "tool-result", name: tname, ok: false, summary: (canonicalResults[dup].parseError ?? "parse error").slice(0, 500) });
            }
            continue;
          }
          const srcIdx = canonicalIdxMap[dup];
          const srcCall = calls[srcIdx] as unknown as Record<string, unknown>;
          const dupCall = calls[oi] as unknown as Record<string, unknown>;
          const srcRes = canonicalResults[dup];
          const tname = String(dupCall.name);
          items.push({ role: "user", content: `[system: duplicate ${tname} call ${String(dupCall.call_id)} deduplicated — same result as ${String(srcCall.call_id)}]` });
          if (transcript && !transcript.isDisabled) { try { transcript.appendSystem("dedup", { tool: tname, dupCallId: String(dupCall.call_id), canonicalCallId: String(srcCall.call_id), step }); } catch {} }
          if (emit) {
            emit({ type: "tool-call", name: tname, argsPreview: String(dupCall.arguments ?? "").slice(0, 500) + " [deduped]" });
            emit({ type: "tool-result", name: tname, ok: !srcRes.isError, summary: srcRes.outText.slice(0, 500) + " [deduped]" });
          }
        }
      }
    } else {
    // Sequential execution — single-shot per canonical call; duplicates receive a system note, not a second output
    for (const call of canonicalCalls) {

      if (supervision?.signal?.aborted) {
        if (pendingToolResults.length && transcript && !transcript.isDisabled) {
          try { transcript.appendUser(pendingToolResults); } catch {}
        }
        const r: AgentRunResult = { ok: false, steps: step, summary: `cancelled by user at step ${step}`, provider: provider.id, model: provider.model, cancelled: true, steered: !!supervision?.service?.steeredFlag, approvals: supervision?.service?.currentApprovals ?? [], streamed: !!emit };
        return flushCancelAndSummarize(r, "cancelled before tool execute");
      }
      if (emit) {
        const preview = String(call.arguments ?? "").slice(0, 500);
        emit({ type: "tool-call", name: String(call.name), argsPreview: preview });
      }
      const tname = String(call.name);
      if (supervision?.requireApproval && RISKY_TOOLS.has(tname) && supervision.service && supervision.runId) {
        const preview = String(call.arguments ?? "").slice(0, 500);
        if (emit) emit({ type: "approval-needed", tool: tname, argsPreview: preview, runId: supervision.runId });
        const decision = await supervision.service.waitForApproval(supervision.runId, tname, preview);
        if (transcript && !transcript.isDisabled) {
          try { transcript.appendSystem("approval", { tool: tname, decision, argsPreview: preview.slice(0, 500), step }); } catch {}
        }
        if (decision === "deny") {
          const denied = `${tname} denied by user`;
          items.push({ type: "function_call_output", call_id: call.call_id, output: denied });
          if (emit) emit({ type: "tool-result", name: tname, ok: false, summary: denied });
          pendingToolResults.push({ type: "tool_result", tool_use_id: String(call.call_id), content: truncatedToolResult(denied), isError: true });
          continue;
        }
      }
      const parsed = safeParseToolArgs(call.arguments);
      if (!parsed.ok) {
        items.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: `Tool argument parse error for ${String(call.name)}: ${parsed.error}`,
        });
        if (emit) emit({ type: "tool-result", name: String(call.name), ok: false, summary: parsed.error.slice(0, 500) });
        pendingToolResults.push({ type: "tool_result", tool_use_id: String(call.call_id), content: truncatedToolResult(`Tool argument parse error for ${String(call.name)}: ${parsed.error}`), isError: true });
        continue;
      }
      const result = await callTool(tools, String(call.name), parsed.args as Record<string, never>);
      const outText = result.content.map((c) => c.text).join("\n");
      items.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: outText,
      });
      if (emit) {
        emit({ type: "tool-result", name: String(call.name), ok: !result.isError, summary: outText.slice(0, 500) });
      }
      pendingToolResults.push({ type: "tool_result", tool_use_id: String(call.call_id), content: truncatedToolResult(outText), isError: !!result.isError });
      canonicalResults.push({ outText, isError: !!result.isError, parsedOk: true });
      // doom-loop guard: track executed tool calls — 3-strike ladder (never block)
      {
        const tname2 = String(call.name);
        let argsJson = "";
        try {
          argsJson = JSON.stringify(parsed.args);
        } catch {
          argsJson = String(call.arguments ?? "");
        }
        const argsPreview = String(call.arguments ?? "").slice(0, 500);
        lastToolResultText = outText;
        doomHistory.push({ name: tname2, argsJson, argsPreview });
        if (doomStrikeTool && tname2 !== doomStrikeTool) { doomStrikes = 0; doomStrikeTool = ""; }
      }
      if (supervision?.signal?.aborted) {
        if (pendingToolResults.length && transcript && !transcript.isDisabled) {
          try { transcript.appendUser(pendingToolResults); } catch {}
        }
        const r: AgentRunResult = { ok: false, steps: step, summary: `cancelled by user at step ${step}`, provider: provider.id, model: provider.model, cancelled: true, steered: !!supervision?.service?.steeredFlag, approvals: supervision?.service?.currentApprovals ?? [], streamed: !!emit };
        return flushCancelAndSummarize(r, "cancelled after tool execute");
      }
    }
    // Deduplicated sequential calls: same rules as parallel — parse failures keep
    // their own honest error output, never a dedup note.
    for (let oi = 0; oi < calls.length; oi++) {
      const dup = dedupIndex[oi];
      if (dup !== null) {
        const dupCall = calls[oi] as unknown as Record<string, unknown>;
        const tname = String(dupCall.name);
        const canonParsed = safeParseToolArgs((calls[canonicalIdxMap[dup]] as unknown as Record<string, unknown>).arguments);
        if (!canonParsed.ok) {
          const outText = `Tool argument parse error for ${tname}: ${canonParsed.error}`;
          items.push({ type: "function_call_output", call_id: dupCall.call_id, output: outText });
          pendingToolResults.push({ type: "tool_result", tool_use_id: String(dupCall.call_id), content: truncatedToolResult(outText), isError: true });
          if (emit) {
            emit({ type: "tool-call", name: tname, argsPreview: String(dupCall.arguments ?? "").slice(0, 500) });
            emit({ type: "tool-result", name: tname, ok: false, summary: canonParsed.error.slice(0, 500) });
          }
          continue;
        }
        const srcIdx = canonicalIdxMap[dup];
        const srcCall = calls[srcIdx] as unknown as Record<string, unknown>;
        items.push({ role: "user", content: `[system: duplicate ${tname} call ${String(dupCall.call_id)} deduplicated — same result as ${String(srcCall.call_id)}]` });
        if (transcript && !transcript.isDisabled) { try { transcript.appendSystem("dedup", { tool: tname, dupCallId: String(dupCall.call_id), canonicalCallId: String(srcCall.call_id), step }); } catch {} }
        if (emit) {
          emit({ type: "tool-call", name: tname, argsPreview: String(dupCall.arguments ?? "").slice(0, 500) + " [deduped]" });
          emit({ type: "tool-result", name: tname, ok: true, summary: "[deduped] same result as " + String(srcCall.call_id) });
        }
      }
    }
    }
    // artifact image injection: read artifact files and send as input_image at the edge (ONLY place base64 lives)
    {
      const collected: Array<{ mime: string; b64: string }> = [];
      for (const cr of canonicalResults) {
        const imgs = extractArtifactImages(cr.outText);
        for (const im of imgs) if (collected.length < 5) collected.push(im);
        if (collected.length >= 5) break;
      }
      if (collected.length) {
        const parts: unknown[] = [{ type: "input_text", text: `[artifact images: ${collected.length} image(s) from previous tool output — see attached]` }];
        for (const im of collected) parts.push({ type: "input_image", image_url: `data:${im.mime};base64,${im.b64}` });
        items.push({ role: "user", content: parts });
        if (emit) emit({ type: "artifact-images", count: collected.length });
        if (transcript && !transcript.isDisabled) {
          try { transcript.appendSystem("artifact_images", { count: collected.length, step }); } catch {}
        }
      }
    }
    // doom ladder: 3-strike escalation, never block, never timeout-kill
    if (doomHistory.length >= 3) {
      const a = doomHistory[doomHistory.length - 3];
      const b = doomHistory[doomHistory.length - 2];
      const c = doomHistory[doomHistory.length - 1];
      if (a.name === b.name && b.name === c.name && a.argsJson === b.argsJson && b.argsJson === c.argsJson) {
        doomStrikes = (c.name === doomStrikeTool) ? doomStrikes + 1 : 1;
        doomStrikeTool = c.name;
        const previewShort = c.argsPreview.slice(0, 200);
        const lastObs = lastToolResultText.slice(0, 500);
        if (transcript && !transcript.isDisabled) {
          try { transcript.appendSystem("doom_loop", { tool: c.name, argsPreview: previewShort, step, strikes: doomStrikes }); } catch {}
        }
        if (doomStrikes < 3) {
          if (emit) emit({ type: "doom-notice", tool: c.name, argsPreview: previewShort });
          if (transcript && !transcript.isDisabled) {
            try { transcript.appendSystem("doom_notice", { tool: c.name, argsPreview: previewShort, step }); } catch {}
          }
          console.warn(`[loop] doom loop detected for ${c.name} (strike ${doomStrikes}/3) — continuing with reset`);
          doomHistory.length = 0;
          if (doomStrikes === 1) {
            const obs = lastToolResultText.slice(0, 500).replace(/\n/g, " ");
            items.push({ role: "user", content: `[system: Repeated tool call ${c.name} with identical arguments 3x. Last observation (truncated): ${obs}. Change arguments or inspect state first; do not retry the same call.]` });
            if (transcript && !transcript.isDisabled) { try { transcript.appendSystem("doom_nudge", { tool: c.name, lastObs: obs.slice(0, 300), step }); } catch {} }
          } else {
            const obs = lastToolResultText.slice(0, 500).replace(/\n/g, " ");
            items.push({ role: "user", content: `[system: Second warning: repeated tool call ${c.name} with identical arguments 3x again. Last observation (truncated): ${obs}. List what you tried so far, then pick a different tool or vary arguments — do not retry the same call.]` });
            if (transcript && !transcript.isDisabled) { try { transcript.appendSystem("doom_nudge", { tool: c.name, lastObs: obs.slice(0, 300), step }); } catch {} }
          }
        } else {
          if (pendingToolResults.length && transcript && !transcript.isDisabled) {
            try { transcript.appendUser(pendingToolResults); pendingToolResults.length = 0; } catch {}
          }
          const obsShort = lastObs.replace(/\n/g, " ").slice(0, 300);
          const summary = `Stopped after 3 identical-call warnings for ${c.name} to protect credit. Last observation: ${obsShort}. Try: list what you tried, inspect state with a different tool, and vary arguments before retrying.`;
          const r: AgentRunResult = {
            ok: false,
            steps: step,
            summary,
            provider: provider.id,
            model: provider.model,
            compacted: didCompact || undefined,
            turnsDropped: totalTurnsDropped || undefined,
            streamed: !!emit,
            steered: !!supervision?.service?.steeredFlag,
            approvals: supervision?.service?.currentApprovals ?? [],
            stuck: true,
          };
          return finishFailure(r, `Stopped after 3 repeated attempts with the same tool (${c.name}). ` + summary);
        }
      }
    }
    // End of tool executions for this step — flush user line with all tool_results
    if (pendingToolResults.length && transcript && !transcript.isDisabled) {
      try { transcript.appendUser(pendingToolResults); } catch {}
    }
  }

  const finalRes: AgentRunResult = {
    ok: true,
    steps: MAX_STEPS,
    summary: lastText || "Step budget reached.",
    provider: provider.id,
    model: provider.model,
    compacted: didCompact || undefined,
    turnsDropped: totalTurnsDropped || undefined,
    streamed: !!emit,
    steered: !!supervision?.service?.steeredFlag,
    approvals: supervision?.service?.currentApprovals ?? [],
  };
  writeTranscriptSummary(finalRes);
  return finalRes;
  } catch (outerErr) {
    const outerMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    const cause = "Something unexpected went wrong while running: " + outerMsg.slice(0, 500);
    const fallback: AgentRunResult = {
      ok: false,
      steps: 0,
      summary: "",
      provider: (typeof provider !== "undefined" ? (provider as unknown as { id: string }).id : undefined) as string | undefined,
      model: (typeof provider !== "undefined" ? (provider as unknown as { model: string }).model : undefined) as string | undefined,
      streamed: !!emit,
    };
    console.error("[loop] outer safety net caught:", outerMsg);
    return finishFailure(fallback, cause);
  }
}

export async function runAgent(
  cfg: JupiConfig,
  tools: ToolDef[],
  userTask: string,
  providerName?: string,
  ctxInfo?: NotebookContextInfo,
  supervision?: SupervisionOpts,
  history?: ContinuationHistory,
): Promise<AgentRunResult> {
  return runAgentCore(cfg, tools, userTask, providerName, ctxInfo, undefined, supervision, history);
}

export async function runAgentStreaming(
  cfg: JupiConfig,
  tools: ToolDef[],
  userTask: string,
  providerName?: string,
  ctxInfo?: NotebookContextInfo,
  emit?: (evt: Record<string, unknown>) => void,
  supervision?: SupervisionOpts,
  history?: ContinuationHistory,
): Promise<AgentRunResult> {
  // emit is required for streaming; if not provided, still runs with streaming turn caller
  return runAgentCore(cfg, tools, userTask, providerName, ctxInfo, emit ?? (() => {}), supervision, history);
}
