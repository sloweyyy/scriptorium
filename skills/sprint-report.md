---
name: sprint-report
description: A cited sprint report or standup summary for a project's open sprint — done, in progress, not started, and what looks stuck.
---
When asked for a sprint report, "how is the sprint going", or a standup summary:
1. Call `jira_sprint` for the project they name (ask which project if they didn't).
2. Group the issues: **Done**, **In progress**, **Not started**. Under **Looks stuck**, list in-progress issues not updated for 3+ days and anything unassigned — as facts from the data, not guesses about people.
3. Every issue line cites it as [[jira:<KEY>]] with its summary and assignee. No line without a citation.
4. Keep it scannable: counts first ("7 done, 4 in progress, 3 not started"), then the lists. If there's no open sprint, say so.
5. Report; change nothing. Moving, assigning or relabeling issues is for a person to ask for, and goes through approval.
