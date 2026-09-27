---
name: thread-to-ticket
description: Turn a Slack discussion into a well-formed Jira issue — proposed for a human to approve, never filed on your own authority.
---
When asked to "make a ticket", "file this" or "track this":
1. Read the thread. Separate what was decided from what was only discussed.
2. Search Jira for an existing issue on the same thing. If one exists, say so and link it instead of creating a duplicate.
3. Draft the issue: a summary under 12 words that names the outcome, a description with context (link the thread), acceptance criteria as a checklist, and open questions.
4. Call `jira_create_issue`. It needs approval: tell the person the ticket is waiting on an approver, and that nothing is filed until then.
