import { once, opKey, type EffectLedger } from "@scriptorium/runtime";

/**
 * The weekly digest's timing and its once-ness.
 *
 * Posting is an effect keyed by channel + ISO week, so a restart, a second instance during
 * a deploy, or an hourly check that fires twice in the due hour all produce ONE digest.
 */

/** ISO-8601 week, e.g. `2026-W39` — the unit the digest is posted once per. */
export function isoWeek(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface DigestSchedule {
  /** 1 = Monday … 7 = Sunday, in UTC. */
  weekday: number;
  /** Hour of day, UTC. The digest goes out at the first check at or after it. */
  hour: number;
}

/** Due once the scheduled weekday+hour has passed this week. `once` makes the rest idempotent. */
export function digestDue(now: Date, schedule: DigestSchedule): boolean {
  const weekday = now.getUTCDay() || 7;
  return weekday > schedule.weekday || (weekday === schedule.weekday && now.getUTCHours() >= schedule.hour);
}

export async function postDigestOnce(
  ledger: EffectLedger,
  channel: string,
  now: Date,
  produce: () => Promise<string>,
  post: (text: string) => Promise<void>,
): Promise<{ posted: boolean }> {
  const { replayed } = await once(ledger, opKey("digest", channel, isoWeek(now)), async () => {
    await post(await produce());
    return true;
  });
  return { posted: !replayed };
}
