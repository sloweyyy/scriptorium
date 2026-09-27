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
