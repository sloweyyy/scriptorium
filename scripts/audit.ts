/**
 * `pnpm auditlog verify [file]` — does the audit log's hash chain hold?
 * `pnpm auditlog export --from YYYY-MM-DD --to YYYY-MM-DD [file]` — the lines in that range, as
 * JSONL on stdout, with a digest on stderr (HMAC-signed with SCRIPTORIUM_SIGNING_KEY if set),
 * so an exported extract can be checked against what was handed over.
 */
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { loadConfig, verifyAudit } from "@scriptorium/core";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};
const file = rest.find((arg, index) => !arg.startsWith("--") && !rest[index - 1]?.startsWith("--")) ?? loadConfig().auditFile;
const text = await fs.readFile(file, "utf8").catch(() => undefined);
if (text === undefined) {
  console.error(`✗ ${file}: no such audit log (set AUDIT_FILE, or pass the path).`);
  process.exit(1);
}

if (command === "verify") {
  const verdict = verifyAudit(text);
  if (verdict.ok) {
    console.log(`✓ ${file}: ${verdict.lines} lines, ${verdict.chained} chained, chain intact.`);
  } else {
    console.error(`✗ ${file}: line ${verdict.line} ${verdict.reason}.`);
    process.exitCode = 1;
  }
} else if (command === "export") {
  const from = flag("from") ?? "0000";
  const to = `${flag("to") ?? "9999"}￿`;
  const lines = text.split("\n").filter((line) => {
    const ts = (() => {
      try {
        return String((JSON.parse(line) as { ts?: unknown }).ts ?? "");
      } catch {
        return "";
      }
    })();
    return ts >= from && ts <= to;
  });
  const body = lines.map((line) => `${line}\n`).join("");
  process.stdout.write(body);
  const key = process.env.SCRIPTORIUM_SIGNING_KEY;
  const digest = key ? `hmac-sha256 ${createHmac("sha256", key).update(body).digest("hex")}` : `sha256 ${createHash("sha256").update(body).digest("hex")}`;
  console.error(`${lines.length} lines · ${digest}`);
} else {
  console.error("usage: pnpm auditlog verify [file] | pnpm auditlog export --from YYYY-MM-DD --to YYYY-MM-DD [file]");
  process.exitCode = 2;
}
