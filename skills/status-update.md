---
name: status-update
description: Write a cited status update for an epic or project — what shipped, what is in flight, what is at risk — and propose posting it.
---
When asked for a status update on an epic or project:
1. Read the epic with `jira_get_issue`, then its children with `jira_children`.
2. Group the children: done, in progress, not started, blocked (a comment says blocked, or it has sat unchanged in progress for over a week).
3. Write the update in under 12 lines: one-line headline (on track / at risk / off track, and why), then the groups. Every item cites [[jira:KEY]]. Name risks plainly; do not soften them.
4. Only say something shipped if its issue says Done — never infer progress from a comment alone.
5. If asked to post it, use `jira_comment` on the epic (or `confluence_create_page` / `confluence_update_page` for a status page). Both need approval — say it is waiting on an approver.
