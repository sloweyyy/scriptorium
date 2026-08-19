/** Strip the leading <@BOTID> mention (and any stray mentions) from an app_mention text. */
export function stripMentions(text: string | undefined): string {
  return (text ?? "").replace(/<@[^>]+>/g, "").trim();
}

/** Pull PRD source out of a message: prefer a fenced block, else everything after the command word. */
export function extractPrdText(text: string): string | undefined {
  const fenced = text.match(/```(?:markdown|md|yaml)?\n?([\s\S]*?)```/);
  if (fenced?.[1]?.trim()) return fenced[1].trim();
  if (/^---\n/m.test(text)) return text.replace(/^\s*\w+\b/, "").trim();
  return undefined;
}
