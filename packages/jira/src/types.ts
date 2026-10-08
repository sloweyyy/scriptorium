/** Minimal shapes for the Jira REST v2 responses this adapter actually reads. */

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  /** Absolute download URL — Atlassian redirects it to signed media storage. */
  content: string;
  size?: number;
  created?: string;
  /** Who uploaded it. Only the agent's own `draft-*.md` is its draft. */
  author?: { accountId?: string };
}

/**
 * Who may see a comment. Jira restricts one to a role or group (`visibility`); Jira Service
 * Management marks one internal (the `sd.public.comment` property). A reply to a restricted
 * comment must carry the same restriction, or it repeats a private conversation in public.
 */
export interface CommentRestriction {
  visibility?: { type: "role" | "group"; value: string; identifier?: string };
  internal?: boolean;
}

export interface JiraComment {
  id: string;
  /** Wiki markup / plain text: REST v2 keeps bodies as strings (v3 would hand back ADF). */
  body: string;
  created: string;
  updated?: string;
  author?: JiraUser;
  /** Entity properties, present only when listed with `expand=properties`. */
  properties?: Array<{ key: string; value: unknown }>;
}

export interface JiraIssueFields {
  summary: string;
  description?: string | null;
  status?: { name: string } | null;
  issuetype?: { name: string } | null;
  labels?: string[];
  attachment?: JiraAttachment[];
  updated?: string;
  reporter?: JiraUser | null;
  assignee?: JiraUser | null;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
}

/** One entry from `/rest/api/2/issue/{key}/remotelink` — only what intake reads. */
export interface JiraRemoteLink {
  object?: { url?: string; title?: string };
  application?: { name?: string };
}

export interface JiraTransition {
  id: string;
  name: string;
  to?: { name: string };
}

export function issueStatus(issue: JiraIssue): string {
  return issue.fields.status?.name ?? "unknown";
}

/**
 * A comment's restriction, from its REST or webhook JSON: a role/group `visibility`, or JSM's
 * internal flag (`jsdPublic: false`, or the `sd.public.comment` property). A visibility we
 * cannot read is "unreadable": the comment is not answered, since a reply can't match it.
 */
export function commentRestriction(comment: unknown): CommentRestriction | "unreadable" {
  const c = (comment ?? {}) as { visibility?: unknown; jsdPublic?: unknown; properties?: unknown };
  const restriction: CommentRestriction = {};
  if (c.visibility !== undefined && c.visibility !== null) {
    const v = c.visibility as { type?: unknown; value?: unknown; identifier?: unknown };
    if ((v.type !== "role" && v.type !== "group") || typeof v.value !== "string") return "unreadable";
    restriction.visibility = { type: v.type, value: v.value, ...(typeof v.identifier === "string" ? { identifier: v.identifier } : {}) };
  }
  const internalProperty = Array.isArray(c.properties)
    ? (c.properties as Array<{ key?: unknown; value?: { internal?: unknown } }>).some((property) => property.key === "sd.public.comment" && property.value?.internal === true)
    : false;
  if (c.jsdPublic === false || internalProperty) restriction.internal = true;
  return restriction;
}
