import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { previousSigningKeys } from "@scriptorium/core";

/**
 * The Teammate's runtime controls: what an admin can change without a redeploy, when a tool
 * misbehaves at 2am. They only ever NARROW what the deployment allows — pause everything,
 * make it read-only, or switch named tools off — never widen it.
 *
 * A file in the state dir, signed with the deployment key when there is one. A file that
 * can't be read or doesn't verify means PAUSED: a control that failed must not quietly
 * become "everything on".
 */
export interface Control {
  paused: boolean;
  readOnly: boolean;
  denyTools: string[];
  /**
   * An approver who is away, stood in for until a date: `to` may approve what `from` may.
   * The one control that widens — so only an admin sets it, it is signed, it ends by itself,
   * and the stand-in is still never the requester (separation of duties is unchanged).
   */
  delegations?: Delegation[];
  /** Who changed it last, when, and why — also on the audit log. */
  by?: string;
  at?: string;
  reason?: string;
}

export interface Delegation {
  /** Slack user ids. */
  from: string;
  to: string;
  /** ISO date-time the delegation ends. */
  until: string;
}

export const OPEN: Control = { paused: false, readOnly: false, denyTools: [] };

function signature(key: string, control: Control): string {
  const delegations = [...(control.delegations ?? [])].sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`));
  // Delegations are signed only when present, so control files written before they existed still verify.
  const body = JSON.stringify({ paused: control.paused, readOnly: control.readOnly, denyTools: [...control.denyTools].sort(), by: control.by ?? "", at: control.at ?? "", reason: control.reason ?? "", ...(delegations.length ? { delegations } : {}) });
  return createHmac("sha256", key).update(body).digest("hex");
}

export async function readControl(file: string, key?: string): Promise<Control> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    // Never set: nothing narrowed. Any other read failure: paused.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? OPEN : { ...OPEN, paused: true, reason: "the control file could not be read" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Control> & { sig?: string };
    const control: Control = {
      paused: parsed.paused === true,
      readOnly: parsed.readOnly === true,
      denyTools: Array.isArray(parsed.denyTools) ? parsed.denyTools.filter((tool): tool is string => typeof tool === "string") : [],
      ...(Array.isArray(parsed.delegations) && parsed.delegations.length
        ? {
            delegations: (parsed.delegations as unknown[]).filter(
              (entry): entry is Delegation =>
                typeof (entry as Delegation)?.from === "string" && typeof (entry as Delegation)?.to === "string" && typeof (entry as Delegation)?.until === "string",
            ),
          }
        : {}),
      by: typeof parsed.by === "string" ? parsed.by : undefined,
      at: typeof parsed.at === "string" ? parsed.at : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
    if (key) {
      // The current key, or one being rotated out (SCRIPTORIUM_PREVIOUS_SIGNING_KEYS).
      const given = Buffer.from(typeof parsed.sig === "string" ? parsed.sig : "", "hex");
      const matches = [key, ...previousSigningKeys()].some((candidate) => {
        const expected = Buffer.from(signature(candidate, control), "hex");
        return given.length === expected.length && timingSafeEqual(given, expected);
      });
      if (!matches) return { ...OPEN, paused: true, reason: "the control file's signature does not match" };
    }
    return control;
  } catch {
    return { ...OPEN, paused: true, reason: "the control file is not valid JSON" };
  }
}

export async function writeControl(file: string, control: Control, key?: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ ...control, ...(key ? { sig: signature(key, control) } : {}) }, null, 2));
  await fs.rename(tmp, file);
}

/** The tool tiers a turn gets under these controls: denied tools gone, and read-only drops every write. */
export function narrowTools<T extends string | { tier: string }>(tools: Readonly<Record<string, T>>, control: Control): Record<string, T> {
  return Object.fromEntries(
    Object.entries(tools).filter(([name, rule]) => {
      if (control.denyTools.includes(name)) return false;
      const tier = typeof rule === "string" ? rule : rule.tier;
      return !(control.readOnly && tier === "approve");
    }),
  );
}

/** `/teammate admin …` → the new controls, or a message saying why not. Pure. */
export function applyAdminCommand(current: Control, args: string, admin: string, now: Date, knownTools: readonly string[]): { control: Control; message: string } | { message: string } {
  const [verb = "", ...rest] = args.trim().split(/\s+/);
  const stamp = (control: Omit<Control, "by" | "at">, message: string) => ({ control: { ...control, by: admin, at: now.toISOString() }, message });
  switch (verb.toLowerCase()) {
    case "status":
    case "":
      return { message: describeControl(current) };
    case "pause":
      return stamp({ ...current, paused: true, reason: rest.join(" ") || undefined }, "⏸️ Paused. I answer nothing and carry nothing out until `/teammate admin resume`.");
    case "resume":
      return stamp({ ...current, paused: false, reason: undefined }, "▶️ Resumed.");
    case "readonly": {
      const on = (rest[0] ?? "").toLowerCase();
      if (on !== "on" && on !== "off") return { message: "Use `/teammate admin readonly on` or `… off`." };
      return stamp({ ...current, readOnly: on === "on" }, on === "on" ? "🔒 Read-only: I answer, but propose no changes." : "🔓 Writes are back (each still waits for an approver).");
    }
    case "deny":
    case "allow": {
      const tool = rest[0] ?? "";
      if (!knownTools.includes(tool)) return { message: `No tool called \`${tool}\` here. Known: ${knownTools.map((name) => `\`${name}\``).join(", ")}.` };
      const denyTools = verb === "deny" ? [...new Set([...current.denyTools, tool])] : current.denyTools.filter((name) => name !== tool);
      return stamp({ ...current, denyTools }, verb === "deny" ? `🚫 \`${tool}\` is off.` : `✅ \`${tool}\` is back on (as the deployment allows it).`);
    }
    case "delegate": {
      // delegate <@from> <@to> <YYYY-MM-DD>
      const [from, to, date] = rest.map((word) => word.replace(/^<@([A-Z0-9]+)(\|[^>]*)?>$/, "$1"));
      const until = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T23:59:59Z`) : undefined;
      if (!from || !to || !until || Number.isNaN(until.getTime())) return { message: "Use `/teammate admin delegate @away @standin YYYY-MM-DD`." };
      if (from === to) return { message: "Someone can't stand in for themselves." };
      if (until.getTime() <= now.getTime() || until.getTime() > now.getTime() + 60 * 86_400_000) return { message: "The end date must be in the future, and at most 60 days away." };
      const delegations = [...(current.delegations ?? []).filter((entry) => entry.from !== from), { from, to, until: until.toISOString() }];
      return stamp({ ...current, delegations }, `🤝 <@${to}> can approve what <@${from}> can, until ${date}. Separation of duties still applies.`);
    }
    case "undelegate": {
      const from = (rest[0] ?? "").replace(/^<@([A-Z0-9]+)(\|[^>]*)?>$/, "$1");
      const delegations = (current.delegations ?? []).filter((entry) => entry.from !== from);
      if (delegations.length === (current.delegations ?? []).length) return { message: `No delegation from <@${from}>.` };
      return stamp({ ...current, delegations }, `Delegation from <@${from}> ended.`);
    }
    default:
      return { message: "Admin commands: `status`, `pause [reason]`, `resume`, `readonly on|off`, `deny <tool>`, `allow <tool>`, `delegate @away @standin YYYY-MM-DD`, `undelegate @away`." };
  }
}

/**
 * The envelope as a click is judged against it: each active delegation adds the stand-in
 * wherever the away approver is listed. Nothing else changes — denials, tiers and
 * separation of duties are the envelope's own.
 */
export function withDelegations<E extends { tools: Readonly<Record<string, { approvers?: readonly string[] }>>; people?: ReadonlyArray<ReadonlyArray<string>> }>(envelope: E, control: Control, now = Date.now()): E {
  const active = (control.delegations ?? []).filter((entry) => Date.parse(entry.until) > now);
  if (!active.length) return envelope;
  const tools = Object.fromEntries(
    Object.entries(envelope.tools).map(([name, rule]) => {
      const approvers = rule.approvers ?? [];
      const added = active.filter((entry) => approvers.includes(`slack:${entry.from}`)).map((entry) => `slack:${entry.to}`);
      return [name, added.length ? { ...rule, approvers: [...new Set([...approvers, ...added])] } : rule];
    }),
  );
  // A stand-in is the away approver, for separation of duties too: without this, an approver
  // who delegated to a second account of their own could approve their own requests from it,
  // a right the delegator never had.
  const people = [...(envelope.people ?? []), ...active.map((entry) => [`slack:${entry.from}`, `slack:${entry.to}`])];
  return { ...envelope, tools, people };
}

export function describeControl(control: Control): string {
  if (control.paused) return `⏸️ Paused${control.reason ? ` — ${control.reason}` : ""}${control.by ? ` (by ${control.by}, ${control.at})` : ""}.`;
  const delegations = (control.delegations ?? []).filter((entry) => Date.parse(entry.until) > Date.now()).map((entry) => `<@${entry.to}> for <@${entry.from}> until ${entry.until.slice(0, 10)}`);
  const parts = [
    control.readOnly ? "read-only" : "writes on (each needs an approver)",
    control.denyTools.length ? `off: ${control.denyTools.join(", ")}` : "no tools switched off",
    ...(delegations.length ? [`standing in: ${delegations.join("; ")}`] : []),
  ];
  return `▶️ Running — ${parts.join("; ")}.`;
}
