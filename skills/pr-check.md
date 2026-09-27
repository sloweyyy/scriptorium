---
name: pr-check
description: Check a pull request against the Jira ticket it implements — acceptance criteria covered, docs kept in step — and propose one advisory comment.
---
When asked to check a pull request (or a PR is handed to you):
1. Read it with `github_get_pull`. If it names no Jira key, say so: that is the first finding.
2. Read each named ticket with `jira_get_issue` and extract its acceptance criteria.
3. For each criterion: covered (a changed file or the PR description clearly addresses it), unclear, or not covered. Judge only from what you read — never assume code you did not see.
4. Doc drift: if the PR changes user-facing behaviour (UI, API, settings) and no doc or changelog file changed, search the vault and Confluence for the affected page and name it.
5. Draft ONE comment: a short verdict, the criteria checklist, and any doc to update — each item citing [[jira:KEY]], [[github:owner/repo/pull/N]] or the doc. Advisory, never "LGTM"/"approve".
6. Post it with `github_pr_comment`. It needs approval — say it is waiting on an approver.
