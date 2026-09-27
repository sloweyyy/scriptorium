# Extending scriptorium

You rarely need a new bot. Most new capability is a skill, a tool, or a line in an agent's
envelope.

## Add a skill (a new job for an existing agent)

1. Write `skills/<name>.md` with `name` and `description` frontmatter. The body is plain
   instructions: numbered steps, which tools to use, and what the reply looks like. Say
   what the skill must *not* do; for example, "only comment if asked, since `jira_comment`
   needs approval".
2. Add the skill's name to the agent's `skills` (for the Teammate, that's
   `apps/agents/src/agents/teammate.ts`).
3. `assembleAgent` fails at boot if a skill is missing, so a typo can't ship quietly.

A skill can't weaken the platform rules. Tool output is data, every claim needs a citation,
and a pending action hasn't happened. `assembleAgent` puts those rules first, whatever the
skill says.

## Add a tool (or a connector)

A tool is a `ToolSpec` (`packages/core/src/llm.ts`):

```ts
{
  name: "jira_get_issue",
  description: "…what it does, and when it needs approval…",
  inputSchema: z.object({ key: z.string() }),
  run: async (input, context) => "…text for the model…",
  records: (input, output) => ["jira:DOC-7"],   // what this call actually fetched
}
```

Rules for connectors, each already followed by the existing ones:

- **Allow-list reads as well as writes.** An empty list means none.
- **Take words from the model, never a query language.** Escape the words into a string
  literal (`jqlString`, `cqlString`).
- **Validate responses at the boundary** with zod. Be strict on the fields you depend on
  and lenient on the rest.
- **Declare `records`** from the validated input, or from JSON you built yourself, and
  never from the content you return. Otherwise the tool can't ground a citation.
- **Make writes exactly-once.** Wrap the write in `once(ledger, opKey(...), act, { probe })`.
  Include `context.approval.id` in the op, so separately approved identical writes stay
  separate, and give it a probe that asks the outside world whether the write already
  landed.
- **Return refusals as text** (`NOT_ALLOWED: …`), not exceptions, so the model can explain
  them. Grounding never counts a refusal as evidence.

Then give the tool a tier in the agent's envelope. A write should be `approve` with an
approver list. `deny`, or leaving the tool out, means the model never sees it.

## Add an agent

1. Write an `AgentConfig`: `name`, `description`, `selfAccountIds`, `skills`, a `tools`
   tier map, and `triggers`.
2. Give it its own identity where the permission boundary is: its own Slack app, and its
   own Atlassian account if it writes to Jira. Two agents sharing one token are one
   identity.
3. Wire a surface. `createTeammate` (`apps/agents/src/teammate-bot.ts`) is the reference:
   mention → gate → queue → `runTeammateTurn`, plus approval clicks through
   `handleApprovalClick` and `executeApproved`. Keep it Bolt-free, so an end-to-end test
   can drive it (`evals/teammate-e2e.test.ts`).

## Checks every change needs

- `pnpm typecheck && pnpm eval` must be green. CI runs both on Node 22 and 24.
- Behaviour changes come with an eval that fails without them. Try deleting the guarded
  line: if the eval stays green, it doesn't guard anything.
- Retrieval changes must not lower `evals/baselines/retrieval.json`. If they raise the
  score, raise the baseline in the same commit.
