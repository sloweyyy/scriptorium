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
const MergedPull = z.object({
  number: z.number(),
  title: z.string(),
  merged_at: z.string().nullable(),
  updated_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  labels: z.array(z.object({ name: z.string() })).optional(),
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
      name: "github_list_merged",
      description:
        "List the pull requests merged into a repo since a date (at most 90 days back), newest first — for release notes. Cite each as [[github:<owner/repo>/pull/<number>]], using the id at the start of its line.",
      inputSchema: z.object({ repo: z.string().describe("owner/name"), since: z.string().describe("A date, YYYY-MM-DD.") }),
      run: (input) =>
        refusalOr(async () => {
          const parsed = z.object({ repo: z.string(), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(input);
          const repo = checkRepo(parsed.repo);
          const since = Date.parse(`${parsed.since}T00:00:00Z`);
          if (!Number.isFinite(since) || since < Date.now() - 90 * 24 * 3600 * 1000) throw new GitHubAccessError("`since` must be a date within the last 90 days.");
          const merged: Array<z.infer<typeof MergedPull>> = [];
          // Closed PRs, most recently updated first: once a page is entirely older than
          // `since`, nothing after it can be newer.
          // Reaching the page cap without running out of PRs newer than `since` means there may be more.
          let complete = false;
          for (let page = 1; page <= 5; page += 1) {
            const pulls = await call(repo, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, z.array(MergedPull));
            merged.push(...pulls.filter((pull) => pull.merged_at && Date.parse(pull.merged_at) >= since));
            if (pulls.length < 100 || pulls.every((pull) => Date.parse(pull.updated_at) < since)) {
              complete = true;
              break;
            }
          }
          if (!merged.length) return `No pull requests were merged into ${repo} since ${parsed.since}.`;
          // One PR per line, its id first, its title flattened: a title can't forge a record.
          const sorted = merged.sort((a, b) => Date.parse(b.merged_at as string) - Date.parse(a.merged_at as string));
          const more = sorted.length > 200 || !complete;
          const lines = sorted
            .slice(0, 200)
            .map((pull) => `github:${repo}/pull/${pull.number} — ${pull.title.replace(/\s+/g, " ").slice(0, 200)} (merged ${(pull.merged_at as string).slice(0, 10)} by ${pull.user?.login ?? "unknown"}${pull.labels?.length ? `; labels: ${pull.labels.map((label) => label.name).join(", ")}` : ""})`)
            ;
          // The list is bounded; one that stops silently would read as everything that shipped.
          return [...lines, ...(more ? ["(Showing the most recent 200 merged; there are more in this period — say so, or narrow the date.)"] : [])].join("\n");
        }),
      records: (input, output) => {
        const parsed = z.object({ repo: z.string() }).safeParse(input);
        if (!parsed.success) return [];
        const prefix = `github:${parsed.data.repo.trim().toLowerCase()}/pull/`;
        return output
          .split("\n")
          .map((line) => line.match(/^(github:[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/\d+) — /)?.[1])
          .filter((id): id is string => Boolean(id) && (id as string).startsWith(prefix));
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
          // Paged: on a busy PR the comment a crashed attempt made may be past the first 100.
          const find = async () => {
            for (let page = 1; page <= 10; page += 1) {
              const comments = await call(repo, `/repos/${repo}/issues/${parsed.number}/comments?per_page=100&page=${page}`, Comments);
              const found = comments.find((comment) => comment.body?.includes(OP_MARKER(op)));
              if (found) return found.id;
              if (comments.length < 100) return undefined;
            }
            return undefined;
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
