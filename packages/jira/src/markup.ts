/**
 * Markdown <-> Jira wiki markup.
 *
 * REST v2 comment bodies are wiki markup, so a draft written in markdown has to be
 * translated before a human reads it in the ticket — and a PRD typed into Jira's editor
 * comes back as wiki markup, so it has to be translated the other way before the input
 * contract (YAML frontmatter) can be parsed.
 */

const BLOCK_TOKEN = (index: number): string => `@@SCRIPTORIUM_BLOCK_${index}@@`;
const BLOCK_PATTERN = /@@SCRIPTORIUM_BLOCK_(\d+)@@/g;
const BOLD_TOKEN = "@@SCRIPTORIUM_BOLD@@";

function protect(blocks: string[], rendered: string): string {
  const token = BLOCK_TOKEN(blocks.length);
  blocks.push(rendered);
  return token;
}

function restore(text: string, blocks: string[]): string {
  return text.replace(BLOCK_PATTERN, (_match, index: string) => blocks[Number(index)] ?? "");
}

function listPrefix(marker: string, indent: string): string {
  // Two spaces of markdown indent == one level of Jira nesting.
  const depth = Math.floor(indent.replace(/\t/g, "  ").length / 2) + 1;
  return marker.repeat(depth);
}

/** Markdown -> Jira wiki markup. Code, images and links are protected before anything else runs. */
export function markdownToJira(markdown: string): string {
  const blocks: string[] = [];
  let text = markdown.replace(/\r\n/g, "\n");

  // 1. Fenced code first: nothing inside it may be transformed or escaped.
  text = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_match, language: string, code: string) =>
    protect(blocks, `{code${language ? `:${language}` : ""}}\n${code.replace(/\n+$/, "")}\n{code}`),
  );
  // 2. Inline code.
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => protect(blocks, `{{${code}}}`));
  // 3. Images and links, before bracket escaping would eat them.
  text = text.replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, (_match, source: string) => protect(blocks, `!${source}!`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_match, label: string, href: string) =>
    protect(blocks, `[${label}|${href}]`),
  );

  // 4. Escape the characters that would otherwise open a Jira macro or link.
  text = text.replace(/([{}[\]])/g, "\\$1");

  // 5. Block structure, line by line.
  text = text
    .split("\n")
    .map((line) => {
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading?.[1] && heading[2] !== undefined) return `h${heading[1].length}. ${heading[2]}`;

      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (bullet?.[2] !== undefined) return `${listPrefix("*", bullet[1] ?? "")} ${bullet[2]}`;

      const numbered = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      if (numbered?.[2] !== undefined) return `${listPrefix("#", numbered[1] ?? "")} ${numbered[2]}`;

      const quote = line.match(/^>\s?(.*)$/);
      if (quote?.[1] !== undefined) return `bq. ${quote[1]}`;

      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) return "----";
      return line;
    })
    .join("\n");

  // 6. Emphasis: bold is parked on a token first, or ** would be read as two italics.
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, `${BOLD_TOKEN}$1${BOLD_TOKEN}`)
    .replace(/__([^_\n]+)__/g, `${BOLD_TOKEN}$1${BOLD_TOKEN}`)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1_$2_")
    .split(BOLD_TOKEN)
    .join("*");

  return restore(text, blocks);
}

/** Jira wiki markup -> markdown. Enough to recover a PRD typed straight into the Jira editor. */
export function jiraToMarkdown(wiki: string): string {
  const blocks: string[] = [];
  let text = wiki.replace(/\r\n/g, "\n");

  text = text.replace(/\{(?:code|noformat)(?::[^}]*)?\}\n?([\s\S]*?)\{(?:code|noformat)\}/g, (_match, code: string) =>
    protect(blocks, ["```", code.replace(/\n+$/, ""), "```"].join("\n")),
  );
  text = text.replace(/\{\{([^}]+)\}\}/g, (_match, code: string) => protect(blocks, `\`${code}\``));

  text = text
    .split("\n")
    .map((line) => {
      const heading = line.match(/^h([1-6])\.\s+(.*)$/);
      if (heading?.[1] && heading[2] !== undefined) return `${"#".repeat(Number(heading[1]))} ${heading[2]}`;

      const bullet = line.match(/^(\*+)\s+(.*)$/);
      if (bullet?.[1] && bullet[2] !== undefined) return `${"  ".repeat(bullet[1].length - 1)}- ${bullet[2]}`;

      const numbered = line.match(/^(#+)\s+(.*)$/);
      if (numbered?.[1] && numbered[2] !== undefined) return `${"  ".repeat(numbered[1].length - 1)}1. ${numbered[2]}`;

      // Jira renders a markdown `---` frontmatter fence as `----`; put it back.
      if (/^-{3,}$/.test(line.trim())) return "---";
      return line.replace(/^bq\.\s?/, "> ");
    })
    .join("\n");

  text = text
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, "[$1]($2)")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1**$2**")
    .replace(/\\([{}[\]])/g, "$1");

  return restore(text, blocks);
}
