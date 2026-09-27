import type { ToolRunContext, ToolSpec } from "@scriptorium/core";
import { once, opKey, type EffectLedger } from "@scriptorium/runtime";
import { z } from "zod";

/**
 * GitHub pull requests as tools (v1 job #5: one advisory comment per PR on acceptance-
 * criteria coverage and doc drift).
 *
 * - Repos are allow-listed, reads included. No list, no GitHub.
 * - `github_get_pull` returns what a reviewer needs to judge the PR against its ticket:
 *   title, body, author, the files it touches, and the Jira keys it names.
 * - `github_pr_comment` writes exactly once: its op rides in the comment as an invisible
 *   HTML marker, and a retry finds it there.
 * - The token is the Teammate's OWN GitHub App installation token, supplied per repo.
 * - A PR is cited as `github:owner/repo/pull/N` — never with "#", which wikilinks read as a heading.
 */

export interface GitHubToolSettings {
  /** An installation token for a repo (`owner/name`). */
  token: (repo: string) => Promise<string>;
  /** `owner/name` repos the agent may read (and, with approval, comment on). Empty: none. */
  allowedRepos: readonly string[];
  ledger: EffectLedger;
  apiBase?: string;
}

const PullNumber = z.number().int().positive();
const Pull = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ ref: z.string() }),
  html_url: z.string(),
});
const Files = z.array(z.object({ filename: z.string(), status: z.string(), additions: z.number(), deletions: z.number() }));
const Comments = z.array(z.object({ id: z.number(), body: z.string().nullable() }));

const OP_MARKER = (op: string) => `<!-- scriptorium-op:${op} -->`;
const JIRA_KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/g;

export class GitHubAccessError extends Error {}

export function githubTools(settings: GitHubToolSettings): ToolSpec[] {
  const repos = settings.allowedRepos.map((repo) => repo.toLowerCase());
  const api = settings.apiBase ?? "https://api.github.com";

  const checkRepo = (raw: string): string => {
    const repo = raw.trim().toLowerCase();
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) throw new GitHubAccessError(`"${raw}" is not an owner/name repo.`);
    if (!repos.includes(repo)) throw new GitHubAccessError(`${repo} is outside the GitHub repos this agent may use.`);
    return repo;
  };

  const call = async <T>(repo: string, endpoint: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${api}${endpoint}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await settings.token(repo)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${endpoint} → HTTP ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`GitHub ${endpoint} returned an unexpected shape: ${parsed.error.issues[0]?.path.join(".")}`);
    return parsed.data;
  };

  return [
    {
      name: "github_get_pull",
      description: "Read one pull request: title, description, author, branch, the files it changes, and the Jira keys it mentions. Cite it as [[github:<owner/repo>/pull/<number>]].",
      inputSchema: z.object({ repo: z.string().describe("owner/name"), number: PullNumber }),
      run: (input) =>
        refusalOr(async () => {
          const { repo: raw, number } = z.object({ repo: z.string(), number: PullNumber }).parse(input);
          const repo = checkRepo(raw);
          const pull = await call(repo, `/repos/${repo}/pulls/${number}`, Pull);
          const files = await call(repo, `/repos/${repo}/pulls/${number}/files?per_page=100`, Files);
          const keys = [...new Set(`${pull.title} ${pull.head.ref} ${pull.body ?? ""}`.match(JIRA_KEY) ?? [])];
          return [
            `github:${repo}/pull/${number} — ${pull.title} [${pull.state}] by ${pull.user?.login ?? "unknown"} (${pull.head.ref}) ${pull.html_url}`,
            keys.length ? `Jira keys mentioned: ${keys.join(", ")}` : "No Jira key mentioned.",
            "",
            (pull.body ?? "").slice(0, 4_000) || "_(no description)_",
            "",
            `Files changed (${files.length}):`,
            ...files.slice(0, 100).map((file) => `- ${file.status} ${file.filename} (+${file.additions}/-${file.deletions})`),
          ].join("\n");
        }),
      records: (input, output) => {
        const parsed = z.object({ repo: z.string(), number: PullNumber }).safeParse(input);
        if (!parsed.success) return [];
        // No "#": in wikilink syntax it starts a heading, and `[[github:org/app#12]]` would cite the repo, not the PR.
        const id = `github:${parsed.data.repo.trim().toLowerCase()}/pull/${parsed.data.number}`;
        return output.startsWith(`${id} — `) ? [id] : [];
      },
    },
    {
      name: "github_pr_comment",
      description: "Post one advisory comment on a pull request. Requires human approval; it is not done until approved.",
      inputSchema: z.object({ repo: z.string(), number: PullNumber, body: z.string().min(1).max(20_000).describe("Markdown.") }),
      run: (input, context?: ToolRunContext) =>
        refusalOr(async () => {
          const parsed = z.object({ repo: z.string(), number: PullNumber, body: z.string().min(1).max(20_000) }).parse(input);
          const repo = checkRepo(parsed.repo);
          const op = opKey("github.comment", repo, parsed.number, parsed.body, context?.approval?.id);
          const find = async () => {
            const comments = await call(repo, `/repos/${repo}/issues/${parsed.number}/comments?per_page=100`, Comments);
            return comments.find((comment) => comment.body?.includes(OP_MARKER(op)))?.id;
          };
          const { result, replayed } = await once(
            settings.ledger,
            op,
            async () =>
              (await call(repo, `/repos/${repo}/issues/${parsed.number}/comments`, z.object({ id: z.number() }), {
                method: "POST",
                body: JSON.stringify({ body: `${parsed.body}\n\n_AI-generated review note — verify before acting._\n${OP_MARKER(op)}` }),
              })).id,
            { probe: find, meta: { tool: "github_pr_comment", repo, number: parsed.number } },
          );
          return `${replayed ? "Already commented" : "Commented"} on github:${repo}/pull/${parsed.number} (comment ${result}).`;
        }),
    },
  ];
}

async function refusalOr(work: () => Promise<string>): Promise<string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GitHubAccessError) return `NOT_ALLOWED: ${error.message}`;
    throw error;
  }
}
