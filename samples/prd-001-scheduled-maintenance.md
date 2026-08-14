---
kind: prd
feature: Scheduled maintenance announcements
audience: workspace admins
user_goal: Notify status-page subscribers about planned maintenance before it starts
status: approved
owner: pm.beacon
---

# PRD — Scheduled maintenance announcements

## Problem

Beacon workspaces can report incidents when something is already broken, but admins have
no way to tell subscribers about *planned* maintenance ahead of time. Subscribers find out
when the status page flips to degraded, file support tickets, and lose trust. Competitors
ship scheduled maintenance as a baseline feature.

## Requirements

1. Admins can create a maintenance announcement from **Announcements → New maintenance**
   in the admin console.
2. An announcement has: a **title** (required, max 120 chars), a **start** and **end**
   time with an explicit **timezone selector** (defaults to the workspace timezone), the
   list of **affected components** (checkboxes from the workspace's component list), and
   an optional description.
3. A **"Notify subscribers"** toggle (on by default). When on, subscribers receive an
   email when the announcement is published and a reminder 1 hour before the start time.
4. Publishing requires title, start, end, and at least one affected component. End must
   be after start.
5. Between start and end, the public status page shows a **maintenance banner** with the
   title and time window rendered in the *visitor's* local timezone; affected components
   show a wrench icon instead of a status dot.
6. Announcements can be edited or cancelled until the end time. Cancelling notifies
   subscribers only if the start notification had already been sent.

## Out of scope

- Recurring maintenance windows.
- SMS or webhook notifications (email only for v1).

## UX notes

Two wireframes attached: the **create form** (fields and toggle laid out top-to-bottom,
Publish as primary action) and the **status-page banner** (amber strip pinned above the
component list).
