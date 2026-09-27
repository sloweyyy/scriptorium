import { createVerify, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appJwt, clearInstallationTokenCache, installationToken } from "@scriptorium/publish";

/**
 * The GitHub App credential path — the thing that lets the agent open pull requests
 * under its own [bot] identity with an hour-lived token, instead of borrowing a human's
 * PAT forever.
 *
 * The JWT is verified with real crypto against the matching public key, because a JWT
 * eval that only checks string shape would pass with a broken signature — and a broken
 * signature fails in production as an opaque 401 from GitHub.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString());
}

describe("the app JWT", () => {
  it("is RS256-signed by the private key and scoped in time", () => {
    const now = 1_700_000_000_000;
    const jwt = appJwt("4242", privatePem, now);
    const [header = "", payload = "", signature = ""] = jwt.split(".");

    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims.iss).toBe("4242");
    // Backdated a minute (GitHub rejects future clocks), dead in under ten (its maximum).
    expect(claims.iat).toBe(1_700_000_000 - 60);
    expect(claims.exp).toBe(1_700_000_000 + 540);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);

    // A tampered payload must not verify — this is what "signed" means.
    const forged = base64urlOf({ ...claims, iss: "9999" });
    const check = createVerify("RSA-SHA256");
    check.update(`${header}.${forged}`);
    expect(check.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(false);
  });
});

function base64urlOf(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("installation tokens", () => {
  let calls: string[];

  beforeEach(() => {
    clearInstallationTokenCache();
    calls = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.includes("/repos/o/r/installation")) {
        return new Response(JSON.stringify({ id: 77 }), { status: 200 });
      }
      if (url.includes("/app/installations/77/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 201 },
        );
      }
      return new Response("{}", { status: 404 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers the installation from the repo and mints a token", async () => {
    const token = await installationToken({ appId: "4242", privateKey: privatePem, repo: "o/r" });
    expect(token).toBe("ghs_installation");
    // Installation id is derived, not configured: a derivable setting cannot be misconfigured.
    expect(calls).toEqual(["GET /repos/o/r/installation", "POST /app/installations/77/access_tokens"]);
  });

  it("caches the token instead of minting one per publish", async () => {
    await installationToken({ appId: "4242", privateKey: privatePem, repo: "o/r" });
    await installationToken({ appId: "4242", privateKey: privatePem, repo: "o/r" });
    expect(calls).toHaveLength(2); // still just the first mint
  });

  it("re-mints once the cached token nears expiry", async () => {
    const start = Date.now();
    await installationToken({ appId: "4242", privateKey: privatePem, repo: "o/r" }, start);
    // 56 minutes later: inside the 5-minute refresh margin of a 60-minute token.
    await installationToken({ appId: "4242", privateKey: privatePem, repo: "o/r" }, start + 56 * 60_000);
    expect(calls).toHaveLength(4);
  });

  it("reads the private key from a file path — a Secret Manager mount is a path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-app-"));
    const keyPath = path.join(dir, "app-key.pem");
    await fs.writeFile(keyPath, privatePem);
    try {
      const token = await installationToken({ appId: "4242", privateKey: keyPath, repo: "o/r" });
      expect(token).toBe("ghs_installation");
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("says the actual problem when the app is not installed on the repo", async () => {
    await expect(installationToken({ appId: "4242", privateKey: privatePem, repo: "o/elsewhere" })).rejects.toThrow(
      /not installed on this repository/,
    );
  });
});
