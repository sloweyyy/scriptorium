import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_KNOWN_HOSTS, sshCommandFor } from "@scriptorium/agents";

const exec = promisify(execFile);

/**
 * The deploy key's ssh. GitHub's host key is pinned and checked strictly, never trusted on
 * first sight by a container that is always new; the key's private copy is never readable
 * by anyone else, not even for a moment.
 */
let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-key-"));
});
afterEach(async () => {
  await fs.chmod(path.join(dir, "mounted"), 0o600).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

async function mountedKey(): Promise<string> {
  const key = path.join(dir, "mounted");
  await fs.writeFile(key, "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n-----END OPENSSH PRIVATE KEY-----\n");
  await fs.chmod(key, 0o444); // how Cloud Run mounts a secret
  return key;
}

describe("deploy key ssh", () => {
  it("checks a GitHub remote strictly against the pinned host keys", async () => {
    const key = await mountedKey();
    for (const url of ["git@github.com:acme/docs.git", "ssh://git@github.com/acme/docs.git"]) {
      const command = await sshCommandFor(url, key);
      expect(command).toContain("StrictHostKeyChecking=yes");
      expect(command).toContain(`UserKnownHostsFile='${GITHUB_KNOWN_HOSTS}'`);
      expect(command).not.toContain("accept-new");
    }
    // The pinned file holds GitHub's keys, and ssh can find github.com in it.
    const { stdout } = await exec("ssh-keygen", ["-F", "github.com", "-f", GITHUB_KNOWN_HOSTS]);
    expect(stdout).toContain("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
  });

  it("ssh accepts the options as written", async () => {
    const command = await sshCommandFor("git@github.com:acme/docs.git", await mountedKey());
    const { stdout } = await exec("sh", ["-c", `${command.replace(/^ssh /, "ssh -G ")} github.com`]);
    expect(stdout).toMatch(/^stricthostkeychecking true$/m);
  });

  it("copies a world-readable mounted key to a file only its owner can read", async () => {
    const command = await sshCommandFor("git@github.com:acme/docs.git", await mountedKey());
    const copy = command.match(/-i '([^']+)'/)?.[1] ?? "";
    expect((await fs.stat(copy)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(copy))).mode & 0o077).toBe(0);
  });
});
