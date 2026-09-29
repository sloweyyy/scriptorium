import { createHmac } from "node:crypto";
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

/**
 * A link that opens ONE run. Replies used to carry the viewer's global token, so anyone who
 * could read one reply in Slack held the key to every run: other people's questions, DMs,
 * tool calls. A reply now carries this signature of its own run id, and nothing else opens.
 */
export function runLinkSignature(secret: string, runId: string): string {
  return createHmac("sha256", secret).update(`scriptorium-run:${runId}`).digest("hex").slice(0, 32);
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

/**
 * Answers people flagged with 👎, joined to the run that produced each one: the review queue
 * for new answer golden cases. Only pointers are kept (channel, message ts, run, who), never
 * the Slack text: `pnpm trace <run>` shows what the run did. Newest first; one entry per
 * answer, however many people flagged it or how often.
 */
export interface FeedbackCandidate {
  run?: string;
  channel: string;
  message: string;
  answeredAt?: string;
  /** What the flagged reply was: answer, gap, refused… */
  kind?: string;
  flaggedBy: string[];
  lastFlagged: string;
}

export function feedbackCandidates(lines: readonly AuditLine[]): FeedbackCandidate[] {
  const answers = new Map<string, AuditLine>();
  const flagged = new Map<string, FeedbackCandidate>();
  const at = (line: AuditLine) => `${String(line.channel)}/${String(line.message)}`;
  for (const line of lines) {
    if (typeof line.channel !== "string" || typeof line.message !== "string") continue;
    if (line.type !== "teammate.feedback") {
      if (line.type.startsWith("teammate.")) answers.set(at(line), line);
      continue;
    }
    const entry = flagged.get(at(line)) ?? { channel: line.channel, message: line.message, flaggedBy: [], lastFlagged: line.ts };
    const by = String(line.by);
    if (!entry.flaggedBy.includes(by)) entry.flaggedBy.push(by);
    entry.lastFlagged = line.ts;
    flagged.set(at(line), entry);
  }
  return [...flagged.entries()]
    .map(([key, entry]) => {
      const answer = answers.get(key);
      return answer ? { ...entry, ...(answer.run ? { run: answer.run } : {}), answeredAt: answer.ts, kind: answer.type.slice("teammate.".length) } : entry;
    })
    .sort((a, b) => b.lastFlagged.localeCompare(a.lastFlagged));
}

/**
 * `/metrics`: Prometheus text, derived from the audit log so it survives a restart and can't
 * disagree with the record. Event counts by type, and tokens by kind. Only type names and
 * numbers: never a question, a channel or a person, so a scraper learns how busy it is and
 * how it fails, not who asked what.
 */
export function auditMetrics(lines: readonly AuditLine[]): string {
  const events = new Map<string, number>();
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const line of lines) {
    // Type names are code, but the log is a file: keep a label to what Prometheus allows.
    const type = line.type.replace(/[^\w.:-]/g, "_").slice(0, 80);
    events.set(type, (events.get(type) ?? 0) + 1);
    if (line.type !== "llm.usage") continue;
    for (const kind of Object.keys(tokens) as Array<keyof typeof tokens>) {
      const value = line[kind];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) tokens[kind] += value;
    }
  }
  const out = [
    "# HELP scriptorium_audit_events_total Audit log events, by type.",
    "# TYPE scriptorium_audit_events_total counter",
    ...[...events.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => `scriptorium_audit_events_total{type="${type}"} ${count}`),
    "# HELP scriptorium_llm_tokens_total Model tokens, by kind.",
    "# TYPE scriptorium_llm_tokens_total counter",
    ...Object.entries(tokens).map(([kind, count]) => `scriptorium_llm_tokens_total{kind="${kind}"} ${count}`),
  ];
  return `${out.join("\n")}\n`;
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
