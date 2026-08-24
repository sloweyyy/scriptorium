---
kind: prd
feature: Scheduled digest emails
audience: workspace admins
user_goal: get a periodic email summary of what happened in Beacon without checking the dashboard
status: approved
owner: pm.beacon
---

# PRD — Scheduled digest emails

## Problem

Admins currently only hear from Beacon when something is wrong — an incident fires, or a
maintenance window opens. There is no periodic "here's what happened" summary, so admins
who don't check the dashboard daily miss quiet incidents that were opened and resolved
between visits.

## Requirements

1. Admins configure a digest from **Notifications → Digest emails** in the admin console.
2. Frequency is **Daily** or **Weekly**. Weekly requires a **send day** (Monday–Sunday).
3. A **send time** is required, interpreted in the workspace's **timezone** (the timezone
   selector defaults to the workspace timezone, same as the maintenance announcement form).
4. Admins choose which sections the digest includes, via checkboxes: **Incidents**,
   **Maintenance**, **Usage summary**. At least one section must be selected.
5. In v1, the digest always goes to **all workspace admins** — there is no per-recipient
   configuration.
6. Saving with no changes is a no-op; there is no confirmation dialog.

## Out of scope

- A **Monthly** frequency option.
- Configurable recipients (a subset of admins, or non-admin roles).
- A "send a test digest now" action.

## UX notes

One wireframe attached: the digest settings form. Frequency and send time at top, section
checkboxes below, recipients shown as fixed text rather than a control, since v1 has
nothing to configure there.
