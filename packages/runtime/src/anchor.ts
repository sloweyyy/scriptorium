import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isAlias } from "./event";

/**
 * One conversation, whatever surface it is on.
 *
 * A Slack thread that files a ticket, then the ticket's own comments, are one piece of work.
 * Each conversation gets an opaque anchor id; every external key it is known by
 * (`slack:thread:C1/1.0`, `jira:issue:DOC-12`, `discord:thread:G1/2.0`) is an alias of it.
 *
 * Rules, each the point of the store:
 * - The anchor id is opaque. It carries nothing of any alias, so nothing can be read into
 *   it or forged from a channel or issue key.
 * - An alias belongs to one anchor, for good. `bind` never moves it: otherwise a crafted
 *   message or a confused model could merge someone else's conversation into this one.
 * - The runtime binds an alias only as the side effect of a real action — a tool call that
 *   ran, read from the tool's own output (`GuardDeps.onRan`) — never because a model or a
 *   message said so.
 */
export interface Anchors {
  /** The anchor this alias is bound to, minting one on first sight. Undefined for a malformed alias. */
  anchorFor(alias: string): string | undefined;
  /** The anchor this alias is bound to, if any. Never mints. */
  resolve(alias: string): string | undefined;
  /** Bind an alias to an anchor. False for a malformed alias or one already bound elsewhere. */
  bind(anchor: string, alias: string): boolean;
  /** Every alias bound to this anchor. */
  aliasesOf(anchor: string): string[];
}

interface Ledger {
  aliases: Record<string, string>;
}

/**
 * Anchors on disk (`.scriptorium-state/anchors.json`), so a restart, or a second instance on
 * the same file, sees the same conversations. Read on every call and written atomically
 * (tmp + rename), synchronously, so one process can't interleave two updates.
 */
export class FileAnchors implements Anchors {
  constructor(private readonly file: string) {}

  anchorFor(alias: string): string | undefined {
    if (!isAlias(alias)) return undefined;
    const ledger = this.read();
    if (!ledger) return undefined;
    const bound = ledger.aliases[alias];
    if (bound) return bound;
    const anchor = `anc_${randomUUID().replace(/-/g, "")}`;
    ledger.aliases[alias] = anchor;
    return this.write(ledger) ? anchor : undefined;
  }

  resolve(alias: string): string | undefined {
    return this.read()?.aliases[alias];
  }

  bind(anchor: string, alias: string): boolean {
    if (!isAlias(alias) || !anchor) return false;
    const ledger = this.read();
    if (!ledger) return false;
    const bound = ledger.aliases[alias];
    if (bound) return bound === anchor;
    ledger.aliases[alias] = anchor;
    return this.write(ledger);
  }

  aliasesOf(anchor: string): string[] {
    return Object.entries(this.read()?.aliases ?? {})
      .filter(([, bound]) => bound === anchor)
      .map(([alias]) => alias);
  }

  /**
   * The ledger on disk. A missing file is an empty ledger; anything else that can't be read or
   * parsed (EACCES, EIO, a truncated or half-replaced file) is undefined, and callers then
   * write nothing: writing over it would erase every binding it holds, and a bound alias
   * would be free to move. The event still runs, on its own key's lane.
   */
  private read(): Ledger | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { aliases: {} };
      console.warn(`[anchors] could not read the ledger: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as { aliases?: unknown };
      if (!parsed || typeof parsed !== "object" || !parsed.aliases || typeof parsed.aliases !== "object") throw new Error("no aliases map");
      const aliases: Record<string, string> = {};
      for (const [alias, anchor] of Object.entries(parsed.aliases as Record<string, unknown>)) {
        if (typeof anchor === "string" && isAlias(alias)) aliases[alias] = anchor;
      }
      return { aliases };
    } catch (error) {
      console.warn(`[anchors] the ledger does not parse, leaving it as it is: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private write(ledger: Ledger): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(ledger));
      fs.renameSync(tmp, this.file);
      return true;
    } catch (error) {
      // Without the record the event still runs, on its own key's lane.
      console.warn(`[anchors] could not record an alias: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
