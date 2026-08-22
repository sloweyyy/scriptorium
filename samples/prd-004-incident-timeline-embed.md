---
kind: prd
feature: Incident timeline embed
audience: workspace admins
user_goal: Embed a read-only incident timeline on any external page
status: approved
owner: pm.beacon
---

# PRD — Incident timeline embed

## Problem

Customers mirror Beacon incident updates into their own help centers by hand. During a
live incident the copies drift within minutes, and support ends up fielding "your status
page says X but your help center says Y" tickets while trying to fix the incident itself.

## Requirements

1. **Settings → Status page → Embed timeline** generates a copyable HTML snippet.
2. The embed renders the current incident timeline **read-only**: title, severity,
   affected components, and each update with its timestamp.
3. Timestamps in the embed render in the **viewer's local timezone**.
4. Content refreshes automatically every 60 seconds without a page reload.
5. Admins can scope the embed to **selected components** at snippet-generation time;
   the scope is baked into the snippet, not editable by the page that hosts it.
6. The embed works with **no authentication** — it can only ever show what the public
   status page already shows.
7. Regenerating a snippet **revokes** the previous one. Pages holding a revoked snippet
   render a "timeline unavailable" placeholder rather than stale content.

## Out of scope

- Write access of any kind from the embed.
- Historical incidents older than 90 days.
- Theming beyond light/dark auto-detection.
