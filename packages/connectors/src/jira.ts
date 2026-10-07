import { createHash } from "node:crypto";
import type { ToolSpec } from "@scriptorium/core";
import { jiraToMarkdown, markdownToJira, type JiraClient } from "@scriptorium/jira";
import { once, opKey, type EffectLedger } from "@scriptorium/runtime";
import { z } from "zod";

/**
 * Jira as tools an agent can hold (ADR-001 slice 4b).
 *
 * Same two rules as Confluence — projects are allow-listed for reads too, and the model
 * supplies words, never JQL — plus the ones writes need:
 *
 * - **Writes are exactly-once.** A comment carries its op-key as an entity property, so a
 *   retry after a crash finds the comment it already made instead of making another.
 * - **Writes are never reachable raw.** These specs are handed to an agent only through
 *   the policy layer's `guard`, where comment/create sit at the `approve` tier by default;
 *   this file does not decide who may write, only how a write is done safely.
 */

export interface JiraToolSettings {
  client: JiraClient;
  /** Project KEYS the agent may read and write. Empty: none. */
  allowedProjects: readonly string[];
  /** Project new issues are created in. Must be one of `allowedProjects`. */
  createProject?: string;
  issueType?: string;
  ledger: EffectLedger;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
/** A Jira label: no spaces (Jira rejects them), bounded. */
const LABEL = z.string().regex(/^[^\s]{1,255}$/, "a label has no spaces");

export class JiraAccessError extends Error {}

export function jiraTools(settings: JiraToolSettings): ToolSpec[] {
  const projects = settings.allowedProjects.map((project) => project.toUpperCase());

  const checkKey = (raw: string): string => {
    const key = raw.trim().toUpperCase();
    if (!ISSUE_KEY.test(key)) throw new JiraAccessError(`"${raw}" is not an issue key.`);
    if (!projects.includes(key.split("-")[0] as string)) throw new JiraAccessError(`${key} is outside the Jira projects this agent may use.`);
    return key;
  };

  const tools: ToolSpec[] = [
    {
      name: "jira_search",
      description: "Search Jira issues (only the projects you are allowed to use) by keywords. Returns keys, summaries and statuses.",
      inputSchema: z.object({ query: z.string().min(1).describe("Keywords, not JQL.") }),
      run: (input) =>
        refusalOr(async () => {
          const { query } = z.object({ query: z.string().min(1) }).parse(input);
          if (!projects.length) throw new JiraAccessError("No Jira projects are allowed for this agent.");
          const jql = `project in (${projects.map(jqlString).join(",")}) AND text ~ ${jqlString(query)} ORDER BY updated DESC`;
          const issues = await settings.client.searchIssues(jql, 10);
          return JSON.stringify(
            issues.map((issue) => ({ cite: `jira:${issue.key}`, key: issue.key, summary: issue.fields.summary, status: issue.fields.status?.name })),
          );
        }),
      records: citeRecords,
    },
    {
      name: "jira_recent",
      description: "List Jira issues updated in the last N days (only the projects you may use), newest first — for digests and status summaries.",
      inputSchema: z.object({ days: z.number().int().min(1).max(14).describe("How far back, 1–14 days.") }),
      run: (input) =>
        refusalOr(async () => {
          const { days } = z.object({ days: z.number().int().min(1).max(14) }).parse(input);
          if (!projects.length) throw new JiraAccessError("No Jira projects are allowed for this agent.");
          // `days` is validated as an integer, so it is safe to place in JQL; nothing else is.
          const jql = `project in (${projects.map(jqlString).join(",")}) AND updated >= -${days}d ORDER BY updated DESC`;
          const issues = await settings.client.searchIssues(jql, RECENT_LIMIT);
          return JSON.stringify([
            ...issues.map((issue) => ({ cite: `jira:${issue.key}`, key: issue.key, summary: issue.fields.summary, status: issue.fields.status?.name, updated: issue.fields.updated })),
            ...cutNote(issues.length, RECENT_LIMIT, "issues updated in that window"),
          ]);
        }),
      records: citeRecords,
    },
    {
      name: "jira_children",
      description: "List the issues under an epic or parent issue (only in projects you may use), with status — for status updates.",
      inputSchema: z.object({ key: z.string().describe("The epic or parent key, e.g. DOC-40.") }),
      run: (input) =>
        refusalOr(async () => {
          const key = checkKey(z.object({ key: z.string() }).parse(input).key);
          // Only a validated, project-checked key reaches the JQL — nothing the model wrote.
          const jql = `project in (${projects.map(jqlString).join(",")}) AND parent = ${jqlString(key)} ORDER BY status ASC, updated DESC`;
          const issues = await settings.client.searchIssues(jql, CHILDREN_LIMIT);
          return JSON.stringify([
            ...issues.map((issue) => ({ cite: `jira:${issue.key}`, key: issue.key, summary: issue.fields.summary, status: issue.fields.status?.name, updated: issue.fields.updated })),
            ...cutNote(issues.length, CHILDREN_LIMIT, "child issues"),
          ]);
        }),
      records: citeRecords,
    },
    {
      name: "jira_sprint",
      description: "List the issues in a project's open sprint(s), with status and assignee — for a sprint report or standup. Only projects you may use.",
      inputSchema: z.object({ project: z.string().describe("Project key, e.g. DOC.") }),
      run: (input) =>
        refusalOr(async () => {
          const project = z.object({ project: z.string() }).parse(input).project.trim().toUpperCase();
          if (!/^[A-Z][A-Z0-9_]*$/.test(project) || !projects.includes(project)) throw new JiraAccessError(`${project} is outside the Jira projects this agent may use.`);
          // Jira Software's openSprints(): no board id to guess, and nothing the model wrote in the JQL.
          const issues = await settings.client.searchIssues(`project = ${jqlString(project)} AND sprint in openSprints() ORDER BY status ASC, updated DESC`, 100);
          if (!issues.length) return `No issues in an open sprint in ${project} (no active sprint, or the project isn't on a Scrum board).`;
          return JSON.stringify([
            ...issues.map((issue) => ({
              cite: `jira:${issue.key}`,
              key: issue.key,
              summary: issue.fields.summary,
              status: issue.fields.status?.name,
              assignee: issue.fields.assignee?.displayName ?? "unassigned",
              updated: issue.fields.updated,
            })),
            // A report on the first 100 that says nothing of the rest would read as the whole sprint.
            ...(issues.length >= 100 ? [{ note: "Showing the first 100 issues in the sprint; there may be more. Say so in the report." }] : []),
          ]);
        }),
      records: citeRecords,
    },
    {
      name: "jira_get_issue",
      description: "Read one Jira issue: summary, status, description and its latest comments. Cite it as [[jira:<KEY>]].",
      inputSchema: z.object({ key: z.string().describe("Issue key, e.g. DOC-7.") }),
      run: (input) =>
        refusalOr(async () => {
          const key = checkKey(z.object({ key: z.string() }).parse(input).key);
          const issue = await settings.client.getIssue(key);
          const comments = (await settings.client.listComments(key)).slice(-5);
          return [
            `jira:${key} — ${issue.fields.summary} [${issue.fields.status?.name ?? "unknown status"}]`,
            "",
            jiraToMarkdown(issue.fields.description ?? "") || "_(no description)_",
            ...(comments.length ? ["", "Latest comments:", ...comments.map((comment) => `- ${comment.author?.displayName ?? "someone"}: ${jiraToMarkdown(comment.body).slice(0, 500)}`)] : []),
          ].join("\n");
        }),
      records: (input, output) => {
        const key = typeof (input as { key?: unknown })?.key === "string" ? String((input as { key: string }).key).trim().toUpperCase() : "";
        return key && output.startsWith(`jira:${key} — `) ? [`jira:${key}`] : [];
      },
    },
    {
      name: "jira_comment",
      description: "Add a comment to a Jira issue. Requires human approval; it is not done until approved.",
      inputSchema: z.object({ key: z.string(), body: z.string().min(1).describe("Markdown.") }),
      run: (input, context) =>
        refusalOr(async () => {
          const parsed = z.object({ key: z.string(), body: z.string().min(1) }).parse(input);
          const key = checkKey(parsed.key);
          // The approval is part of the cause: two separately approved identical comments are
          // two comments. A retry of ONE approval keeps the same op, and stays a replay.
          const op = opKey("jira.comment", key, digest(parsed.body), context?.approval?.id);
          const { result, replayed } = await once(
            settings.ledger,
            op,
            async () => (await settings.client.addComment(key, markdownToJira(parsed.body), { op })).id,
            { probe: async () => (await settings.client.findCommentByOp(key, op))?.id, meta: { tool: "jira_comment", key } },
          );
          return `${replayed ? "Already commented" : "Commented"} on jira:${key} (comment ${result}).`;
        }),
    },
    {
      name: "jira_transition",
      description: "Move a Jira issue to another status (by the status or transition name, e.g. \"In Review\"). Requires human approval; it is not done until approved.",
      inputSchema: z.object({ key: z.string(), status: z.string().min(1).max(60) }),
      run: (input, context) =>
        refusalOr(async () => {
          const parsed = z.object({ key: z.string(), status: z.string().min(1).max(60) }).parse(input);
          const key = checkKey(parsed.key);
          // Idempotent: moving to the status it is already in is not a second move. No probe needed.
          const { result } = await once(settings.ledger, opKey("jira.transition", key, parsed.status.toLowerCase(), context?.approval?.id), () => settings.client.transitionTo(key, parsed.status), {
            meta: { tool: "jira_transition", key },
          });
          if (!result) throw new JiraAccessError(`jira:${key} has no transition to "${parsed.status}" from its current status.`);
          return `Moved jira:${key} to ${parsed.status}.`;
        }),
    },
    {
      name: "jira_assign",
      description: "Assign a Jira issue to a person, by their full Jira display name or email exactly, or \"unassigned\". A partial name is refused: ask who they mean. Requires human approval; it is not done until approved.",
      inputSchema: z.object({ key: z.string(), assignee: z.string().min(1).max(120).describe('Their full Jira display name or email, exactly; or "unassigned".') }),
      run: (input, context) =>
        refusalOr(async () => {
          const parsed = z.object({ key: z.string(), assignee: z.string().min(1).max(120) }).parse(input);
          const key = checkKey(parsed.key);
          const wanted = parsed.assignee.trim();
          let person: { accountId: string | null; name: string };
          if (/^unassign(ed)?$/i.test(wanted)) person = { accountId: null, name: "nobody" };
          else {
            // The approver read a name, not an id, and the lookup runs after they approved. So
            // the name must BE the person: an exact display name or email, held by exactly one
            // user. Jira's search is fuzzy — "Mai" finds "Mai Tran" today and "Maia" tomorrow,
            // and the approver would have signed off on whoever came back.
            const exact = wanted.toLowerCase();
            const matches = (await settings.client.findUsers(wanted)).filter(
              (user) => user.displayName.toLowerCase() === exact || user.emailAddress?.toLowerCase() === exact,
            );
            if (matches.length !== 1) {
              throw new JiraAccessError(
                matches.length ? `"${wanted}" is the name of ${matches.length} people; use their email.` : `No Jira user is named exactly "${wanted}"; use their full display name or email.`,
              );
            }
            person = { accountId: (matches[0] as { accountId: string }).accountId, name: (matches[0] as { displayName: string }).displayName };
          }
          await once(settings.ledger, opKey("jira.assign", key, person.accountId ?? "", context?.approval?.id), () => settings.client.assign(key, person.accountId), { meta: { tool: "jira_assign", key } });
          return `Assigned jira:${key} to ${person.name}.`;
        }),
    },
    {
      name: "jira_labels",
      description: "Add and/or remove labels on a Jira issue. Requires human approval; it is not done until approved.",
      inputSchema: z.object({ key: z.string(), add: z.array(LABEL).max(10).default([]), remove: z.array(LABEL).max(10).default([]) }),
      run: (input, context) =>
        refusalOr(async () => {
          const parsed = z.object({ key: z.string(), add: z.array(LABEL).max(10).default([]), remove: z.array(LABEL).max(10).default([]) }).parse(input);
          const key = checkKey(parsed.key);
          if (!parsed.add.length && !parsed.remove.length) throw new JiraAccessError("No labels to add or remove.");
          await once(settings.ledger, opKey("jira.labels", key, parsed.add.join(","), parsed.remove.join(","), context?.approval?.id), () => settings.client.editLabels(key, parsed.add, parsed.remove), {
            meta: { tool: "jira_labels", key },
          });
          return `Labels on jira:${key}: ${[...parsed.add.map((label) => `+${label}`), ...parsed.remove.map((label) => `-${label}`)].join(" ")}.`;
        }),
    },
    {
      name: "jira_link",
      description: 'Link two Jira issues, e.g. "DOC-7 blocks DOC-9" (type: Relates, Blocks, Duplicate, Cloners). Requires human approval; it is not done until approved.',
      inputSchema: z.object({ from: z.string(), to: z.string(), type: z.enum(["Relates", "Blocks", "Duplicate", "Cloners"]).default("Relates") }),
      run: (input, context) =>
        refusalOr(async () => {
          const parsed = z.object({ from: z.string(), to: z.string(), type: z.enum(["Relates", "Blocks", "Duplicate", "Cloners"]).default("Relates") }).parse(input);
          // Both ends inside the allow-list: a link is a write on each issue.
          const from = checkKey(parsed.from);
          const to = checkKey(parsed.to);
          if (from === to) throw new JiraAccessError("An issue can't be linked to itself.");
          await once(settings.ledger, opKey("jira.link", from, to, parsed.type, context?.approval?.id), () => settings.client.linkIssues(from, to, parsed.type), { meta: { tool: "jira_link", from, to } });
          return `Linked jira:${from} → jira:${to} (${parsed.type}).`;
        }),
    },
  ];

  if (settings.createProject) {
    const project = settings.createProject.toUpperCase();
    if (!projects.includes(project)) throw new Error(`createProject ${project} is not in allowedProjects`);
    tools.push({
      name: "jira_create_issue",
      description: `Create a Jira issue in ${project}. Requires human approval; it is not done until approved.`,
      inputSchema: z.object({ summary: z.string().min(1).max(250), description: z.string().describe("Markdown.") }),
      run: (input, context) =>
        refusalOr(async () => {
          const parsed = z.object({ summary: z.string().min(1).max(250), description: z.string() }).parse(input);
          // The issue carries a label naming this op, so a retry after a create whose response
          // was lost (a timeout after Jira stored it, or a crash) finds the issue instead of
          // filing a second one. Without it, Retry on a timed-out create was one click from a
          // duplicate, and a plan's resume re-created a step it promised not to repeat.
          const op = opKey("jira.create", project, digest(parsed.summary), digest(parsed.description), context?.approval?.id);
          const label = createOpLabel(op);
          const { result, replayed } = await once(
            settings.ledger,
            op,
            () => settings.client.createIssue({ summary: parsed.summary, description: markdownToJira(parsed.description), issueType: settings.issueType ?? "Task", project, labels: [label] }),
            {
              probe: async () => {
                const [found] = await settings.client.searchIssues(`project = ${jqlString(project)} AND labels = ${jqlString(label)}`, 1);
                return found ? { key: found.key, url: settings.client.issueUrl(found.key) } : undefined;
              },
            },
          );
          return `${replayed ? "Already created" : "Created"} jira:${result.key} ${result.url}`;
        }),
    });
  }

  return tools;
}

/** The label a created issue carries so a retry can find it: one op, one label. */
export function createOpLabel(op: string): string {
  return `scriptorium-op-${createHash("sha256").update(op).digest("hex").slice(0, 12)}`;
}

const RECENT_LIMIT = 30;
const CHILDREN_LIMIT = 50;

/**
 * A list that filled its limit may be missing entries, and a summary built from it must say
 * so instead of reading as the whole picture ("all 50 children are done"). The note carries
 * no `cite`, so it is never a record.
 */
function cutNote(count: number, limit: number, what: string): Array<{ note: string }> {
  return count >= limit ? [{ note: `Only the first ${limit} ${what} are listed; there may be more. Say the list is partial.` }] : [];
}

function citeRecords(_input: unknown, output: string): string[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) ? parsed.flatMap((hit) => (typeof hit?.cite === "string" && /^jira:[A-Z][A-Z0-9_]*-\d+$/.test(hit.cite) ? [hit.cite] : [])) : [];
  } catch {
    return [];
  }
}

async function refusalOr(work: () => Promise<string>): Promise<string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof JiraAccessError) return `NOT_ALLOWED: ${error.message}`;
    throw error;
  }
}

/** A JQL string literal; input can never close it. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
