import { describe, expect, it } from "vitest";
import { lintDoc, lintOk } from "@scriptorium/scribe";

const CLEAN_DOC = `# Scheduled maintenance announcements

## Overview
Admins can announce planned maintenance ahead of time.

## Prerequisites
None.

## Steps
1. Open Announcements.
2. Click New maintenance.

## FAQ
**Will subscribers be notified?** Yes, by email.
`;

describe("deterministic lint", () => {
  it("passes a clean doc", () => {
    const findings = lintDoc(CLEAN_DOC);
    expect(lintOk(findings)).toBe(true);
    expect(findings).toHaveLength(0);
  });

  it("flags placeholder text", () => {
    const findings = lintDoc(CLEAN_DOC + "\nTODO: verify this section.");
    expect(findings.some((finding) => finding.code === "placeholder")).toBe(true);
    expect(lintOk(findings)).toBe(false);
  });

  it("flags missing required sections", () => {
    const findings = lintDoc("# Title\n\n## Overview\nText only.");
    expect(findings.some((finding) => finding.code === "missing-section")).toBe(true);
  });

  it("enforces the house glossary", () => {
    const findings = lintDoc(CLEAN_DOC.replace("by email", "via the whitelist"));
    const glossary = findings.find((finding) => finding.code === "glossary");
    expect(glossary?.message).toContain("allowlist");
  });
});
