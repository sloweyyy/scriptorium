---
kind: prd
feature: Status page subscriber management
audience: workspace admins
user_goal: Control who receives status notifications and how often they arrive
status: approved
owner: pm.beacon
---

# PRD — Status page subscriber management

## Problem

Anyone can subscribe to a Beacon status page, but admins cannot see who is subscribed,
cannot remove a subscriber who left the customer's team, and cannot offer anything
between "every update, immediately" and "nothing at all". Enterprise customers ask for
both — a subscriber list they can audit, and a digest for people who only need the daily
summary.

## Requirements

1. **Subscribers → Manage** in the admin console lists every subscriber with their email,
   the components they follow, their delivery mode, and the date they subscribed.
2. Admins can **remove** a subscriber. Removal is immediate and sends no notification.
3. Admins can **invite** subscribers by entering up to 50 email addresses at once. Each
   invited address receives a confirmation email and only becomes a subscriber after
   confirming.
4. Each subscriber chooses a **delivery mode**: *Immediate* (an email per status change)
   or *Daily digest* (one email covering the previous 24 hours). Immediate is the default.
5. Admins set the workspace's **digest send time** — an hour of the day plus a timezone
   selector, defaulting to the workspace timezone. The digest is skipped entirely on days
   with no status changes.
6. A subscriber can change their own delivery mode or unsubscribe from the footer link in
   any status email; those changes appear in the admin list within a minute.
7. The subscriber list can be **exported as CSV** (email, components, delivery mode,
   subscribed date). Export is available to workspace admins only.

## Out of scope

- Per-component delivery modes (a subscriber's mode applies to everything they follow).
- SMS and webhook delivery.
- Importing subscribers from a CSV — invites only for v1.

## UX notes

The manage screen is a table with a search box and a bulk-select column; *Invite
subscribers* is the primary action, *Export CSV* is secondary. Delivery mode renders as a
two-option segmented control inside each row.

## Why this PRD is here

Second sample, deliberately sharing vocabulary with `prd-001` (subscribers, components,
timezones, notification emails). Approve a lesson on the maintenance doc, then draft this
one: the house rule shows up in the new draft without anyone repeating the feedback.
