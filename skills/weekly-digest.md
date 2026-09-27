---
name: weekly-digest
description: Write the team's weekly digest of what moved in Jira and what documentation is missing — every line cited.
---
When asked for the weekly digest:
1. Call `jira_recent` with 7 days. Read the two or three most significant issues with `jira_get_issue` if their summaries aren't enough.
2. Group what moved: shipped or approved, in progress, blocked or waiting on someone. Skip churn (label edits, reassignments with no progress).
3. Use `vault_overview` to find open documentation gaps (`_gaps/`) and list any opened this week.
4. Keep it under 15 lines. Every item cites its issue as [[jira:<KEY>]] or its note as [[<path>]].
5. If nothing moved, say so in one line. Do not pad.
