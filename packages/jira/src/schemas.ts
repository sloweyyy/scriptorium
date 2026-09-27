import { z } from "zod";
import type { JiraComment, JiraIssue, JiraUser } from "./types";

/**
 * The shapes the agent actually depends on, checked where Jira's JSON enters.
 *
 * Deliberately lenient on everything it does not use (`.passthrough()`, nullable where Jira
 * sends null) and strict on what it does: an issue without a `key`, a comment without an
 * `id`, a myself without an `accountId`. Those fail HERE, naming the field — not as
 * `undefined` three layers later, where the agent would e.g. fail to recognise its own
 * comments and answer itself.
 */

const User = z.object({ accountId: z.string(), displayName: z.string().optional() }).passthrough();
const Comment = z
  .object({
    id: z.string(),
    body: z.string().nullable().optional().transform((value) => value ?? ""),
    created: z.string(),
    author: User.partial().nullable().optional().transform((value) => value ?? undefined),
  })
  .passthrough();
const Issue = z
  .object({
    id: z.string(),
    key: z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/),
    fields: z.object({ summary: z.string().nullable().optional().transform((value) => value ?? "") }).passthrough(),
  })
  .passthrough();

export class JiraShapeError extends Error {}

function check<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new JiraShapeError(`Jira returned an unexpected ${what}: ${issue?.path.join(".") || "(root)"} — ${issue?.message}`);
  }
  return parsed.data;
}

export const parseMyself = (value: unknown): JiraUser => check(User, value, "account") as unknown as JiraUser;
export const parseIssue = (value: unknown): JiraIssue => check(Issue, value, "issue") as unknown as JiraIssue;
export const parseIssues = (value: unknown): JiraIssue[] => check(z.array(Issue), value ?? [], "issue list") as unknown as JiraIssue[];
export const parseComments = (value: unknown): JiraComment[] => check(z.array(Comment), value ?? [], "comment list") as unknown as JiraComment[];
