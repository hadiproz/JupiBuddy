// Minimal MCP endpoint (JSON-RPC over HTTP POST /mcp).
//
// Protocol version + negotiation — see comment block below.
// Stage 1 scope: initialize, ping, tools/list, tools/call — enough for an
// agent harness to drive the notebook. The authoritative protocol reference
// is the pinned modelcontextprotocol spec + typescript-sdk trees
// (SOURCES.md §2); harden this handler against them before exposing
// sessions, streaming, or notifications.

/*
 * Declared version: 2025-11-25
 *
 * Why: docs/specification/2025-11-25/basic/lifecycle.mdx still defines the
 *   initialize handshake (client MUST send initialize with protocolVersion,
 *   server MUST echo supported version or counter-offer). The next revision
 *   docs/specification/2026-07-28/changelog.mdx §Major change 2 (SEP-2575)
 *   and docs/specification/2026-07-28/basic/versioning.mdx ("There is no
 *   negotiation handshake. Every request carries its protocol version")
 *   removes the handshake entirely and introduces per-request _meta +
 *   server/discover. Versioning Terminology classifies 2025-11-25 and earlier
 *   as "Legacy" (handshake) and 2026-07-28+ as "Modern". SEP-2596 only
 *   deprecated HTTP+SSE / includeContext values (see
 *   docs/specification/2026-07-28/deprecated.mdx), not the handshake — so
 *   bumping to 2025-11-25 keeps the handshake without a transport change.
 *   No Streamable HTTP was added; scope is negotiation only.
 *
 * Future bump to 2026-07-28 requires: remove initialize handshake per
 *   versioning.mdx Backward Compatibility + changelog SEP-2575, add per-request
 *   _meta envelope (protocolVersion/clientCapabilities/clientInfo), implement
 *   server/discover, handle UnsupportedProtocolVersionError code -32022,
 *   add Streamable HTTP header validation (Mcp-Protocol-Version), and mirror
 *   the dual-era era-selection shape in typescript-sdk
 *   packages/core/src/constants.ts (SUPPORTED_PROTOCOL_VERSIONS vs
 *   SUPPORTED_MODERN_PROTOCOL_VERSIONS) and
 *   packages/core-internal/src/shared/protocolEras.ts (legacyProtocolVersions
 *   / modernProtocolVersions / isModernProtocolVersion) — never copy code.
 */

import { callTool, type ToolDef } from "./tools";
import type { NotebookService } from "../notebook/service";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export const PROTOCOL_VERSION = "2025-11-25";

// All legacy revisions this server accepts via initialize. Ordered newest-first
// so index 0 is the latest (counter-offer target). Mirrors the shape of
// typescript-sdk packages/core/src/constants.ts SUPPORTED_PROTOCOL_VERSIONS
// but scoped to what this plain-TS server actually serves.
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

const FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";

function isModernVersion(v: string): boolean {
  return v >= FIRST_MODERN_PROTOCOL_VERSION;
}

export function createMcpHandler(tools: ToolDef[], service?: NotebookService) {
  return async (req: Request): Promise<Response> => {
    let body: JsonRpcRequest;
    try {
      body = (await req.json()) as JsonRpcRequest;
    } catch {
      return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }, { status: 500 });
    }

    const { id, method, params } = body;
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string, data?: unknown) =>
      Response.json(
        { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
      );

    switch (method) {
      case "initialize": {
        const requested = typeof params?.protocolVersion === "string" ? (params.protocolVersion as string) : undefined;

        // Missing / non-string → spec-correct Invalid Params per lifecycle.mdx Error Handling
        if (!requested) {
          console.log(`[mcp] initialize rejected: missing protocolVersion (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`);
          return fail(-32602, "Unsupported protocol version", {
            supported: SUPPORTED_PROTOCOL_VERSIONS,
            requested: requested ?? null,
          });
        }

        // Exact match in supported legacy set → echo it (spec: MUST respond with same version)
        if (SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
          console.log(`[mcp] initialize negotiated: requested=${requested} negotiated=${requested}`);
          return reply({
            protocolVersion: requested,
            capabilities: { tools: {} },
            serverInfo: { name: "jupibuddy", version: "0.0.1" },
          });
        }

        // Newer than ours but still legacy-shaped (e.g. 2025-12-01 between 2025-11-25 and 2026-07-28)
        // → downgrade to our latest with a clear note (dual-era shape; never pretend we speak it)
        const isDateLike = /^\d{4}-\d{2}-\d{2}$/.test(requested);
        if (isDateLike && requested > PROTOCOL_VERSION && requested < FIRST_MODERN_PROTOCOL_VERSION) {
          console.log(`[mcp] initialize negotiated: requested=${requested} negotiated=${PROTOCOL_VERSION} (downgrade)`);
          return reply({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "jupibuddy", version: "0.0.1" },
            note: `Requested protocolVersion ${requested} not supported; negotiated to ${PROTOCOL_VERSION}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}. See docs/specification/2026-07-28/basic/versioning.mdx`,
          });
        }

        // Older than our oldest, modern (>=2026-07-28) via initialize, or unknown/bogus
        // → honest spec-correct error per lifecycle.mdx Error Handling (-32602)
        console.log(`[mcp] initialize rejected: requested=${requested} supported=${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`);
        return fail(-32602, "Unsupported protocol version", {
          supported: SUPPORTED_PROTOCOL_VERSIONS,
          requested,
        });
      }
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        const name = String(params?.name ?? "");
        const args = (params?.arguments ?? {}) as Record<string, never>;
        if (!tools.some((t) => t.name === name)) {
          return fail(-32602, `Unknown tool: ${name}`);
        }
        try {
          if (service) {
            try {
              const result = await service.enqueue("external-agent", () => callTool(tools, name, args));
              if ((result as { isError?: boolean })?.isError) {
                const msg = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "tool error";
                return fail(-32603, msg);
              }
              return reply(result);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (msg.includes("gated")) {
                return reply({
                  content: [{ type: "text", text: JSON.stringify({ ok: false, error: msg, gated: true }) }],
                  isError: true,
                });
              }
              return fail(-32603, msg);
            }
          }
          const result = await callTool(tools, name, args);
          if ((result as { isError?: boolean })?.isError) {
            const msg = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "tool error";
            return fail(-32603, msg);
          }
          return reply(result);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(-32603, msg);
        }
      }
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  };
}
