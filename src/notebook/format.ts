// JupiBuddy artifact mime helpers — ported from jupyter-vscode-mcp v1.0.0 (MIT)
// Original: jupyter-vscode-mcp src/format.ts:18-39
// Preserved under MIT license (Copyright (c) 2026 hadiproz)

export function extensionForMime(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/svg+xml") return ".svg";
  if (mime === "text/html") return ".html";
  if (mime === "text/plain") return ".txt";
  if (mime === "application/json") return ".json";
  if (mime === "application/vnd.code.notebook.error") return ".json";
  if (mime === "application/vnd.code.notebook.stdout") return ".txt";
  if (mime === "application/vnd.code.notebook.stderr") return ".txt";
  if (mime === "application/pdf") return ".pdf";
  return ".bin";
}

export function isTextLikeMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/vnd.code.notebook.stdout" ||
    mime === "application/vnd.code.notebook.stderr" ||
    mime === "application/vnd.code.notebook.error"
  );
}
