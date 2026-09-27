---
name: readiness-check
description: Check whether a Jira issue is ready to be worked on, and say exactly what is missing.
---
When asked whether an issue is ready (or to "check" one):
1. Read the issue and its latest comments.
2. Check: a summary that names an outcome; a description that says why; acceptance criteria that can be tested; an owner; links to the design or spec if the work touches UI; no unanswered question in the comments.
3. Reply with a verdict (Ready / Not ready) and a short list of what is missing, each item actionable ("add acceptance criteria for the empty state"), citing the issue.
4. Only comment on the issue itself if the person asked you to; `jira_comment` needs approval.
