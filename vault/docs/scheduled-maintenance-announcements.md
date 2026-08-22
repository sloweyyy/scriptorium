---
kind: doc
status: published
feature: Scheduled Maintenance Announcements
source: '[[prd/scheduled-maintenance-announcements]]'
approved_by: Truong (smoke test)
published_at: '2026-08-22T11:35:15.295Z'
---
# Scheduled Maintenance Announcements

## Overview
Scheduled maintenance announcements allow workspace admins to notify status-page subscribers about planned maintenance before it begins. This helps prevent unexpected support tickets and maintains subscriber trust by communicating the maintenance window in advance. During the maintenance window, the public status page displays a dedicated banner and updates affected component statuses automatically.

## Prerequisites
None.

## Steps
1. Navigate to **Announcements** > **New maintenance** in the Beacon Admin console.
2. Enter a **Title** for the maintenance (maximum of 120 characters).
3. Enter the scheduled **Start** and **End** dates and times, ensuring the end time is after the start time.
4. Select the appropriate **Timezone** from the dropdown menu (this defaults to your workspace timezone).
5. Under **Affected components**, select the checkboxes for the specific components that will be impacted.
6. (Optional) Enter additional details in the **Description (optional)** text field.
7. Choose whether to toggle **Notify subscribers** on or off (this is enabled by default to send an email upon publication and a reminder 1 hour before the start time).
8. Click **Publish** to schedule the maintenance.

## FAQ

**What do subscribers see on the status page during the maintenance window?**
Between the scheduled start and end times, the public status page displays an amber maintenance banner showing the maintenance title and the time window rendered in the visitor's local timezone. Additionally, the status dots for any selected affected components are replaced by a wrench icon.

**Can I edit or cancel a scheduled maintenance announcement?**
Yes. You can edit or cancel an announcement at any time until its scheduled end time. If you cancel the maintenance, subscribers will only receive a cancellation email if the initial publication notification had already been sent.

**What notification channels are used to alert subscribers?**
Notifications are sent via email only. Recurring maintenance windows, SMS notifications, and webhook notifications are not supported.

**What fields are required to publish a maintenance announcement?**
To publish, you must provide a title, a start time, an end time that is set after the start time, and select at least one affected component.
