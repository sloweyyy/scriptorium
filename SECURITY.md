# Security policy

scriptorium's job is to keep an AI agent inside its bounds, so a way around a guardrail is a
security issue. That includes:
- a write without an approval;
- an approval that covers more than its card showed;
- a claim that passes grounding with no fetched record;
- reading outside the conversation or allow-list;
- anything that turns a refusal into an action.

## Reporting

Please don't open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/sloweyyy/scriptorium/security/advisories/new)
for this repository.

Include what you did and what you expected, and a failing eval if you can (the evals in
`evals/` show the pattern). We aim to acknowledge reports within a few days.

## What's in scope

The policy layer, approvals and signing, grounding, the connectors' allow-lists, turn
bindings, admin controls, the audit log, and the webhook signature checks. The threat model
and its known gaps are in [docs/security-model.md](docs/security-model.md). Issues already
listed there as known gaps are still welcome if you can show a concrete exploit.
