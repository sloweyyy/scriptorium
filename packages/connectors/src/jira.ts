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
          const issues = await settings.client.searchIssues(jql, 30);
          return JSON.stringify(
            issues.map((issue) => ({ cite: `jira:${issue.key}`, key: issue.key, summary: issue.fields.summary, status: issue.fields.status?.name, updated: issue.fields.updated })),
          );
        }),
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
    },
    {
      name: "jira_comment",
      description: "Add a comment to a Jira issue. Requires human approval; it is not done until approved.",
      inputSchema: z.object({ key: z.string(), body: z.string().min(1).describe("Markdown.") }),
      run: (input) =>
        refusalOr(async () => {
          const parsed = z.object({ key: z.string(), body: z.string().min(1) }).parse(input);
          const key = checkKey(parsed.key);
          const op = opKey("jira.comment", key, digest(parsed.body));
          const { result, replayed } = await once(
            settings.ledger,
            op,
            async () => (await settings.client.addComment(key, markdownToJira(parsed.body), { op })).id,
            { probe: async () => (await settings.client.findCommentByOp(key, op))?.id, meta: { tool: "jira_comment", key } },
          );
          return `${replayed ? "Already commented" : "Commented"} on jira:${key} (comment ${result}).`;
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
      run: (input) =>
        refusalOr(async () => {
          const parsed = z.object({ summary: z.string().min(1).max(250), description: z.string() }).parse(input);
          // No probe yet (issue properties on create are a follow-up), so a crash between the
          // create and the ledger write can duplicate — the ledger still stops every retry
          // that happens after the record lands.
          const { result, replayed } = await once(settings.ledger, opKey("jira.create", project, digest(parsed.summary), digest(parsed.description)), () =>
            settings.client.createIssue({ summary: parsed.summary, description: markdownToJira(parsed.description), issueType: settings.issueType ?? "Task" }),
          );
          return `${replayed ? "Already created" : "Created"} jira:${result.key} ${result.url}`;
        }),
    });
  }

  return tools;
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
