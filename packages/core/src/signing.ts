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
}

export function approvalSignature(key: string, approval: SignedApproval): string {
  const payload = [approval.id, approval.status, sourceHash(approval.body), approval.approvedBy ?? ""].join("\u0000");
  return createHmac("sha256", key).update(payload).digest("hex");
}

export function verifyApprovalSignature(key: string, approval: SignedApproval, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(approvalSignature(key, approval), "hex");
  const given = Buffer.from(signature, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
