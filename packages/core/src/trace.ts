/**
 * Reading the audit log back, by run. Shared by `pnpm trace` and the run viewer, so the
 * terminal and the browser can never disagree about what a run did.
 */
export interface AuditLine {
  ts: string;
  run?: string;
  type: string;
  [key: string]: unknown;
}

/** One JSON object per line; a torn or foreign line is skipped, never fatal. */
export function parseAudit(text: string): AuditLine[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as AuditLine;
        return parsed && typeof parsed.type === "string" ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

export function linesForRun(lines: readonly AuditLine[], prefix: string): AuditLine[] {
  // An empty prefix would match every run: a viewer must never become "show me everything".
  if (prefix.length < 6) return [];
  return lines.filter((line) => line.run?.startsWith(prefix));
}

export function recentRuns(lines: readonly AuditLine[], limit = 10): Array<{ run: string; started: string; events: number; last: string }> {
  const runs = new Map<string, { run: string; started: string; events: number; last: string }>();
  for (const line of lines) {
    if (!line.run) continue;
    const entry = runs.get(line.run) ?? { run: line.run, started: line.ts, events: 0, last: line.type };
    entry.events += 1;
    entry.last = line.type;
    runs.set(line.run, entry);
  }
  return [...runs.values()].sort((a, b) => b.started.localeCompare(a.started)).slice(0, limit);
}

export function formatLine(line: AuditLine): string {
  const { ts, run: _run, type, ...rest } = line;
  const detail = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return `${ts}  ${type.padEnd(28)} ${detail}`;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] as string);
}

/** A run as a self-contained HTML page. Every value is escaped: audit lines hold user text. */
export function runPage(prefix: string, lines: readonly AuditLine[]): string {
  const rows = lines
    .map((line) => {
      const { ts, run: _run, type, ...rest } = line;
      const detail = Object.entries(rest)
        .map(([key, value]) => `<b>${escapeHtml(key)}</b> ${escapeHtml(typeof value === "string" ? value : JSON.stringify(value))}`)
        .join("<br>");
      return `<tr><td>${escapeHtml(ts)}</td><td><code>${escapeHtml(type)}</code></td><td>${detail}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>run ${escapeHtml(prefix)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#1b1b1b}table{border-collapse:collapse;width:100%}td{border-top:1px solid #ddd;padding:6px 8px;vertical-align:top}code{background:#f3f3f3;padding:1px 4px}</style></head>
<body><h1>Run <code>${escapeHtml(prefix)}</code></h1><p>${lines.length} event(s), from the append-only audit log.</p>
<table>${rows || "<tr><td>No events for this run.</td></tr>"}</table></body></html>`;
}
