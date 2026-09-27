import { jiraReady, type AppConfig, type ToolSpec } from "@scriptorium/core";
import { ConfluenceConnector, githubTools, jiraTools, slackTools, type SlackClient } from "@scriptorium/connectors";
import { jiraClient } from "@scriptorium/jira";
import { installationToken } from "@scriptorium/publish";
import type { EffectLedger } from "@scriptorium/runtime";

/** The connectors the Teammate may use on this host, and the identity it writes as. */

/** Tools that write to Jira or Confluence — offered only under the Teammate's own identity. */
const ATLASSIAN_WRITES = new Set(["jira_comment", "jira_create_issue", "confluence_create_page", "confluence_update_page"]);

/** Everything the Teammate can reach on this host, each limited to its allow-list. */
export function teammateConnectorTools(config: AppConfig, slack: SlackClient, ledger: EffectLedger): ToolSpec[] {
  const settings = config.teammate;
  const tools: ToolSpec[] = [...slackTools({ client: slack, allowedChannels: settings.channels, ledger })];
  if (jiraReady(config.jira)) {
    const projects = settings.jiraProjects.length ? settings.jiraProjects : [config.jira.projectKey as string];
    // Its own service account, or read-only. Borrowing Scribe's token to WRITE would make
    // two agents one identity: a Teammate comment would read as Scribe's on every ticket.
    const ownIdentity = Boolean(settings.atlassianEmail && settings.atlassianToken) && !sharesScribeAccount(config);
    const email = ownIdentity ? (settings.atlassianEmail as string) : (config.jira.email as string);
    const apiToken = ownIdentity ? (settings.atlassianToken as string) : (config.jira.apiToken as string);
    const atlassian = [
      ...jiraTools({ client: jiraClient({ ...config.jira, email, apiToken }), allowedProjects: projects, createProject: projects[0], issueType: config.jira.issueType, ledger }),
      ...new ConfluenceConnector({ baseUrl: config.jira.baseUrl as string, email, apiToken, allowedSpaceKeys: settings.confluenceSpaces, ledger }).tools(),
    ];
    if (!ownIdentity) console.warn("[teammate] no TEAMMATE_ATLASSIAN_EMAIL/TOKEN — Jira and Confluence are read-only for the Teammate");
    tools.push(...(ownIdentity ? atlassian : atlassian.filter((tool) => !ATLASSIAN_WRITES.has(tool.name))));
  }
  // GitHub only under the Teammate's own App — never the docs repo's — and only for listed repos.
  if (settings.githubAppId && settings.githubAppKey && settings.githubRepos?.length) {
    const appId = settings.githubAppId;
    const privateKey = settings.githubAppKey;
    tools.push(...githubTools({ token: (repo) => installationToken({ appId, privateKey, repo }), allowedRepos: settings.githubRepos, ledger }));
  }
  return tools;
}

/**
 * The Teammate and Scribe on one Atlassian account are one identity: each would read the
 * other's comments as its own, and every ticket Scribe assigns to itself would look
 * assigned to the Teammate. That is refused, not warned about.
 */
export function sharesScribeAccount(config: AppConfig): boolean {
  const mine = config.teammate.atlassianEmail?.trim().toLowerCase();
  return Boolean(mine) && mine === config.jira.email?.trim().toLowerCase();
}
