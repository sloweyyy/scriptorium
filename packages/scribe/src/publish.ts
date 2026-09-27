import { audit, commitVault, parseMarkdown, slugify, sourceHash, type Vault } from "@scriptorium/core";

async function prdHash(vault: Vault, sourcePrd: string | undefined): Promise<string | undefined> {
  if (!sourcePrd) return undefined;
  const relPath = `${sourcePrd.replace(/\.md$/, "")}.md`;
  if (!(await vault.exists(relPath))) return undefined;
  return sourceHash((await vault.readNote(relPath)).body);
}

export interface PublishInput {
  vault: Vault;
  auditFile: string;
  repoRoot: string;
  markdown: string;
  approvedBy: string;
  /**
   * The Jira issue this doc was approved on. Written as `jira_issue` frontmatter: it is the
   * join key for the round trip — a human edit landing in the docs repo has to be reported
   * back onto the ticket that produced the doc, and `source` is the PRD wikilink, not a key.
   * Optional so the existing call site keeps compiling while the Jira flow is wired up.
   */
  jiraIssue?: string;
  sourcePrd?: string;
  appliedLessons?: string[];
  slug?: string;
}

/**
 * The only way a doc reaches the vault. Fail-closed by construction:
 * this function is called from the approval handler and nowhere else.
 */
export async function publishDoc(input: PublishInput): Promise<string> {
  const { body } = parseMarkdown(input.markdown);
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "untitled";
  const slug = input.slug ?? slugify(title);
  const relPath = `docs/${slug}.md`;

  await input.vault.writeNote(relPath, body, {
    kind: "doc",
    status: "published",
    // `title` as well as `feature`: static-site generators require it (Starlight fails the
    // build without one), and a published doc with no title is unrenderable anywhere.
    title,
    feature: title,
    jira_issue: input.jiraIssue,
    source: input.sourcePrd ? `[[${input.sourcePrd}]]` : undefined,
    applied_lessons: input.appliedLessons?.length ? input.appliedLessons : undefined,
    approved_by: input.approvedBy,
    published_at: new Date().toISOString(),
    // The baseline staleness is measured against. Stripped from the public site.
    source_hash: await prdHash(input.vault, input.sourcePrd),
  });

  await audit(input.auditFile, {
    type: "doc.published",
    actor: input.approvedBy,
    relPath,
    jiraIssue: input.jiraIssue,
    sourcePrd: input.sourcePrd,
    appliedLessons: input.appliedLessons ?? [],
  });
  await commitVault(input.repoRoot, `docs: publish ${slug} (approved by ${input.approvedBy})`);

  return relPath;
}
