import { unsafeMarkup } from "@scriptorium/core";

export interface LintFinding {
  code: string;
  severity: "error" | "warn";
  message: string;
}

export const PLACEHOLDER_PATTERN = /\b(TODO|TBD|FIXME|lorem ipsum|xxx)\b|\[placeholder\]/i;
const REQUIRED_SECTIONS = ["## Overview", "## Steps"];

// House glossary (Beacon's style guide) — banned term -> preferred term.
const GLOSSARY: Record<string, string> = {
  whitelist: "allowlist",
  blacklist: "blocklist",
  "e-mail": "email",
  downtime: "maintenance window",
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deterministic checks run before any human sees a draft — machines gate what machines can gate. */
export function lintDoc(markdown: string): LintFinding[] {
  const findings: LintFinding[] = [];

  if (!/^#\s+\S/m.test(markdown)) {
    findings.push({ code: "missing-title", severity: "error", message: "Document must start with an H1 title." });
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!markdown.includes(section)) {
      findings.push({ code: "missing-section", severity: "error", message: `Required section not found: ${section}` });
    }
  }

  const placeholder = markdown.match(PLACEHOLDER_PATTERN);
  if (placeholder) {
    findings.push({ code: "placeholder", severity: "error", message: `Placeholder text found: "${placeholder[0]}"` });
  }

  // What a published page would run: raw HTML, and links that don't go to the web. The
  // Jira reviewer sees only a link's label, so a `javascript:` target was approved unseen.
  const unsafe = unsafeMarkup(markdown);
  if (unsafe.html.length) {
    findings.push({ code: "raw-html", severity: "error", message: `Raw HTML isn't allowed in a doc: ${unsafe.html.join(", ")}. Write it as markdown.` });
  }
  if (unsafe.links.length) {
    findings.push({ code: "unsafe-link", severity: "error", message: `Links must go to http(s) or mailto, not ${unsafe.links.map((scheme) => `${scheme}:`).join(", ")}.` });
  }
  if (unsafe.tooCostly) {
    findings.push({ code: "too-costly", severity: "error", message: `This doc would be published as a code block: ${unsafe.tooCostly}.` });
  }

  for (const [banned, preferred] of Object.entries(GLOSSARY)) {
    if (new RegExp(`\\b${escapeRegex(banned)}\\b`, "i").test(markdown)) {
      findings.push({ code: "glossary", severity: "error", message: `Use "${preferred}" instead of "${banned}".` });
    }
  }

  return findings;
}

export function lintOk(findings: LintFinding[]): boolean {
  return findings.every((finding) => finding.severity !== "error");
}

export function formatLintFindings(findings: LintFinding[]): string {
  if (!findings.length) return "✅ lint clean";
  return findings.map((f) => `${f.severity === "error" ? "🚫" : "⚠️"} [${f.code}] ${f.message}`).join("\n");
}
