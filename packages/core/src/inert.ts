/**
 * Markdown made safe to render as a web page, without changing what it says.
 *
 * The vault is published as two sites. Both render raw HTML in markdown, and both turn a
 * link into an `href` whatever its scheme. Text nobody vouched for reaches the vault: a
 * question someone typed (a gap note), a PRD attached to a ticket, a draft a model wrote.
 * So an `<img onerror=…>` in a question ran as script on the internal site, and a
 * `[guide](javascript:…)` in a draft went live on both sites.
 *
 * Outside code, a `<` that would open a tag is written as `&lt;` (it still reads as `<`),
 * and a link to anything but http(s), mailto or a relative path loses its target. Code
 * blocks and code spans are left exactly as they are: markdown never renders them as HTML.
 */
export function inertMarkdown(markdown: string): string {
  return splitCode(markdown)
    .map((part) => (part.code ? part.text : inertProse(part.text)))
    .join("");
}

/** The two things a renderer would act on: a tag opener, and a link target with a dangerous scheme. */
function inertProse(text: string): string {
  return text
    // An autolink to the web (`<https://…>`) is a link, not a tag: it stays.
    .replace(/<(?=[A-Za-z!/?])(?!(?:https?|mailto):)/gi, "&lt;")
    .replace(/\]\(\s*<?([a-z][a-z0-9+.-]*):/gi, (match, scheme: string) => (SAFE_SCHEMES.has(scheme.toLowerCase()) ? match : "](#unsafe-link-removed:"));
}

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

/** Fenced blocks and inline code spans, kept apart from the prose around them. */
function splitCode(markdown: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const code = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|`+[^`\n]*?`+/g;
  let last = 0;
  for (const match of markdown.matchAll(code)) {
    if (match.index > last) parts.push({ code: false, text: markdown.slice(last, match.index) });
    parts.push({ code: true, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < markdown.length) parts.push({ code: false, text: markdown.slice(last) });
  return parts;
}

/** What a draft must not contain, for lint: raw HTML tags and links that aren't to the web. */
export function unsafeMarkup(markdown: string): { html: string[]; links: string[] } {
  const prose = splitCode(markdown)
    .filter((part) => !part.code)
    .map((part) => part.text)
    .join("\n");
  // A tag closes on its line (`<img src=x>`, `</div>`); `x<y and` is prose, not a tag.
  const html = [...prose.matchAll(/<(!--|\/?[A-Za-z][\w-]*)(?:\s[^<>\n]*)?\/?>/g)].filter((match) => !/^(https?|mailto):/i.test(match[1] ?? "")).map((match) => `<${match[1]}`);
  const links = [...prose.matchAll(/\]\(\s*<?([a-z][a-z0-9+.-]*):/gi)].map((match) => match[1] as string).filter((scheme) => !SAFE_SCHEMES.has(scheme.toLowerCase()));
  return { html: [...new Set(html)], links: [...new Set(links)] };
}
