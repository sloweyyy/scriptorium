---
kind: prd
feature: Rate limit dashboard
audience: integrators
user_goal: see current API rate-limit usage and remaining quota in real time
status: approved
owner: pm.beacon
---

# PRD — Rate limit dashboard

## Problem

Integrators find out they are rate-limited only when a request fails with a 429.
There is no way to see usage before that happens.

## Requirements

1. A dashboard page shows current usage as a percentage of the plan's rate limit,
   per API key.
2. Usage updates every 30 seconds without a page reload.
3. When usage crosses 80%, the page shows a warning banner.
4. A table lists the last 10 requests that were rate-limited (429), with timestamp
   and endpoint.
5. Data covers a rolling 24-hour window.

## Out of scope

- Historical data beyond 24 hours.
- Email or webhook alerts on threshold crossing.
