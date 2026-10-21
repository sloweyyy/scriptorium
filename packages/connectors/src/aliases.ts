import { keys } from "@scriptorium/runtime";

/**
 * The conversation aliases a tool call created, read from the tool's OWN output — the line it
 * builds after the write landed — never from the model's input or from content it fetched.
 * Fed from `GuardDeps.onRan`, which only fires after a call actually ran, so an alias is
 * bound only as the side effect of a real action.
 *
 * Anything else — a refusal (`NOT_ALLOWED: …`), an unknown tool, an issue key that merely
 * appears somewhere in the text — yields nothing.
 */
export function aliasesFromResult(tool: string, output: string): string[] {
  if (tool === "jira_create_issue") {
    // jira.ts builds it: `${replayed ? "Already created" : "Created"} jira:${key} ${url}`
    const created = /^(?:Created|Already created) jira:([A-Z][A-Z0-9_]*-\d+) \S+$/.exec(output.split("\n", 1)[0] ?? "");
    return created ? [keys.jiraIssue(created[1] as string)] : [];
  }
  return [];
}
