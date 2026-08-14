import { parseMarkdown, type Frontmatter } from "@scriptorium/core";

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

export interface ContractResult {
  ok: boolean;
  missing: ContractField[];
  frontmatter: Frontmatter;
  body: string;
}

export function checkContract(prdMarkdown: string): ContractResult {
  const { frontmatter, body } = parseMarkdown(prdMarkdown);
  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = frontmatter[field.key];
    return value === undefined || value === null || String(value).trim() === "";
  });
  return { ok: missing.length === 0, missing, frontmatter, body };
}

export function formatContractQuestions(result: ContractResult): string {
  return result.missing.map((field) => `• *${field.key}* — ${field.question}`).join("\n");
}
