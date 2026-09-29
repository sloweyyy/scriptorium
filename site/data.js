// Everything the project page shows. Keep it current: numbers from `pnpm eval` / `pnpm mutate`,
// the merged-PR count and new findings as they land. index.html only renders this.
window.SITE = {
  // Reviewed pull requests merged so far (the "built in the open" line and the stats).
  mergedPullRequests: 20,
  updated: "29 September 2026",

  stats: [
    { value: "570+", label: "evals, deterministic, on every commit" },
    { value: "89", label: "guardrails proven by mutation testing" },
    { value: "30+", label: "tools, every write approve-tier" },
    { value: "20", label: "reviewed pull requests merged" },
  ],

  capabilities: [
    { top: true, title: "Cited answers", text: "Answers from the docs vault, Confluence, Jira, GitHub and Slack. Every claim cites a record a tool actually fetched; otherwise it says it doesn't know and files a gap.", where: "Slack mention, DM, /teammate, Jira" },
    { top: true, title: "Thread → ticket", text: "Turns a discussion into a well-formed Jira issue, proposed on an approval card, or through the \"File as a ticket\" message shortcut.", where: "Slack" },
    { title: "Jira edits", text: "Move, assign, label and link issues. The assignee's name must match exactly one person, and a link checks both issues are in allowed projects.", where: "approve-tier" },
    { top: true, title: "Several changes, one approval", text: "A plan puts the tickets from a meeting and their links on a single card, every step listed. Each step runs exactly once, and a refusal stops the plan.", where: "propose_plan" },
    { top: true, title: "What did I miss?", text: "Catches you up on the channel you ask in: what was decided, what's still open, and what's waiting on you, each point cited to its message.", where: "Slack, read on demand, nothing kept" },
    { title: "Ticket triage", text: "A newly filed ticket gets one reply saying whether it's ready, what's missing, and which issues it may duplicate. It changes nothing on the ticket.", where: "Jira, opt-in per project" },
    { title: "Sprint reports", text: "A project's open sprint as done / in progress / not started / looks stuck, with every issue cited.", where: "Jira" },
    { title: "Release notes", text: "What merged since a date, grouped for readers into new / improved / fixed, every line cited to its PR. It's published only if someone asks, and only on approval.", where: "GitHub" },
    { top: true, title: "PR checks", text: "Checks a pull request against the ticket it implements, flags where the docs no longer match, and proposes one advisory comment.", where: "GitHub webhook" },
    { title: "Confluence, whole trees", text: "Search, read pages, walk page trees and read text attachments, with every page and child checked against the allowed spaces.", where: "Confluence" },
    { title: "Reminders", text: "\"Remind us Friday at 9\" is approved once for its exact text, channel and time, then posted once, escaped, and only in the channel that asked.", where: "Slack" },
    { title: "An approver's inbox", text: "The App Home tab lists what's waiting for your approval, linked to each card. Requests from private conversations aren't described there.", where: "Slack App Home" },
    { title: "Answers that get better", text: "A thumbs-down on an answer flags it for review as a test case, and a golden set grades every model's answers: the right sources cited, the right facts stated, and a clean \"I don't know\" when the docs don't say.", where: "Slack, evals" },
    { title: "Team memory", text: "It remembers only what a human approved, scoped to a person, a channel or everyone. Memories expire and are signed.", where: "human-gated" },
    { title: "Weekly digest", text: "A cited summary of what moved in Jira and which doc gaps opened, posted exactly once a week.", where: "scheduled" },
    { top: true, title: "Docs from PRDs (Scribe)", text: "The original agent drafts user docs from a PRD and designs on a Jira ticket, revises on feedback, and publishes only on approval.", where: "Jira, human-gated" },
  ],

  rules: [
    { title: "No approval, no write", text: "Every write is approve-tier and waits for a listed approver. The approval is signed, single-use, and bound by hash to the exact arguments on the card." },
    { title: "The requester can't approve", text: "Separation of duties compares people, not accounts, so asking on Jira and clicking Approve in Slack is still approving yourself." },
    { title: "No citation, no claim", text: "Grounding is checked against the records the tools actually returned. A refusal, or a record merely mentioned inside a fetched page, is never evidence." },
    { title: "Exactly once", text: "Every write is op-keyed and probes the outside world before retrying, so a lost response or a restart never posts twice." },
    { title: "Fail closed", text: "Unset means less. An unreadable control file means paused, a truncated model reply isn't an answer, and a restriction it can't read gets no reply." },
    { title: "Held to the conversation", text: "It reads only the thread or channel it was asked in, answers internal Jira comments at the same visibility, and plans can't escape those bounds." },
    { title: "Stop it now", text: "Admins can pause it, make it read-only, or switch off a single tool, at once and without a redeploy. A pause stops approved-but-pending work too." },
    { title: "Erase a person, keep the record", text: "On request, everything kept about one person is erased: their words in the audit log, their memories, their pending requests. The log's chain still verifies, and who approved a write is never erased." },
    { title: "A record you can check", text: "The audit log is hash-chained: an edited, removed or reordered line is detected. A run viewer shows what each answer did and cost." },
  ],


  findings: [
    { sev: "High", issue: "Every reply's \"view run\" link carried the viewer's global token, so anyone who could read one reply could open every run: other people's questions, DMs and tool calls.", fix: "A reply's link is signed for its own run and opens nothing else. The token is never posted; it stays with operators." },
    { sev: "High", issue: "A private memory could be read through retrieval by spelling its path another way, such as docs/../_memory/…, and then cited.", fix: "Every path check runs on the path as the filesystem resolves it, with case folded. Memory, gap and inbox notes are never evidence." },
    { sev: "High", issue: "If a revised draft's comment failed to post (a draft too long for Jira, say), approving the draft on the ticket published the unseen revision.", fix: "Publishing requires the saved draft to be exactly the one on the ticket. If it isn't, it's posted again and needs a new approval. Long drafts are shortened in the comment and attached in full." },
    { sev: "High", issue: "A question in an internal Jira comment got a public reply, visible to customers.", fix: "Replies copy the comment's visibility. A restriction it can't read gets no reply at all." },
    { sev: "High", issue: "A multi-step plan's card showed only the first 400 characters, so a later step's comment body could be approved unseen.", fix: "The card lists every step and every argument. A plan too long for one card is refused, never cut." },
    { sev: "High", issue: "A plan could schedule reminders in channels other than the one that asked.", fix: "The per-conversation checks are one function, applied to single calls and to every plan step alike." },
  ],

  packages: [
    { name: "packages/policy", text: "Tiers, approvals bound to an args hash, approver rules, separation of duties, multi-step plans." },
    { name: "packages/runtime", text: "Events, the gate, per-conversation queue, exactly-once effects, the fail-closed model loop, memory, budgets." },
    { name: "packages/connectors", text: "Jira, Confluence, Slack and GitHub tools. Allow-listed reads, words instead of query language, validated responses." },
    { name: "packages/curator", text: "The vault: organising, hybrid retrieval, and the grounding contract every answer passes." },
    { name: "packages/scribe", text: "Drafting docs from PRDs, the deterministic lint, publishing, and house rules." },
    { name: "apps/agents", text: "The surfaces: the Slack Teammate, the Jira poller and webhooks, App Home, reminders, admin controls." },
  ],
};
