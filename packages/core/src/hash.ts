import { createHash } from "node:crypto";

/**
 * What a source said when a doc was approved from it: a hash of the note's BODY, line
 * endings normalised. Body only, because Curator rewrites a filed note's frontmatter (filed
 * times, links) without the product changing; the body changing is what makes a page stale.
 */
export function sourceHash(body: string): string {
  return createHash("sha256").update(body.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);
}
