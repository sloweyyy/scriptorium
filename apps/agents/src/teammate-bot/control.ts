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
  /** Who changed it last, when, and why — also on the audit log. */
  by?: string;
  at?: string;
  reason?: string;
}

export const OPEN: Control = { paused: false, readOnly: false, denyTools: [] };

function signature(key: string, control: Control): string {
  const body = JSON.stringify({ paused: control.paused, readOnly: control.readOnly, denyTools: [...control.denyTools].sort(), by: control.by ?? "", at: control.at ?? "", reason: control.reason ?? "" });
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
    default:
      return { message: "Admin commands: `status`, `pause [reason]`, `resume`, `readonly on|off`, `deny <tool>`, `allow <tool>`." };
  }
}

export function describeControl(control: Control): string {
  if (control.paused) return `⏸️ Paused${control.reason ? ` — ${control.reason}` : ""}${control.by ? ` (by ${control.by}, ${control.at})` : ""}.`;
  const parts = [control.readOnly ? "read-only" : "writes on (each needs an approver)", control.denyTools.length ? `off: ${control.denyTools.join(", ")}` : "no tools switched off"];
  return `▶️ Running — ${parts.join("; ")}.`;
}
