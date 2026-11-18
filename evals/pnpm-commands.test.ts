import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * pnpm runs its own command when one has a script's name. `pnpm doctor` ran pnpm's doctor,
 * printed nothing and exited 0, while the docs told every operator it was the setup check.
 * A script whose name pnpm keeps for itself has to be documented as `pnpm run <name>`.
 *
 * pnpm's commands, from `pnpm help --all` on the version `packageManager` pins.
 */
const PNPM = "pnpm@10.32.1";
const PNPM_COMMANDS = new Set([
  "add", "approve-builds", "audit", "bin", "c", "cat-file", "cat-index", "config", "create", "dedupe", "deploy",
  "dlx", "doctor", "env", "exec", "fetch", "find-hash", "i", "ignored-builds", "import", "init", "install",
  "install-test", "it", "licenses", "link", "list", "ln", "ls", "outdated", "pack", "patch", "patch-commit",
  "patch-remove", "prune", "publish", "rb", "rebuild", "remove", "rm", "root", "run", "self-update", "start",
  "store", "t", "test", "unlink", "up", "update", "why",
]);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { packageManager?: string; scripts: Record<string, string> };
const docs = ["CLAUDE.md", "README.md", "CONTRIBUTING.md", "SECURITY.md", "site/index.html", ...fs.readdirSync("docs").filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];

describe("documented pnpm commands", () => {
  it(`names the commands of the pnpm the repo pins (${PNPM})`, () => {
    // A new pnpm can add commands: on a bump, refresh PNPM_COMMANDS from `pnpm help --all`.
    expect(pkg.packageManager).toBe(PNPM);
  });

  it("never tell anyone to run a script by a name pnpm keeps for itself", () => {
    const shadowed: string[] = [];
    for (const file of docs) {
      for (const [, name] of fs.readFileSync(file, "utf8").matchAll(/\bpnpm ([a-z][a-z0-9:-]*)/g)) {
        if (name && name in pkg.scripts && PNPM_COMMANDS.has(name)) shadowed.push(`${file}: \`pnpm ${name}\` runs pnpm's own command — write \`pnpm run ${name}\``);
      }
    }
    expect(shadowed).toEqual([]);
  });
});
