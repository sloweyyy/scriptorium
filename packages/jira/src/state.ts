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
  /**
   * Which source those questions were asked ABOUT.
   *
   * Part of the dedup key because "the same question" is only the same when it is about
   * the same document. A PM who answers "I can't find a PRD" by linking a Confluence page
   * has done something, and hearing nothing back cannot be distinguished from the link
   * having been ignored.
   */
  askedFromOrigin?: string;
  /** Attachments + description at the last drafting attempt — a retry only runs when the inputs change. */
  sourceFingerprint?: string;
  /**
   * Which pages this ticket linked to, as of the last look.
   *
   * Kept apart from `sourceFingerprint` because it is the one input Jira will not tell us
   * about: adding a remote link does not bump `fields.updated`, so the poller's change
   * gate cannot see it and the value has to be fetched and compared deliberately.
   */
  remoteLinkFingerprint?: string;
  /**
   * A draft was deferred because an upload was still arriving.
   *
   * Load-bearing: attachments are usually the LAST thing to touch a ticket, so the tick
   * that defers also records their timestamp as "seen" — and the untouched gate would then
   * park the ticket forever with the PRD sitting right there, waiting for a change that has
   * already happened.
   */
  awaitingUpload?: boolean;
  hasDraft?: boolean;
  docSlug?: string;
  sourcePrd?: string;
  /** `updated` from the last poll — lets an untouched issue skip its comment fetch. */
  lastUpdated?: string;
  /** Last failure reported on the ticket, so a repeating error is not commented every poll. */
  lastError?: string;
  /**
   * Jira's `created` time of the comment that posted the current draft. An approval older
   * than this was given to an EARLIER draft and is not an approval of this one.
   */
  draftPostedAt?: string;
  /**
   * sha256 of the draft text that comment carried: set only once it is on the ticket. The
   * saved draft is written before its comment is posted, so a failed post leaves a newer
   * draft than anyone has seen. Publishing requires the saved draft to hash to this.
   */
  postedDraftHash?: string;
  /** The published vault note's body, hashed at publish: a push retry sends only that text. */
  publishedBodyHash?: string;
  /** A first draft is saved and its comment hasn't posted yet (cleared once it has): the next tick posts it. */
  draftUnposted?: boolean;
  /**
   * The feedback a revision applied, and the draft it made: kept until that feedback is
   * marked done. A retry finds it on the saved draft (crashed before the post: post it;
   * after: nothing to do), applies only feedback that came since, and never applies any of
   * it twice. Recorded before the draft is saved, so a crash between finds another draft.
   */
  revision?: { feedback: string[]; draftHash: string; comment?: string };
  /**
   * First sight began and hasn't finished. The next tick adopts the ticket again: a recovery
   * that failed halfway (a lookup, a download) was otherwise never run again, and the ticket
   * was drafted from scratch.
   */
  adopting?: boolean;
  /** The agent took the ticket (assigned itself) and hasn't handed it back. */
  held?: boolean;
  /**
   * Follow-ups a publish still owes: the Slack announcement and the lesson proposal. Set
   * when the publish lands, each cleared once done, so a failure between them (the
   * "Published" comment, say) is finished by the retry instead of skipped as "already done".
   */
  announcePending?: boolean;
  lessonPending?: boolean;
  /** A comment whose command keeps failing: retried, but not forever. */
  failing?: { commentId: string; attempts: number };
  appliedLessons?: string[];
  feedback?: string[];
  /**
   * Who wrote each `feedback` item (Jira account id), index for index. Kept so an erasure
   * can drop what a person wrote, not only what happens to name them.
   */
  feedbackAuthors?: Array<string | null>;
  /**
   * False when a revision landed after the last publish — the current draft is newer
   * than the vault copy, so `approve` must republish rather than report "already
   * published". Undefined (older ledgers, restart recovery) reads as "published",
   * which errs toward not republishing without being asked.
   */
  draftPublished?: boolean;
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
  /** Who had the ticket before the agent took it to draft: the one it is handed back to. */
  handBackTo?: string;
  /**
   * Each lesson proposed on this ticket: the sha256 of the rule text the proposal comment
   * showed, and when that comment was posted. `approve lesson` signs only that text, and
   * only when the approving comment came after the proposal it approves.
   */
  proposedLessons?: Record<string, { bodyHash: string; postedAt?: string }>;
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
    let raw: string | undefined;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      // No state yet: start clean; every issue is then treated as first-sight.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== undefined) {
      // There, but unreadable: refuse to start, never start clean. A clean start overwrote the
      // real ledger at the first write and re-judged every ticket as if seen for the first time.
      let parsed: Partial<StateFile>;
      try {
        parsed = JSON.parse(raw) as Partial<StateFile>;
      } catch (error) {
        throw new Error(`${file} is unreadable (${error instanceof Error ? error.message : String(error)}); fix it or move it aside to start clean.`);
      }
      if (parsed && typeof parsed === "object" && parsed.issues) data = { version: 1, issues: parsed.issues };
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
  /** Begin first sight: a ticket's status, kept if it has one, and `adopting` until it is done. */
  async seed(key: string, status: string): Promise<IssueState> {
    return this.patch(key, { lastStatus: this.data.issues[key]?.lastStatus ?? status, adopting: true });
  }

  /**
   * Adopted: first sight finished. An entry written only by something else (the note of a
   * failure, which marks its own comment processed) is no adoption, and has no status.
   */
  adopted(key: string): boolean {
    const known = this.data.issues[key];
    return Boolean(known && !known.adopting && known.lastStatus !== undefined);
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

  /** Mark comments handled, and with them (in the same write) whatever their handling settles. */
  async markProcessed(key: string, commentIds: string[], settled: Partial<IssueState> = {}): Promise<void> {
    if (!commentIds.length && !Object.keys(settled).length) return;
    const current = this.data.issues[key];
    const merged = new Set([...(current?.processedComments ?? []), ...commentIds]);
    await this.patch(key, { processedComments: [...merged], ...settled });
  }

  async appendFeedback(key: string, feedback: string, author?: string): Promise<void> {
    const current = this.data.issues[key];
    const items = current?.feedback ?? [];
    // Padded for items recorded before authors were: index i stays item i's author.
    const authors = [...(current?.feedbackAuthors ?? []), ...Array<null>(Math.max(0, items.length - (current?.feedbackAuthors?.length ?? 0))).fill(null)].slice(0, items.length);
    await this.patch(key, { feedback: [...items, feedback], feedbackAuthors: [...authors, author ?? null] });
  }

  draftPath(key: string): string {
    return path.join(this.draftsDir, `${key}.md`);
  }

  async saveDraft(key: string, markdown: string): Promise<void> {
    // Written whole or not at all, like the state file: a torn draft is a draft nobody wrote.
    const temporary = `${this.draftPath(key)}.${process.pid}.tmp`;
    await fs.writeFile(temporary, markdown.trim() + "\n");
    await fs.rename(temporary, this.draftPath(key));
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
    const write = this.queue.then(async () => {
      const temporary = `${this.file}.tmp`;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(temporary, snapshot + "\n");
      await fs.rename(temporary, this.file);
    });
    // The queue keeps a tail that can't reject: one failed write (a full disk for a moment)
    // used to fail every later write until restart, on every ticket, while memory and disk
    // drifted apart. The next write carries the whole state, so disk catches up.
    this.queue = write.catch(() => undefined);
    await write;
  }
}
