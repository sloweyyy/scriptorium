import { createHmac, timingSafeEqual } from "node:crypto";
import { sourceHash } from "./hash";

/**
 * Approvals the repository cannot forge.
 *
 * An approved lesson or memory lives in the vault, and the vault round-trips through a git
 * branch — so anyone with write access to that branch could mark a rule `approved` and
 * have it restored as law on the next boot. An approval signed with a key that exists only
 * in the deployment (never in the repo) cannot be minted that way; neither can an approved
 * rule's TEXT be edited afterwards, because the body is part of what is signed.
 */
export interface SignedApproval {
  id: string;
  status: string;
  body: string;
  approvedBy?: string;
  /**
   * Everything else that changes what the approval DOES — a memory's scope, a rule's check.
   * Unsigned, a person-scoped memory could be rewritten to `global` and still verify.
   */
  terms?: Record<string, string | undefined>;
}

export function approvalSignature(key: string, approval: SignedApproval): string {
  const terms = Object.entries(approval.terms ?? {})
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`);
  const payload = [approval.id, approval.status, sourceHash(approval.body), approval.approvedBy ?? "", ...terms].join("\u0000");
  return createHmac("sha256", key).update(payload).digest("hex");
}

/**
 * The deployment's signing key, read where approvals are USED — every list of lessons or
 * memories verifies, so no caller can forget to. Unset: approvals are unsigned and trusted.
 */
export function approvalSigningKey(): string | undefined {
  return process.env.SCRIPTORIUM_SIGNING_KEY || undefined;
}

/**
 * Keys that used to sign, accepted for VERIFYING only while approvals are moved onto the
 * current key (`pnpm resign`). This is what makes rotation safe: set the new key, move the
 * old one here, re-sign, then drop it. Nothing is ever signed with a previous key.
 */
export function previousSigningKeys(): string[] {
  return (process.env.SCRIPTORIUM_PREVIOUS_SIGNING_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

/**
 * A frontmatter value as the string it was written as. An unquoted ISO timestamp — which is
 * how Obsidian's property editor saves one — parses as a Date; it is still that timestamp.
 */
export function frontmatterString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return undefined;
}

/** The terms a lesson or memory's signature covers, from its frontmatter. */
export function approvalTerms(frontmatter: Record<string, unknown>): Record<string, string | undefined> {
  const pick = (key: string) => frontmatterString(frontmatter[key]);
  return { scope: pick("scope"), check_present: pick("check_present"), check_absent: pick("check_absent"), expires_at: pick("expires_at") };
}

/** Does this approved note carry a signature that matches it, under the deployment key (or one being rotated out)? */
export function approvalVerified(frontmatter: Record<string, unknown>, body: string, key = approvalSigningKey()): boolean {
  if (!key) return true;
  return signedWith(frontmatter, body, [key, ...previousSigningKeys()]) !== undefined;
}

/** Which of these keys signed this approved note, if any. */
export function signedWith(frontmatter: Record<string, unknown>, body: string, keys: readonly string[]): string | undefined {
  const id = typeof frontmatter.id === "string" ? frontmatter.id : "";
  const approvedBy = typeof frontmatter.approved_by === "string" ? frontmatter.approved_by : undefined;
  const approval = { id, status: "approved", body, approvedBy, terms: approvalTerms(frontmatter) };
  return keys.find((key) => verifyApprovalSignature(key, approval, frontmatter.approval_sig));
}

/** A fresh signature for an approved note, with the current key. Only call it on a note that already verified. */
export function resignApproval(frontmatter: Record<string, unknown>, body: string, key: string): string {
  const id = typeof frontmatter.id === "string" ? frontmatter.id : "";
  const approvedBy = typeof frontmatter.approved_by === "string" ? frontmatter.approved_by : undefined;
  return approvalSignature(key, { id, status: "approved", body, approvedBy, terms: approvalTerms(frontmatter) });
}

export function verifyApprovalSignature(key: string, approval: SignedApproval, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(approvalSignature(key, approval), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
