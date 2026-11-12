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
- **Name what a write created,** if later events can arrive on it (a ticket, a page, a PR).
  Teach `aliasesFromResult` (`packages/connectors/src/aliases.ts`) to read the alias from
  the line your tool builds after the write landed. The surface binds it to the
  conversation's anchor through `GuardDeps.onRan`, so replies on the new thing share the
  conversation's lane. Never read it from the model's input or from fetched content.

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

## Add a chat surface

`packages/runtime/src/surface.ts` defines the two adapter boundaries:

- `ChatInbound` turns the platform payload into a `ChatTurn`, reads its thread, and reports
  whether the conversation is private.
- `ChatOutbound` posts and edits a `ChatMessage` at a `ChatTarget`. Messages carry Markdown,
  source records and links, a gap ticket link, and run provenance. The adapter owns platform
  markup and rich cards; message ids stay opaque to the runtime. A failed post must throw;
  a failed edit returns `false` or throws.

Use `chatDelivery` for the acknowledgement, progress edits and final answer. It throttles
progress, waits for every edit still in flight before delivering the answer, and posts in
the same thread if the acknowledgement cannot be edited. Keep the placeholder's durable
record open until `finish` succeeds, so restart recovery can close an interrupted reply.

For scheduled posts, implement `TaggedChatOutbound.postTagged` and `findTagged`. The tag is
stable data independent of the message's text. `postChatOnce` searches for an interrupted
send before generating or posting again; its op includes the surface, channel, thread and
tag. `findTagged` must throw when it cannot finish the search. Undefined means a complete
search found nothing. Slack follows up to ten pages of 200 messages, requesting metadata
on each page; a failed response, broken cursor or page cap leaves the send pending.

The Slack host passes `legacySlackOp` for existing digest, reminder and nudge records, and
keeps their original metadata tags. Another surface ignores that migration key. This avoids
duplicate posts during an upgrade without replaying a Slack result on another platform.
Notifications are explicit surface-qualified accounts in `ChatMessage.notify`, supplied
from trusted configuration; the adapter never interprets model-written mentions as them.

Slack's implementations live in `apps/agents/src/teammate-bot/slack-surface.ts`, with
formatting in `slack-message.ts`. The inbound contract (`evals/chat-surface.test.ts`) and
outbound contract (`evals/chat-delivery.test.ts`) each run against Slack and a fake second
surface. The scheduled-post contract (`evals/scheduled-chat.test.ts`) covers both as well.
Give a new adapter the same contract checks. The Teammate host, approval cards and account
configuration still need platform-specific wiring; implementing
these interfaces alone does not enable a new live chat platform.

## Checks every change needs

- `pnpm typecheck && pnpm eval` must be green. CI runs both on Node 22 and 24.
- Behaviour changes come with an eval that fails without them. Try deleting the guarded
  line: if the eval stays green, it doesn't guard anything. For a safety control, add
  that deletion as a mutant in `scripts/mutate.ts`. `pnpm mutate` (weekly in CI) then
  keeps proving the eval still catches it.
- Retrieval changes must not lower `evals/baselines/retrieval.json`. If they raise the
  score, raise the baseline in the same commit.
