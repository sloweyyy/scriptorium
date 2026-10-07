import { parseMarkdown, type Frontmatter } from "@scriptorium/core";
import { PLACEHOLDER_PATTERN } from "./lint";

export interface ContractField {
  key: string;
  question: string;
}

/**
 * The input contract: a PRD must answer these before any drafting happens.
 * Rejecting bad input beats prompt-engineering around it.
 */
export const REQUIRED_FIELDS: ContractField[] = [
  { key: "feature", question: "What is the feature called?" },
  { key: "audience", question: "Who is this documentation for (end user, workspace admin, integrator)?" },
  { key: "user_goal", question: "What does the user accomplish with this feature?" },
];

/**
 * How each field may be spelled outside frontmatter. Deliberately tight: a couple of
 * obvious synonyms, not fuzzy matching — the contract exists to force the author to be
 * explicit, and a matcher generous enough to find an "audience" in prose would be
 * guessing with extra steps.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  feature: ["feature", "feature name"],
  audience: ["audience", "target audience"],
  user_goal: ["user_goal", "user goal", "goal"],
};

/** Strip the markdown emphasis a label tends to arrive wrapped in: `**Audience:**` etc. */
function unwrap(text: string): string {
  return text.replace(/^[*_`\s]+|[*_`\s]+$/g, "").trim();
}

/**
 * Find a required field stated in the body rather than in frontmatter.
 *
 * PMs do not write YAML. They write `**Audience:** workspace admins` in the description,
 * or put "Audience" as a heading with the answer underneath — and a contract that
 * rejects those is testing whether the author knows our file format, not whether the
 * PRD answers the question. Two shapes are accepted:
 *
 *   - a labeled line: `audience: workspace admins` (label optionally bolded/italicised)
 *   - a heading: `## Audience` followed by its first non-empty line
 *
 * Anything else stays missing, and the agent asks. Fail-closed is unchanged; only the
 * spelling of "present" got wider.
 */
function findInBody(body: string, key: string): string | undefined {
  const aliases = FIELD_ALIASES[key] ?? [key];
  const lines = body.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    // `**Audience:** workspace admins` / `audience — admins` / `Audience: admins`
    const labeled = line.match(/^\s*(?:[-*•]\s*)?([*_`]*[\w ][\w /()-]*?[*_`]*)\s*(?::|—|–)\s*(.+)$/);
    if (labeled?.[1] && labeled[2]) {
      const label = unwrap(labeled[1]).toLowerCase();
      if (aliases.includes(label)) {
        const value = unwrap(labeled[2]);
        if (value) return value;
      }
    }

    // `## Audience` (or bold-line pseudo-heading) followed by its first non-empty line.
    const heading = line.match(/^\s*(?:#{1,6}\s+|\*\*)?([\w ][\w /()-]*?)(?:\*\*)?\s*$/);
    if (heading?.[1] && aliases.includes(unwrap(heading[1]).toLowerCase())) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = (lines[next] ?? "").trim();
        if (!candidate) continue;
        if (/^#{1,6}\s/.test(candidate)) break; // the section was empty
        return unwrap(candidate.replace(/^[-*•]\s*/, ""));
      }
    }
  }
  return undefined;
}

export interface ContractResult {
  ok: boolean;
  missing: ContractField[];
  frontmatter: Frontmatter;
  body: string;
}

/**
 * A value that says something. `audience: TBD` is the author saying they haven't decided,
 * and drafting from it means guessing the audience: the very thing the contract exists to
 * stop. Lint already bans these words in a draft; the PRD that feeds it can't use them as
 * an answer either.
 */
function answered(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || PLACEHOLDER_PATTERN.test(trimmed)) return false;
  return !/^(n\/?a|none|unknown|tbc|\?+|-+|—|…|\.{2,})$/i.test(trimmed);
}

export function checkContract(prdMarkdown: string): ContractResult {
  const { frontmatter, body } = parseMarkdown(prdMarkdown);

  // Fields found in the body are folded into the frontmatter, so everything downstream
  // (the feature name, the slug, the seeded vault note) sees one answer regardless of
  // where the author put it.
  const resolved: Frontmatter = { ...frontmatter };
  const missing = REQUIRED_FIELDS.filter((field) => {
    const declared = resolved[field.key];
    if (declared !== undefined && declared !== null && answered(String(declared))) return false;
    const found = findInBody(body, field.key);
    if (found && answered(found)) {
      resolved[field.key] = found;
      return false;
    }
    return true;
  });

  return { ok: missing.length === 0, missing, frontmatter: resolved, body };
}

export function formatContractQuestions(result: ContractResult): string {
  return result.missing.map((field) => `• *${field.key}* — ${field.question}`).join("\n");
}
