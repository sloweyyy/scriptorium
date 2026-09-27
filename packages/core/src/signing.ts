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

/** The terms a lesson or memory's signature covers, from its frontmatter. */
export function approvalTerms(frontmatter: Record<string, unknown>): Record<string, string | undefined> {
  const pick = (key: string) => (typeof frontmatter[key] === "string" ? (frontmatter[key] as string) : undefined);
  return { scope: pick("scope"), check_present: pick("check_present"), check_absent: pick("check_absent") };
}

/** Does this approved note carry a signature that matches it, under the deployment key? */
export function approvalVerified(frontmatter: Record<string, unknown>, body: string, key = approvalSigningKey()): boolean {
  if (!key) return true;
  const id = typeof frontmatter.id === "string" ? frontmatter.id : "";
  const approvedBy = typeof frontmatter.approved_by === "string" ? frontmatter.approved_by : undefined;
  return verifyApprovalSignature(key, { id, status: "approved", body, approvedBy, terms: approvalTerms(frontmatter) }, frontmatter.approval_sig);
}

export function verifyApprovalSignature(key: string, approval: SignedApproval, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(approvalSignature(key, approval), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
