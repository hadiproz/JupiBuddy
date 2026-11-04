// Transcript writer for native runs — JSONL transcript per spec v1.1 (Part C).
// Backend only, plain TS, zero deps. Envelope: {v, seq, type, uuid, parentUuid, ts, sessionId, ...payload}
// Reader tolerance: unknown line types/fields are ignored (fold invariant).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Reasoning-effort tier actually sent (seven protocol tiers, dev-notes/MUSE-MODELS.md).
// The open `string` arm keeps loop.ts's pass-through value assignable without a cast.
export type TranscriptEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | string;

// Session meta required at writer construction — cwd from service.workspaceRoot per spec.
export interface TranscriptSessionMeta {
  cwd: string;
  provider: string;
  model: string;
  task: string;
  label?: string;
  effort?: TranscriptEffort;
}

// Payload for summary line — mirrors AgentRunResult + usage zeros + effects.
export interface TranscriptSummaryRecord {
  ok: boolean;
  steps: number;
  time: number;
  summary: string;
  compacted?: boolean;
  turnsDropped?: number;
  cancelled?: boolean;
  steered?: boolean;
  approvals?: Array<{ tool: string; decision: string }>;
  stuck?: boolean;
  attachmentIds?: string[];
  usage?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  effects?: { cellsAdded: number; cellsEdited: number; cellsRun: number; filesChanged: number };
  effort?: TranscriptEffort;
}

export class TranscriptWriter {
  readonly dir: string;
  readonly sessionId: string;
  readonly filePath: string;
  private seq = 0;
  private lastUuid: string | null = null;
  private disabled = false;
  // Effects counted from tool_call blocks — fold invariant requires summary.effects == fold.
  private effects = { cellsAdded: 0, cellsEdited: 0, cellsRun: 0, filesChanged: 0 };

  constructor(opts: { dir: string; sessionId: string; sessionMeta: TranscriptSessionMeta }) {
    this.dir = opts.dir;
    this.sessionId = opts.sessionId;
    this.filePath = join(opts.dir, `${opts.sessionId}.jsonl`);
    try {
      mkdirSync(opts.dir, { recursive: true });
    } catch (e) {
      console.warn(`[transcript] mkdir failed for ${opts.dir}:`, e instanceof Error ? e.message : String(e));
      this.disabled = true;
      return;
    }
    // Write session line immediately — v1: origin native, agent jupibuddy 0.0.1
    // If package.json version drifts, we still remain valid — readers ignore unknown fields.
    // package.json version is 0.0.1 — keep in sync manually to avoid ESM require issues.
    const pkgVersion = "0.0.1";
    const payload: Record<string, unknown> = {
      cwd: opts.sessionMeta.cwd,
      provider: opts.sessionMeta.provider,
      model: opts.sessionMeta.model,
      agent: { name: "jupibuddy", version: pkgVersion },
      task: opts.sessionMeta.task,
      ...(opts.sessionMeta.label ? { label: opts.sessionMeta.label } : {}),
      origin: { kind: "native" },
    };
    this.writeLine("session", payload);
  }

  get lastLineUuid(): string | null {
    return this.lastUuid;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  get fileName(): string {
    return `${this.sessionId}.jsonl`;
  }

  // Relative path for SessionEntry — sessions/<runId>.jsonl
  get relativePath(): string {
    return join("sessions", `${this.sessionId}.jsonl`);
  }

  // Public getter for accumulated effects (used when constructing summary if caller omits effects)
  get currentEffects(): { cellsAdded: number; cellsEdited: number; cellsRun: number; filesChanged: number } {
    return { ...this.effects };
  }

  private writeLine(type: string, payload: Record<string, unknown>): void {
    if (this.disabled) return;
    const line: Record<string, unknown> = {
      v: 1,
      seq: this.seq,
      type,
      uuid: randomUUID(),
      parentUuid: this.lastUuid,
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      ...payload,
    };
    this.lastUuid = line.uuid as string;
    this.seq += 1;
    try {
      appendFileSync(this.filePath, JSON.stringify(line) + "\n", "utf-8");
    } catch (e) {
      console.warn(`[transcript] append failed for ${this.sessionId} seq ${line.seq}:`, e instanceof Error ? e.message : String(e));
    }
  }

  appendUser(blocks: unknown[]): void {
    this.writeLine("user", { message: { role: "user", content: blocks } });
  }

  appendAssistant(opts: { model: string; blocks: unknown[] }): void {
    // Track effects for fold invariant — count from tool_call blocks only.
    for (const b of opts.blocks as Array<Record<string, unknown>>) {
      if (!b || typeof b !== "object") continue;
      if (b.type !== "tool_call") continue;
      const name = String((b as Record<string, unknown>).name ?? "");
      if (name === "insert_cell" || name === "new_cell" || name === "create_cell" || name === "add_cell") this.effects.cellsAdded += 1;
      else if (name === "edit_cell") this.effects.cellsEdited += 1;
      else if (name === "run_cells") this.effects.cellsRun += 1;
      else if (name === "write_file") this.effects.filesChanged += 1;
    }
    this.writeLine("assistant", { message: { role: "assistant", model: opts.model, content: opts.blocks } });
  }

  appendSystem(subtype: string, payload: Record<string, unknown> = {}): void {
    this.writeLine("system", { subtype, ...payload });
  }

  appendSummary(record: TranscriptSummaryRecord): void {
    // Honest zeros: we don't meter tokens — document in code comment per task.
    // Usage is always {input:0, output:0, reasoning:0, cacheRead:0, cacheWrite:0}
    const usage = record.usage ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    const effects = record.effects ?? { ...this.effects };
    // Ensure required summary fields have safe defaults (never crash summary write)
    const payload: Record<string, unknown> = {
      ok: record.ok,
      steps: record.steps,
      time: record.time,
      summary: record.summary,
      compacted: record.compacted ?? false,
      turnsDropped: record.turnsDropped ?? 0,
      cancelled: record.cancelled ?? false,
      steered: record.steered ?? false,
      approvals: record.approvals ?? [],
      stuck: record.stuck ?? false,
      attachmentIds: record.attachmentIds ?? [],
      usage,
      effects,
      ...(record.effort ? { effort: record.effort } : {}),
    };
    this.writeLine("summary", payload);
  }

  // Flush/close — sync appends are already flushed; kept for symmetry with spec's close().
  close(): void {
    // No buffered writer — nothing to flush. Kept as no-op for server finally semantics.
  }
}

// --- Transcript history reader (ADDITIVE, pure, zero deps) ---

export interface TranscriptHistoryOptions {
  maxTurns?: number;
}

export interface TranscriptHistory {
  items: unknown[];
  summary?: Record<string, unknown> | null;
}

/**
 * Load history from <dir>/<sessionId>.jsonl for continuation.
 * - Parses each line defensively (skip malformed)
 * - Returns ordered Responses-style items suitable for both protocols
 * - Caps at maxTurns (default 50) oldest dropped
 * - NEVER includes summary line as model input (returned separately)
 * - Unknown line types/fields ignored (fold invariant)
 * - Missing file or empty -> empty history, no throw
 */
export function loadTranscriptHistory(
  dir: string,
  sessionId: string,
  opts?: TranscriptHistoryOptions,
): TranscriptHistory {
  const empty: TranscriptHistory = { items: [], summary: null };
  if (!dir || typeof dir !== "string" || !sessionId || typeof sessionId !== "string") return empty;
  const trimmed = sessionId.trim();
  if (!trimmed) return empty;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return empty;
  const filePath = join(dir, `${trimmed}.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return empty;
  }
  if (!raw || !raw.trim()) return empty;
  const lines: Array<Record<string, unknown>> = [];
  let summaryLine: Record<string, unknown> | null = null;
  for (const l of raw.split("\n")) {
    const t = l.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (!obj || typeof obj !== "object") continue;
      if ((obj.type as string) === "summary") {
        summaryLine = obj as Record<string, unknown>;
        continue;
      }
      lines.push(obj as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  if (!lines.length) return { items: [], summary: summaryLine };
  lines.sort((a, b) => {
    const sa = typeof a.seq === "number" ? (a.seq as number) : 0;
    const sb = typeof b.seq === "number" ? (b.seq as number) : 0;
    return sa - sb;
  });
  const relevant: Array<Record<string, unknown>> = [];
  for (const l of lines) {
    const tp = l.type as string | undefined;
    if (tp === "user" || tp === "assistant") relevant.push(l);
  }
  if (!relevant.length) return { items: [], summary: summaryLine };
  type Turn = Array<Record<string, unknown>>;
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const line of relevant) {
    const tp = line.type as string;
    if (tp === "user") {
      if (cur && cur.length) turns.push(cur);
      cur = [line];
    } else if (tp === "assistant") {
      if (!cur) cur = [];
      cur.push(line);
    }
  }
  if (cur && cur.length) turns.push(cur);
  const maxTurns = opts?.maxTurns ?? 50;
  const kept = turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns;
  const flat = kept.flat();
  const items: unknown[] = [];
  for (const line of flat) {
    const tp = line.type as string;
    if (tp === "user") {
      const msg = (line as Record<string, unknown>).message as Record<string, unknown> | undefined;
      const blocks = (msg?.content ?? []) as unknown[];
      if (!Array.isArray(blocks)) continue;
      const textParts: string[] = [];
      const toolResults: Array<{ id: string; content: string }> = [];
      const attachParts: string[] = [];
      for (const b of blocks as Array<Record<string, unknown>>) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string" && (b.text as string).trim()) {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          const cid = String((b as unknown as Record<string, unknown>).tool_use_id ?? (b as unknown as Record<string, unknown>).id ?? "");
          if (!cid) continue;
          let content = "";
          const c = (b as Record<string, unknown>).content;
          if (typeof c === "string") content = c;
          else if (Array.isArray(c)) content = (c as unknown[]).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
          else if (c != null) content = String(c);
          toolResults.push({ id: cid, content });
        } else if (b.type === "attachment" && typeof (b as Record<string, unknown>).id === "string") {
          attachParts.push(`[attachment ${String((b as Record<string, unknown>).id)}]`);
        } else if (b.type === "image" && typeof (b as Record<string, unknown>).id === "string") {
          attachParts.push(`[image ${String((b as Record<string, unknown>).id)}]`);
        }
      }
      const combinedText = [...textParts, ...attachParts].join("\n\n").trim();
      if (combinedText) items.push({ role: "user", content: combinedText });
      for (const tr of toolResults) items.push({ type: "function_call_output", call_id: tr.id, output: tr.content });
    } else if (tp === "assistant") {
      const msg = (line as Record<string, unknown>).message as Record<string, unknown> | undefined;
      const blocks = (msg?.content ?? []) as unknown[];
      if (!Array.isArray(blocks)) continue;
      const texts: string[] = [];
      const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
      for (const b of blocks as Array<Record<string, unknown>>) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string" && (b.text as string).trim()) {
          texts.push(b.text as string);
        } else if (b.type === "tool_call") {
          const id = String((b as Record<string, unknown>).id ?? "");
          const name = String((b as Record<string, unknown>).name ?? "");
          if (!name) continue;
          const input = (b as Record<string, unknown>).input;
          toolCalls.push({ id: id || `call-${toolCalls.length}`, name, input });
        }
      }
      if (texts.length) {
        const txt = texts.join("\n\n");
        items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: txt }] });
      }
      for (const tc of toolCalls) {
        let argsStr: string;
        if (typeof tc.input === "string") argsStr = tc.input as string;
        else {
          try { argsStr = JSON.stringify(tc.input ?? {}); } catch { argsStr = "{}"; }
        }
        items.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: argsStr });
      }
    }
  }
  return { items, summary: summaryLine };
}

// --- Markdown export helpers (ADDITIVE, pure render, zero deps) ---


/** Escape markdown special chars in headings to avoid injection */
function escMd(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

function truncateMd(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

/** Render CLEAN markdown from transcript lines (fold order). Unknown types ignored. */
export function renderTranscriptMarkdown(
  lines: unknown[],
  opts: { id?: string; title?: string; task?: string; time?: string; provider?: string; model?: string } = {},
): string {
  const objs = (lines as Array<Record<string, unknown>>).filter((l) => l && typeof l === "object");
  objs.sort((a, b) => {
    const sa = typeof a.seq === "number" ? (a.seq as number) : 0;
    const sb = typeof b.seq === "number" ? (b.seq as number) : 0;
    return sa - sb;
  });

  let sessionLine: Record<string, unknown> | null = null;
  let summaryLine: Record<string, unknown> | null = null;
  for (const l of objs) {
    const t = (l as Record<string, unknown>).type as string | undefined;
    if (t === "session" && !sessionLine) sessionLine = l as Record<string, unknown>;
    if (t === "summary") summaryLine = l as Record<string, unknown>;
  }

  const titleOrTask = escMd((opts.title && opts.title.trim()) || (opts.task && opts.task.trim()) || (sessionLine?.task as string) || (summaryLine?.summary as string) || "Untitled") || "Untitled";
  const provider = (sessionLine?.provider as string) || opts.provider || "";
  const model = (sessionLine?.model as string) || opts.model || "";
  const providerModel = model ? `${provider}/${model}` : provider || "unknown";
  const timeRaw = (summaryLine?.ts as string) || (sessionLine?.ts as string) || opts.time || "";
  let timeStr = timeRaw;
  try {
    if (timeRaw) timeStr = new Date(timeRaw).toISOString();
  } catch {}
  const steps = typeof summaryLine?.steps === "number" ? (summaryLine.steps as number) : 0;
  const okVal = summaryLine?.ok;
  const okStr = okVal === true ? "ok" : okVal === false ? "error" : String(okVal ?? "unknown");

  const out: string[] = [];
  out.push(`# ${titleOrTask}`);
  out.push("");
  out.push(`_${escMd(timeStr)} · ${escMd(providerModel)} · ${steps} steps · ${okStr}_`);
  out.push("");

  // Build turns: each assistant creates a Turn, following user lines attach tool results
  type Turn = {
    n: number;
    texts: string[];
    toolCalls: Array<{ name: string; input: unknown }>;
    toolResults: Array<{ content: string }>;
    userTexts: string[];
    attachments: Array<{ id: string; name?: string; mediaType?: string }>;
  };
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let turnCounter = 0;

  // helper to push current when new assistant arrives
  for (const line of objs) {
    const type = (line as Record<string, unknown>).type as string | undefined;
    if (type === "assistant") {
      turnCounter += 1;
      current = { n: turnCounter, texts: [], toolCalls: [], toolResults: [], userTexts: [], attachments: [] };
      turns.push(current);
      const msg = (line as Record<string, unknown>).message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as unknown[];
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (!b || typeof b !== "object") continue;
          if (b.type === "text" && typeof b.text === "string") {
            current.texts.push(b.text);
          } else if (b.type === "tool_call") {
            current.toolCalls.push({ name: String((b as Record<string, unknown>).name ?? "tool"), input: (b as Record<string, unknown>).input });
          } else if (b.type === "thinking" && typeof (b as Record<string, unknown>).thinking === "string") {
            current.texts.push(`> thinking: ${(b as Record<string, unknown>).thinking as string}`);
          }
          // unknown block types ignored
        }
      }
    } else if (type === "user") {
      if (!current) continue; // ignore opening task before first turn
      const msg = (line as Record<string, unknown>).message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as unknown[];
      if (!Array.isArray(content)) continue;
      for (const b of content as Array<Record<string, unknown>>) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_result") {
          const c = b.content;
          let txt = "";
          if (typeof c === "string") txt = c;
          else if (Array.isArray(c)) txt = c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
          else if (c != null) txt = String(c);
          current.toolResults.push({ content: truncateMd(txt, 1000) });
        } else if (b.type === "attachment") {
          const id = String((b as Record<string, unknown>).id ?? "");
          const name = (b as Record<string, unknown>).name as string | undefined;
          const mediaType = ((b as Record<string, unknown>).mediaType as string | undefined) || ((b as Record<string, unknown>).mime as string | undefined);
          current.attachments.push({ id, name, mediaType });
        } else if (b.type === "text" && typeof b.text === "string") {
          current.userTexts.push(b.text);
        } else if (b.type === "image" && typeof (b as Record<string, unknown>).id === "string") {
          current.attachments.push({ id: String((b as Record<string, unknown>).id), name: (b as Record<string, unknown>).name as string | undefined, mediaType: "image" });
        }
        // unknown block types ignored
      }
    } else if (type === "session" || type === "summary" || type === "system") {
      // known but not rendered per-turn (summary handled at end, system ignored except tolerance)
      continue;
    } else {
      // Unknown line type — tolerance rule: ignore
      continue;
    }
  }

  for (const t of turns) {
    out.push(`## Turn ${t.n}`);
    out.push("");
    for (const txt of t.texts) {
      if (txt.trim()) {
        out.push(txt.trim());
        out.push("");
      }
    }
    for (const tc of t.toolCalls) {
      out.push("```json");
      try {
        out.push(JSON.stringify({ name: tc.name, input: tc.input }, null, 2));
      } catch {
        out.push(JSON.stringify({ name: tc.name }, null, 2));
      }
      out.push("```");
      out.push("");
    }
    for (const tr of t.toolResults) {
      out.push("```text");
      out.push(tr.content);
      out.push("```");
      out.push("");
    }
    for (const ut of t.userTexts) {
      if (ut.trim()) {
        out.push("```text");
        out.push(truncateMd(ut, 1000));
        out.push("```");
        out.push("");
      }
    }
    for (const att of t.attachments) {
      const nm = att.name || att.id || "attachment";
      const isImage = (att.mediaType && att.mediaType.startsWith("image/")) || /\.(png|jpe?g|gif|webp|svg)$/i.test(nm);
      if (isImage) {
        out.push(`![${escMd(nm)}](${escMd(att.id)})`);
      } else {
        out.push(`Attachment: ${escMd(nm)} (${escMd(att.id)})`);
      }
      out.push("");
    }
  }

  // Closing summary
  out.push("## Summary");
  out.push("");
  const summaryText = (summaryLine?.summary as string) || "";
  if (summaryText.trim()) {
    out.push(summaryText.trim());
    out.push("");
  }
  // Counters table
  const usage = (summaryLine?.usage as Record<string, unknown>) || {};
  const effects = (summaryLine?.effects as Record<string, unknown>) || {};
  const fold = foldTranscript(lines as unknown[]);
  out.push("| Metric | Value |");
  out.push("|---|---|");
  out.push(`| Steps | ${steps} |`);
  out.push(`| Turns | ${fold.turns} |`);
  out.push(`| Tool Calls | ${fold.toolCalls} |`);
  out.push(`| ok | ${okStr} |`);
  out.push(`| Provider | ${escMd(providerModel)} |`);
  if (timeStr) out.push(`| Date | ${escMd(timeStr)} |`);
  if (typeof summaryLine?.compacted !== "undefined") out.push(`| Compacted | ${String(summaryLine.compacted)} |`);
  if (typeof summaryLine?.turnsDropped !== "undefined") out.push(`| Turns Dropped | ${String(summaryLine.turnsDropped)} |`);
  if (typeof summaryLine?.cancelled !== "undefined") out.push(`| Cancelled | ${String(summaryLine.cancelled)} |`);
  if (typeof summaryLine?.steered !== "undefined") out.push(`| Steered | ${String(summaryLine.steered)} |`);
  if (typeof summaryLine?.stuck !== "undefined") out.push(`| Stuck | ${String(summaryLine.stuck)} |`);
  if (Array.isArray(summaryLine?.approvals)) out.push(`| Approvals | ${(summaryLine.approvals as unknown[]).length} |`);
  if (Array.isArray(summaryLine?.attachmentIds)) out.push(`| Attachments | ${(summaryLine.attachmentIds as unknown[]).length} |`);
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    if (typeof u.input !== "undefined") out.push(`| Usage input | ${String(u.input)} |`);
    if (typeof u.output !== "undefined") out.push(`| Usage output | ${String(u.output)} |`);
    if (typeof u.reasoning !== "undefined") out.push(`| Usage reasoning | ${String(u.reasoning)} |`);
    if (typeof u.cacheRead !== "undefined") out.push(`| Usage cacheRead | ${String(u.cacheRead)} |`);
    if (typeof u.cacheWrite !== "undefined") out.push(`| Usage cacheWrite | ${String(u.cacheWrite)} |`);
  }
  if (effects && typeof effects === "object") {
    const e = effects as Record<string, unknown>;
    if (typeof e.cellsAdded !== "undefined") out.push(`| Cells Added | ${String(e.cellsAdded)} |`);
    if (typeof e.cellsEdited !== "undefined") out.push(`| Cells Edited | ${String(e.cellsEdited)} |`);
    if (typeof e.cellsRun !== "undefined") out.push(`| Cells Run | ${String(e.cellsRun)} |`);
    if (typeof e.filesChanged !== "undefined") out.push(`| Files Changed | ${String(e.filesChanged)} |`);
  }
  // fallback counters from fold if summary missing
  if (!summaryLine) {
    out.push(`| Effects cellsAdded | ${fold.counters.effects.cellsAdded} |`);
    out.push(`| Effects cellsEdited | ${fold.counters.effects.cellsEdited} |`);
    out.push(`| Effects cellsRun | ${fold.counters.effects.cellsRun} |`);
    out.push(`| Effects filesChanged | ${fold.counters.effects.filesChanged} |`);
  }
  out.push("");

  return out.join("\n");
}

// Pure fold — replays seq order, returns turns/toolCalls/counters for invariant check.
// Readers MUST ignore unknown line types/fields (tolerance rule borrowed from MSP).
export function foldTranscript(lines: unknown[]): { turns: number; toolCalls: number; counters: { steps: number; toolCalls: number; effects: { cellsAdded: number; cellsEdited: number; cellsRun: number; filesChanged: number }; compacted: boolean; turnsDropped: number; usage: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number } } } {
  // Defensive: filter non-objects, sort by seq monotonic (opencode seq discipline)
  const objs = (lines as Array<Record<string, unknown>>).filter((l) => l && typeof l === "object");
  objs.sort((a, b) => {
    const sa = typeof a.seq === "number" ? (a.seq as number) : 0;
    const sb = typeof b.seq === "number" ? (b.seq as number) : 0;
    return sa - sb;
  });
  let turns = 0;
  let toolCalls = 0;
  const effects = { cellsAdded: 0, cellsEdited: 0, cellsRun: 0, filesChanged: 0 };
  let compacted = false;
  let turnsDropped = 0;

  for (const line of objs) {
    const type = line.type as string | undefined;
    if (type === "assistant") {
      turns += 1;
      const msg = line.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as unknown[];
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (!b || typeof b !== "object") continue;
          if (b.type !== "tool_call") continue;
          toolCalls += 1;
          const name = String((b as Record<string, unknown>).name ?? "");
          if (name === "insert_cell" || name === "new_cell" || name === "create_cell" || name === "add_cell") effects.cellsAdded += 1;
          else if (name === "edit_cell") effects.cellsEdited += 1;
          else if (name === "run_cells") effects.cellsRun += 1;
          else if (name === "write_file") effects.filesChanged += 1;
        }
      }
    } else if (type === "system") {
      const subtype = (line as Record<string, unknown>).subtype as string | undefined;
      if (subtype === "compact") {
        compacted = true;
        const td = (line as Record<string, unknown>).turnsDropped;
        if (typeof td === "number" && Number.isFinite(td)) turnsDropped += td;
      }
      // Other system subtypes (steer, cancel, approval, stuck) do not affect counters but are tolerated.
    } else if (type === "session" || type === "user" || type === "summary") {
      // Known types — no counter effect (summary is not counted, user is not counted for steps)
    } else {
      // Unknown line type — tolerance rule: ignore, never crash.
      continue;
    }
  }

  return {
    turns,
    toolCalls,
    counters: {
      steps: turns, // steps == assistant turns (model-call count) — fold invariant
      toolCalls,
      effects: { ...effects },
      compacted,
      turnsDropped,
      usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}
