import fs from "node:fs/promises";
import path from "node:path";
import type { JiraComment } from "./types";

/**
 * Per-issue resume state for the poller.
 *
 * This is scratch, not evidence: it lives outside the vault and outside git (see
 * `.gitignore`), because an unapproved draft must never reach the repository. What
 * happened — drafted, revised, published, lesson approved — goes to the append-only
 * audit log instead.
 */
export interface IssueState {
  key: string;
  firstSeen: string;
  /** Status at the last poll; a change into the approved status is the approval signal. */
  lastStatus?: string;
  /** Every comment id already acted on — including the agent's own posts, so it never answers itself. */
  processedComments: string[];
  /**
   * True once the agent has taken part here: drafted, published, or answered a mention.
   *
   * On a ticket without the auto-draft label this is the line between "someone else's
   * conversation" and "a thread I am in": plain feedback before engagement is not
   * addressed to the agent and must not trigger a revise.
   */
  engaged?: boolean;
  /** Contract fields already asked about, so the same question is not posted twice. */
  askedForFields?: string[];
  /** Attachments + description at the last drafting attempt — a retry only runs when the inputs change. */
  sourceFingerprint?: string;
  hasDraft?: boolean;
  docSlug?: string;
  sourcePrd?: string;
  /** `updated` from the last poll — lets an untouched issue skip its comment fetch. */
  lastUpdated?: string;
  /** Last failure reported on the ticket, so a repeating error is not commented every poll. */
  lastError?: string;
  appliedLessons?: string[];
  feedback?: string[];
  publishedPath?: string;
  /**
   * Whether the docs-repo push for this doc actually succeeded.
   *
   * Separate from `publishedPath` because the two can disagree: the vault copy is written
   * and committed locally, and then the push fails. Without this, `approve` short-circuits
   * on "already published" and the egress can never be retried from the ticket.
   */
  docsPushed?: boolean;
  pendingLessonId?: string;
}

interface StateFile {
  version: 1;
  issues: Record<string, IssueState>;
}

const EMPTY: StateFile = { version: 1, issues: {} };

/**
 * The downtime rule, for a ticket whose ledger was lost but which the agent has clearly
 * worked before: **everything up to and including the agent's own last comment is
 * history; everything after it is unprocessed.**
 *
 * Both alternatives are bugs. Marking the whole thread processed swallows a mention
 * posted while the agent was down — the exact silence this surface exists to avoid.
 * Marking nothing replays pre-restart feedback and posts a duplicate revision.
 *
 * With no comment of its own the agent has never spoken here, so there is no cutoff and
 * nothing is history: a `@Scribe` typed before the agent ever polled still gets answered.
 */
export function splitAtLastOwnComment(
  comments: JiraComment[],
  botAccountId?: string,
): { history: JiraComment[]; unprocessed: JiraComment[] } {
  let cutoff = -1;
  for (const [index, comment] of comments.entries()) {
    if (botAccountId && comment.author?.accountId === botAccountId) cutoff = index;
  }
  return { history: comments.slice(0, cutoff + 1), unprocessed: comments.slice(cutoff + 1) };
}

export class JiraState {
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly draftsDir: string,
    private data: StateFile,
  ) {}

  static async open(stateDir: string): Promise<JiraState> {
    const file = path.join(stateDir, "jira-state.json");
    const draftsDir = path.join(stateDir, "drafts");
    await fs.mkdir(draftsDir, { recursive: true });

    let data: StateFile = { ...EMPTY, issues: {} };
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<StateFile>;
      if (parsed && typeof parsed === "object" && parsed.issues) data = { version: 1, issues: parsed.issues };
    } catch {
      // No state yet (or unreadable) — start clean; every issue is then treated as first-sight.
    }
    return new JiraState(file, draftsDir, data);
  }

  get(key: string): IssueState | undefined {
    return this.data.issues[key];
  }

  isProcessed(key: string, commentId: string): boolean {
    return this.data.issues[key]?.processedComments.includes(commentId) ?? false;
  }

  /**
   * First sight of an issue: record where it already is without acting on it.
   * Without this, an issue that was already in "Approved" when the agent booted
   * would look like a fresh approval and publish itself.
   */
  async seed(key: string, status: string): Promise<IssueState> {
    const existing = this.data.issues[key];
    if (existing) return existing;
    return this.patch(key, { lastStatus: status });
  }

  async patch(key: string, patch: Partial<IssueState>): Promise<IssueState> {
    const current: IssueState = this.data.issues[key] ?? {
      key,
      firstSeen: new Date().toISOString(),
      processedComments: [],
    };
    const next: IssueState = { ...current, ...patch, key };
    this.data.issues[key] = next;
    await this.flush();
    return next;
  }

  async markProcessed(key: string, commentIds: string[]): Promise<void> {
    if (!commentIds.length) return;
    const current = this.data.issues[key];
    const merged = new Set([...(current?.processedComments ?? []), ...commentIds]);
    await this.patch(key, { processedComments: [...merged] });
  }

  async appendFeedback(key: string, feedback: string): Promise<void> {
    const current = this.data.issues[key];
    await this.patch(key, { feedback: [...(current?.feedback ?? []), feedback] });
  }

  draftPath(key: string): string {
    return path.join(this.draftsDir, `${key}.md`);
  }

  async saveDraft(key: string, markdown: string): Promise<void> {
    await fs.writeFile(this.draftPath(key), markdown.trim() + "\n");
  }

  async readDraft(key: string): Promise<string | undefined> {
    try {
      return await fs.readFile(this.draftPath(key), "utf8");
    } catch {
      return undefined;
    }
  }

  /** Serialized atomic write — polls overlap, and a torn state file loses the comment ledger. */
  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.queue = this.queue.then(async () => {
      const temporary = `${this.file}.tmp`;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, snapshot + "\n");
      await fs.rename(temporary, this.file);
    });
    await this.queue;
  }
}
