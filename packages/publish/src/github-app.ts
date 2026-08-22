import { createSign } from "node:crypto";
import fs from "node:fs/promises";
import { GitHubError } from "./github";

/**
 * GitHub App authentication for the docs repo.
 *
 * The agent's other GitHub credential is a deploy key — the weakest thing that can push.
 * A deploy key cannot open pull requests, and the obvious fix, a personal access token,
 * has the wrong shape: it belongs to a person, acts as that person, and lives forever
 * until someone remembers to rotate it. A GitHub App is the credential with the right
 * shape: installed on exactly one repository, holding exactly two permissions (pull
 * requests: write, contents: read), acting under its own `[bot]` identity — so a PR
 * opened by the agent is *visibly* the agent's, which is the same identity split the
 * Jira service account exists for — and authenticating with tokens that expire in an
 * hour, minted on demand from a private key that never travels in a request.
 *
 * The flow is the standard three steps: sign a short-lived JWT as the app, look up the
 * app's installation on the target repo, exchange the JWT for an installation token.
 * Tokens are cached until shortly before expiry; the private key is read once.
 */

export interface GitHubAppConfig {
  /** The numeric App ID from the app's settings page. */
  appId: string;
  /** PEM private key — the key itself, or a path to the file holding it. */
  privateKey: string;
  /** "owner/repo" the token should be scoped to. */
  repo: string;
  apiBase?: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A JWT GitHub accepts as the app itself. Ten minutes is GitHub's maximum lifetime;
 * this uses nine, and backdates `iat` a minute because GitHub rejects tokens from
 * clocks it thinks are in the future.
 */
export function appJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKeyPem).toString("base64url")}`;
}

/** The key may arrive as a PEM string or as a path to one (a Secret Manager mount is a path). */
async function resolveKey(privateKey: string): Promise<string> {
  if (privateKey.includes("-----BEGIN")) return privateKey;
  return fs.readFile(privateKey, "utf8");
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const cache = new Map<string, CachedToken>();

/** Refresh this long before actual expiry, so a token never dies mid-publish. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

function appHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * An installation token for the repo — the string that goes where a PAT would have.
 *
 * The installation is discovered from the repo rather than configured, because it is
 * derivable and every derivable setting is one the user cannot misconfigure.
 */
export async function installationToken(config: GitHubAppConfig, nowMs = Date.now()): Promise<string> {
  const cacheKey = `${config.appId}:${config.repo}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > nowMs) return cached.token;

  const api = config.apiBase ?? "https://api.github.com";
  const jwt = appJwt(config.appId, await resolveKey(config.privateKey), nowMs);

  const installEndpoint = `/repos/${config.repo}/installation`;
  const installResponse = await fetch(`${api}${installEndpoint}`, { headers: appHeaders(jwt) });
  if (!installResponse.ok) {
    throw new GitHubError(
      installResponse.status,
      installEndpoint,
      installResponse.status === 404
        ? "the app is not installed on this repository — install it from the app's settings page"
        : (await installResponse.text()).slice(0, 300),
    );
  }
  const installation = (await installResponse.json()) as { id: number };

  const tokenEndpoint = `/app/installations/${installation.id}/access_tokens`;
  const tokenResponse = await fetch(`${api}${tokenEndpoint}`, { method: "POST", headers: appHeaders(jwt) });
  if (!tokenResponse.ok) {
    throw new GitHubError(tokenResponse.status, tokenEndpoint, (await tokenResponse.text()).slice(0, 300));
  }
  const data = (await tokenResponse.json()) as { token: string; expires_at: string };

  cache.set(cacheKey, { token: data.token, expiresAtMs: Date.parse(data.expires_at) });
  return data.token;
}

/** Test hook: a cached token must not leak between tests that stub different servers. */
export function clearInstallationTokenCache(): void {
  cache.clear();
}
