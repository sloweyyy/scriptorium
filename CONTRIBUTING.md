# Contributing

Thanks for helping. A few things keep this project the way it is.

## Before you open a pull request

- `pnpm typecheck` and `pnpm eval` pass. Both run with no API key.
- A behavior change comes with an eval that fails without it. Try deleting the line you
  added: if the eval stays green, it doesn't test anything.
- A new safety control (anything that refuses, gates or bounds) also gets a mutant in
  [`scripts/mutate.ts`](scripts/mutate.ts), and `pnpm mutate` shows it caught.
- Retrieval changes must not lower `evals/baselines/retrieval.json`.

## Design rules

These are in [docs/architecture.md](docs/architecture.md). In short:

- **Fail closed.** Unset or unreadable means less is allowed, never more.
- **Every write is approve-tier.** A new write tool is approve-tier in the agent's envelope.
- **No citation, no claim.** A new read tool declares `records` from its validated input, so
  answers can cite it.
- **Files and git are the system of record.** No database.
- **Take words from the model, never a query language.**

New jobs are usually a skill in `skills/` plus a line in the agent's config, not a new bot.
See [docs/extending.md](docs/extending.md).

## Content

Sample content is the fictional "Beacon" product. Don't add real company, employer or
customer content to the repo or the vault.
