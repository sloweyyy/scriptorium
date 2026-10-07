import { describe, expect, it } from "vitest";
import { checkContract } from "@scriptorium/scribe";
import { confluencePageIdFromUrl, confluencePageIdsIn, confluenceStorageToMarkdown } from "@scriptorium/jira";

/**
 * The Confluence intake path, deterministically.
 *
 * PMs keep PRDs in Confluence; the ticket points at the page. Recognising that pointer
 * and converting the page's storage XHTML into the markdown the pipeline speaks are both
 * pure functions, and they are pinned here because "mostly right HTML scraping" is where
 * silent garbage enters a pipeline — a heading that stops being a heading, a code sample
 * that gets entity-decoded, a table flattened into word soup.
 */

describe("recognising a Confluence page URL", () => {
  it("reads the id out of both URL shapes Confluence Cloud produces", () => {
    expect(confluencePageIdFromUrl("https://x.atlassian.net/wiki/spaces/PROD/pages/98311/Beacon+PRD")).toBe("98311");
    expect(confluencePageIdFromUrl("https://x.atlassian.net/wiki/pages/viewpage.action?pageId=4204594")).toBe("4204594");
  });

  it("does not read an id out of things that are not Confluence pages", () => {
    expect(confluencePageIdFromUrl("https://x.atlassian.net/browse/DOC-7")).toBeUndefined();
    expect(confluencePageIdFromUrl("https://example.com/pages/123")).toBeUndefined();
  });

  it("finds every page URL in a description, de-duplicated", () => {
    const description = [
      "PRD: https://x.atlassian.net/wiki/spaces/PROD/pages/111/PRD and the same page again",
      "https://x.atlassian.net/wiki/spaces/PROD/pages/111/PRD plus designs at",
      "[notes|https://x.atlassian.net/wiki/pages/viewpage.action?pageId=222]",
    ].join("\n");
    expect(confluencePageIdsIn(description)).toEqual(["111", "222"]);
  });
});

describe("storage XHTML to markdown", () => {
  it("converts the structures a PRD is made of", () => {
    const storage = [
      "<h1>Incident timeline embed</h1>",
      "<p><strong>Audience:</strong> workspace admins</p>",
      "<h2>Requirements</h2>",
      "<ul><li>read-only embed</li><li>filters by <em>component</em><ul><li>nested detail</li></ul></li></ul>",
      "<ol><li>first</li><li>second</li></ol>",
      "<table><tr><th>Field</th><th>Type</th></tr><tr><td>status</td><td>enum</td></tr></table>",
    ].join("");

    const markdown = confluenceStorageToMarkdown(storage);
    expect(markdown).toContain("# Incident timeline embed");
    expect(markdown).toContain("**Audience:** workspace admins");
    expect(markdown).toContain("## Requirements");
    expect(markdown).toContain("- read-only embed");
    expect(markdown).toContain("  - nested detail");
    expect(markdown).toContain("1. first");
    expect(markdown).toContain("| Field | Type |");
    expect(markdown).toContain("| status | enum |");
  });

  it("keeps a code macro's payload verbatim — no entity decoding, no tag stripping", () => {
    const storage =
      '<p>Call it like this:</p><ac:structured-macro ac:name="code"><ac:plain-text-body>' +
      "<![CDATA[curl -H \"Accept: application/json\" 'https://api?x=1&y=<2>']]>" +
      "</ac:plain-text-body></ac:structured-macro>";
    const markdown = confluenceStorageToMarkdown(storage);
    expect(markdown).toContain("```\ncurl -H \"Accept: application/json\" 'https://api?x=1&y=<2>'\n```");
  });

  it("keeps panel content as a quote and drops chrome macros entirely", () => {
    const storage =
      '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro>' +
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Rollout is behind a flag.</p></ac:rich-text-body></ac:structured-macro>' +
      "<p>Real content.</p>";
    const markdown = confluenceStorageToMarkdown(storage);
    expect(markdown).toContain("> Rollout is behind a flag.");
    expect(markdown).not.toContain("maxLevel");
    expect(markdown).toContain("Real content.");
  });

  it("decodes entities in prose without inventing structure", () => {
    const markdown = confluenceStorageToMarkdown("<p>Admins &amp; owners get &ldquo;manage&rdquo; — version 2 shipped</p>");
    expect(markdown).toBe("Admins & owners get “manage” — version 2 shipped");
  });

  it("produces something the contract can pass, end to end", () => {
    // The whole point: a PRD written naturally in Confluence — bold labels, no YAML —
    // converts into markdown the contract accepts without the author changing anything.
    const storage = [
      "<h1>Status page subscriber management</h1>",
      "<p><strong>Feature:</strong> Subscriber management</p>",
      "<p><strong>Audience:</strong> workspace admins</p>",
      "<p><strong>User goal:</strong> manage who receives status notifications</p>",
      "<h2>Details</h2><p>Admins can add and remove subscribers.</p>",
    ].join("");

    const result = checkContract(confluenceStorageToMarkdown(storage));
    expect(result.ok).toBe(true);
    expect(result.frontmatter.feature).toBe("Subscriber management");
    expect(result.frontmatter.audience).toBe("workspace admins");
  });
});

describe("Confluence macros and the content inside them", () => {
  it("a self-closing macro deletes nothing, and a container macro's body is kept", () => {
    const storage = [
      '<ac:structured-macro ac:name="toc" ac:schema-version="1" />',
      "<h2>Requirements</h2><p>Admins must confirm before deleting.</p>",
      '<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">DRAFT</ac:parameter></ac:structured-macro>',
      "<h2>Import</h2>",
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Details</ac:parameter><ac:rich-text-body><p>Must NOT email users on import.</p></ac:rich-text-body></ac:structured-macro>',
      '<ac:structured-macro ac:name="details"><ac:rich-text-body><table><tr><th>Owner</th><td>Ana</td></tr></table></ac:rich-text-body></ac:structured-macro>',
      "<h2>Out of scope</h2><p>Mobile.</p>",
    ].join("");
    const markdown = confluenceStorageToMarkdown(storage);
    expect(markdown).toContain("## Requirements");
    expect(markdown).toContain("Admins must confirm before deleting.");
    expect(markdown).toContain("Must NOT email users on import.");
    expect(markdown).toContain("Owner");
    expect(markdown).toContain("## Out of scope");
    // Parameters are chrome, not content.
    expect(markdown).not.toContain("DRAFT");
  });
});

