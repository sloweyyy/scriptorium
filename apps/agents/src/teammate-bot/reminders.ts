import { randomUUID } from "node:crypto";
import type { ToolRunContext, ToolSpec } from "@scriptorium/core";
import { escapeMrkdwn } from "@scriptorium/connectors";
import type { EffectLedger } from "@scriptorium/runtime";
import { z } from "zod";

/**
 * Reminders a team asked for — "remind #eng on Friday at 9 to update estimates". A reminder
 * is a post the agent makes later, on its own, so it is approved once, when it is set, for
 * its exact text, channel and time (it is approve-tier like any write). It fires once, can be
 * listed and cancelled, and lives in its own durable ledger: pending is "in-progress", sent
 * or cancelled is "done".
 */
export interface Reminder {
  id: string;
  channel: string;
  at: string;
  text: string;
  approvedBy?: string;
}

const MAX_DAYS_AHEAD = 30;
const op = (id: string) => `reminder:${id}`;
const Schedule = z.object({ channel: z.string(), at: z.string().describe("When, as an ISO date-time with a timezone, e.g. 2026-10-02T09:00:00+07:00."), text: z.string().min(1).max(500) });

export function reminderTools(store: EffectLedger, now: () => number = () => Date.now()): ToolSpec[] {
  return [
    {
      name: "schedule_reminder",
      description: "Post a reminder in this channel at a set time (up to 30 days ahead). Requires human approval; nothing is scheduled until approved.",
      inputSchema: Schedule,
      run: async (input: unknown, context?: ToolRunContext) => {
        const parsed = Schedule.parse(input);
        const at = Date.parse(parsed.at);
        if (!Number.isFinite(at)) return "NOT_ALLOWED: `at` is not a date-time I can read.";
        if (at <= now()) return "NOT_ALLOWED: that time has already passed.";
        if (at > now() + MAX_DAYS_AHEAD * 24 * 3600 * 1000) return `NOT_ALLOWED: reminders can be set at most ${MAX_DAYS_AHEAD} days ahead.`;
        // One reminder per approval: a retry of the same approval is the same reminder.
        const id = context?.approval?.id ?? randomUUID();
        const existing = await store.get(op(id));
        const reminder: Reminder = { id, channel: parsed.channel, at: new Date(at).toISOString(), text: parsed.text, approvedBy: context?.approval?.approvedBy };
        if (!existing) await store.put({ op: op(id), status: "in-progress", startedAt: new Date(now()).toISOString(), meta: { kind: "teammate.reminder", ...reminder } });
        return `${existing ? "Already scheduled" : "Scheduled"} reminder ${id.slice(0, 8)} for ${reminder.at} in <#${parsed.channel}>.`;
      },
    },
    {
      name: "list_reminders",
      description: "List the reminders waiting to be posted in this channel.",
      inputSchema: z.object({ channel: z.string() }),
      run: async (input: unknown) => {
        const { channel } = z.object({ channel: z.string() }).parse(input);
        const pending = (await pendingReminders(store)).filter((reminder) => reminder.channel === channel);
        return pending.length ? JSON.stringify(pending.map(({ id, at, text }) => ({ id: id.slice(0, 8), at, text }))) : "No reminders are waiting in this channel.";
      },
    },
    {
      name: "cancel_reminder",
      description: "Cancel a waiting reminder in this channel (by the id list_reminders shows). Requires human approval.",
      inputSchema: z.object({ channel: z.string(), id: z.string().min(4) }),
      run: async (input: unknown) => {
        const { channel, id } = z.object({ channel: z.string(), id: z.string().min(4) }).parse(input);
        const matches = (await pendingReminders(store)).filter((reminder) => reminder.channel === channel && reminder.id.startsWith(id));
        if (matches.length !== 1) return `NOT_ALLOWED: ${matches.length ? "that id matches more than one reminder" : "no waiting reminder in this channel has that id"}.`;
        const record = await store.get(op((matches[0] as Reminder).id));
        if (record) await store.put({ ...record, status: "done", completedAt: new Date(now()).toISOString(), result: "cancelled" });
        return `Cancelled reminder ${id}.`;
      },
    },
  ];
}

export async function pendingReminders(store: EffectLedger): Promise<Reminder[]> {
  return (await store.inProgress())
    .map((record) => record.meta as (Reminder & { kind?: string }) | undefined)
    .filter((meta): meta is Reminder & { kind: string } => meta?.kind === "teammate.reminder")
    .map(({ kind: _kind, ...reminder }) => reminder)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Due now. A reminder more than a day late is not posted — "stand-up in 5 minutes" a day later is noise. */
export async function dueReminders(store: EffectLedger, nowMs: number): Promise<{ due: Reminder[]; stale: Reminder[] }> {
  const pending = (await pendingReminders(store)).filter((reminder) => Date.parse(reminder.at) <= nowMs);
  return {
    due: pending.filter((reminder) => nowMs - Date.parse(reminder.at) <= 24 * 3600 * 1000),
    stale: pending.filter((reminder) => nowMs - Date.parse(reminder.at) > 24 * 3600 * 1000),
  };
}

/** As posted: the approved text, escaped so it can't ping a channel or hide a link. */
export function reminderText(reminder: Reminder): string {
  return `⏰ *Reminder:* ${escapeMrkdwn(reminder.text)}${reminder.approvedBy ? `\n_Set on request, approved by ${escapeMrkdwn(reminder.approvedBy)}_` : ""}`;
}

export async function markReminder(store: EffectLedger, reminder: Reminder, result: "sent" | "stale", nowMs: number): Promise<void> {
  const record = await store.get(op(reminder.id));
  if (record) await store.put({ ...record, status: "done", completedAt: new Date(nowMs).toISOString(), result });
}
