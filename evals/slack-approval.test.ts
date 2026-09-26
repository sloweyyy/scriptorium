import { describe, expect, it } from "vitest";
import { approvalButtonValue, draftFingerprint, mayApproveInSlack, parseApprovalButtonValue } from "@scriptorium/agents";

/**
 * The Slack "Approve & publish" button. It used to accept a click from anyone in the
 * channel, stay live after a decision, and publish whatever draft was current when it was
 * clicked — not the one it announced.
 */
describe("slack approval button", () => {
  it("nobody may approve from Slack until approvers are configured", () => {
    expect(mayApproveInSlack([], "U1")).toMatchObject({ ok: false, reason: expect.stringContaining("Comment `approve`") });
  });

  it("only a listed Slack user may approve, and an unidentified click never does", () => {
    expect(mayApproveInSlack(["U1"], "U1")).toEqual({ ok: true });
    expect(mayApproveInSlack(["U1"], "U2").ok).toBe(false);
    expect(mayApproveInSlack(["U1"], undefined).ok).toBe(false);
  });

  it("the button names the exact draft it was posted for", () => {
    const value = approvalButtonValue("DOC-7", "# Digest\n\nv1");
    expect(parseApprovalButtonValue(value)).toEqual({ issueKey: "DOC-7", draft: draftFingerprint("# Digest\n\nv1") });
    expect(draftFingerprint("# Digest\n\nv1")).not.toBe(draftFingerprint("# Digest\n\nv2"));
    // Line endings are not a different draft.
    expect(draftFingerprint("# Digest\r\n\r\nv1")).toBe(draftFingerprint("# Digest\n\nv1"));
  });

  it("rejects a button value that is not an issue key", () => {
    expect(parseApprovalButtonValue(undefined)).toBeUndefined();
    expect(parseApprovalButtonValue("../../etc|abc")).toBeUndefined();
    // Cards posted before this change carry the key alone: still parsed, no fingerprint.
    expect(parseApprovalButtonValue("DOC-3")).toEqual({ issueKey: "DOC-3", draft: undefined });
  });
});
