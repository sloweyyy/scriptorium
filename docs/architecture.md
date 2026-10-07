# Architecture

scriptorium is one engine that runs several agents. An agent is configuration: an
identity, a tool → tier map, skills, and the events it answers. It is never a new bot.
Scribe (docs from Jira tickets), Curator (cited Q&A) and the Teammate (a general assistant
across Slack, Jira and Confluence) all run on the same pieces.

```
 Slack · Jira · Confluence · GitHub · cron
        │ ingress: verify signature, drop redeliveries
        ▼
 AgentEvent {id, source, key, kind, actor, payload}          packages/runtime/src/event.ts
        │ Gate: own events, other bots, out-of-scope → refused with a reason
        ▼
 KeyedQueue: one lane per conversation (thread · ticket · page · PR)   runtime/src/queue.ts
        ▼
 assembleAgent(config, connector tools, skills)                        runtime/src/agent.ts
        │ only allowed tools are offered, each wrapped in `guard`
        ▼
 runSession (Claude | Gemini): fails closed, cached, metered           runtime/src/session.ts
        │ every tool call
        ▼
 policy: allow · approve · deny                                         packages/policy
        │ approve → card → a listed human → executeApproved, once
        ▼
 connectors (allow-listed; exactly-once writes via op-keys)             packages/connectors
        ▼
 grounding: a citation must be a record a tool actually fetched         curator/src/qa-contract.ts
        ▼
 reply with "AI-generated · run <id>"; every step audited under the run id
```

## Packages

| Package | Owns |
|---|---|
| `core` | LLM clients (Anthropic, Vertex, Gemini), the vault (frontmatter, wikilinks, path guard), the audit log, run context, hashing, approval signing, config |
| `policy` | envelopes, tiers, approvals (args-hash-bound, atomic, single-use), `guard` / `runUnderPolicy` / `executeApproved` |
| `runtime` | events, gate, queue, effects (`once`, op-keys), the session loop, agents-as-config, scoped memory |
| `connectors` | Confluence, Jira and Slack as tools, plus the Slack approval card |
| `curator` | vault organizer, BM25 index, Q&A contract, grounding, gap notes, staleness |
| `scribe` | the docs pipeline (contract → draft → lint → revise → publish), lessons |
| `jira` | REST client with validated responses, markup, comment commands, poller state |
| `publish` | staging and pushing the vault to the docs sites |
| `apps/agents` | the surfaces: the Jira poller (Scribe), the Slack bots (Curator, Teammate), ingress, the MCP server |

## Invariants

Each invariant is enforced in one place, and an eval fails if it is broken.

1. **Every tool call passes one policy check.** Unlisted tools are denied and not offered.
   `evals/policy.test.ts`, `evals/agent-config.test.ts`
2. **An approval is a listed human's, for exact arguments, once.** An empty approver list
   means nobody. Decisions are atomic. A failed action gives its approval back.
   `evals/policy.test.ts`, `evals/slack-connector.test.ts`, `evals/teammate-e2e.test.ts`
3. **No citation, no claim.** Evidence is the records tools fetched, never text inside
   their output. Writes don't switch the check off. `evals/grounding.test.ts`,
   `evals/teammate.test.ts`
4. **The model loop never returns half an answer.** A capped, truncated, refused or empty
   turn is a typed error. `evals/session.test.ts`
5. **Every write happens exactly once,** across retries and crashes (op-keys with
   probes). `evals/effects.test.ts`, `evals/jira-board.test.ts` (H4)
6. **Nothing is learned without a human.** Lessons and memories are approved; memories are
   scoped and private; approvals are signed. `evals/lesson-gate.test.ts`,
   `evals/memory.test.ts`, `evals/approval-signing.test.ts`
7. **Untrusted input stays data.** YAML-only frontmatter, fenced prompts, allow-listed
   PRD keys. `evals/frontmatter-safety.test.ts`, `evals/injection.test.ts`
8. **Connectors see only what they are allowed to see.** Reads are allow-listed too, and the
   model writes words, never JQL or CQL. `evals/*-connector.test.ts`
9. **Curator never authors and never drifts with lessons.** `evals/curator-isolation.test.ts`
10. **Every publish is on the record.** It is a git commit naming the approver, with an
    append-only audit line. `evals/publish-record.test.ts`
11. **Nothing is drafted from a guess.** A PRD missing its feature, audience or user goal,
    or holding a placeholder for one, gets questions back. `evals/contract.test.ts`,
    `evals/jira-flow.test.ts`
12. **A comment publishes only when it is an approval and nothing else.** Any word past
    the command and courtesy makes it a question. `evals/jira.test.ts`
13. **What reaches a site is inert.** Text nobody vouched for is written inert, and every
    body is made inert again as it leaves for a site: raw HTML escaped, a link that isn't
    to the web unlinked, Quartz's own HTML-making syntax broken. `evals/inert.test.ts`,
    `evals/publish.test.ts`

The threat model behind these invariants is in [`security-model.md`](security-model.md).
To add to the system, see [`extending.md`](extending.md).
