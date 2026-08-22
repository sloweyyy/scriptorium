/**
 * Pull requests for published docs.
 *
 * The push path authenticates with a repo-scoped deploy key, which is deliberately the
 * weakest credential that can do the job — but a deploy key cannot open a pull request.
 * That needs an API token, so PR creation is a separate, optional capability: without a
 * token the agent still publishes (one gate, Jira approval); with one it also opens the
 * PR that makes publication a second, human gate.
 */

export interface PullRequestInput {
  /** "owner/repo" */
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  /** Fine-grained token with Contents + Pull requests write on this repo. */
  token: string;
  apiBase?: string;
}

export interface PullRequest {
  number: number;
  url: string;
  state: string;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    detail: string,
  ) {
    super(`GitHub ${status} on ${endpoint}: ${detail}`);
    this.name = "GitHubError";
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/**
 * Open a PR, or return the one that already exists for this head branch.
 *
 * Idempotent on purpose: the publish flow can run twice for the same ticket (webhook plus
 * poll reconciler), and a second attempt must not fail the publish or open a duplicate.
 */
export async function openPullRequest(input: PullRequestInput): Promise<PullRequest> {
  const api = input.apiBase ?? "https://api.github.com";
  const [owner] = input.repo.split("/");
  const createEndpoint = `/repos/${input.repo}/pulls`;

  const created = await fetch(`${api}${createEndpoint}`, {
    method: "POST",
    headers: headers(input.token),
    body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base }),
  });

  if (created.ok) {
    const data = (await created.json()) as { number: number; html_url: string; state: string };
    return { number: data.number, url: data.html_url, state: data.state };
  }

  const detail = await created.text();
  // 422 is how GitHub reports "a pull request already exists for this head" — treat that
  // as success and return the existing one rather than failing an otherwise-good publish.
  if (created.status === 422) {
    const existing = await findOpenPullRequest({ repo: input.repo, head: input.head, token: input.token, apiBase: api, owner });
    if (existing) {
      // A republished revision reuses the branch, so the PR must not keep describing the
      // previous publish — its title carries the approver, and a stale one misattributes.
      await fetch(`${api}/repos/${input.repo}/pulls/${existing.number}`, {
        method: "PATCH",
        headers: headers(input.token),
        body: JSON.stringify({ title: input.title, body: input.body }),
      }).catch(() => undefined);
      return { ...existing, url: existing.url };
    }
  }
  throw new GitHubError(created.status, createEndpoint, detail.slice(0, 300));
}

export async function findOpenPullRequest(input: {
  repo: string;
  head: string;
  token: string;
  apiBase?: string;
  owner?: string;
}): Promise<PullRequest | undefined> {
  const api = input.apiBase ?? "https://api.github.com";
  const owner = input.owner ?? input.repo.split("/")[0] ?? "";
  const endpoint = `/repos/${input.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}`;
  const response = await fetch(`${api}${endpoint}`, { headers: headers(input.token) });
  if (!response.ok) {
    throw new GitHubError(response.status, endpoint, (await response.text()).slice(0, 300));
  }
  const list = (await response.json()) as Array<{ number: number; html_url: string; state: string }>;
  const first = list[0];
  return first ? { number: first.number, url: first.html_url, state: first.state } : undefined;
}

/** Branch name for one ticket's publish. Stable per ticket, so a re-publish updates the same PR. */
export function docBranchName(issueKey: string, slug: string): string {
  return `docs/${issueKey.toLowerCase()}-${slug}`;
}

export function docPullRequestBody(input: {
  issueKey: string;
  issueUrl: string;
  approvedBy: string;
  relPath: string;
  appliedLessons?: string[];
}): string {
  return [
    `Published from ${input.issueKey} — approved by ${input.approvedBy}.`,
    "",
    `- Ticket: ${input.issueUrl}`,
    `- Vault note: \`${input.relPath}\``,
    input.appliedLessons?.length ? `- House rules applied: ${input.appliedLessons.join(", ")}` : "- House rules applied: none",
    "",
    "Content was approved by a human on the ticket. Merging publishes it to the docs site —",
    "that is the second gate, and it is deliberately a different decision from approving the text.",
  ].join("\n");
}
