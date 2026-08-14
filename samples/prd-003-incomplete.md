---
kind: prd
feature: Incident timeline embed
status: draft
owner: pm.beacon
---

# PRD — Incident timeline embed

## Problem

Customers want to show Beacon incident history inside their own dashboards instead of
linking out to the status page.

## Requirements

1. An embeddable iframe widget that renders the last 30 days of incidents for selected
   components.
2. Read-only; no authentication for public status pages.

## Notes

Deliberately incomplete sample: `audience` and `user_goal` are missing from the
frontmatter, so Scribe must refuse to draft and ask for them instead.
