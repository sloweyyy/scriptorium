/**
 * `pnpm auditlog verify [--anchor <hash>] [file]` — does the audit log's hash chain hold? With
 *   `--anchor`, the file is an extract whose first line follows that hash.
 * `pnpm auditlog export --from YYYY-MM-DD --to YYYY-MM-DD [file]` — the lines in that range, as
 *   JSONL on stdout; on stderr, the anchor the extract starts from and a digest, HMAC-signed
 *   when SCRIPTORIUM_SIGNING_KEY is set. Refused when the log itself doesn't verify.
 * `pnpm auditlog export-key` — the key that checks an export's HMAC, to hand to whoever
 *   checks it. Derived from the signing key, so it can't sign an approval.
 */
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { auditExportKey, auditLineHash, loadConfig, verifyAudit } from "@scriptorium/core";

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
  const anchor = flag("anchor");
  const verdict = verifyAudit(text, anchor ? { anchor } : {});
  if (verdict.ok) {
    console.log(`✓ ${file}: ${verdict.lines} lines, ${verdict.chained} chained${verdict.redacted ? `, ${verdict.redacted} erased (privacy:erase)` : ""}, chain intact.`);
  } else {
    console.error(`✗ ${file}: line ${verdict.line} ${verdict.reason}.`);
    process.exitCode = 1;
  }
} else if (command === "export") {
  // An extract of a log that doesn't verify proves nothing, however well it is signed.
  const verdict = verifyAudit(text);
  if (!verdict.ok) {
    console.error(`✗ ${file}: line ${verdict.line} ${verdict.reason}. Not exporting: an extract of a broken log proves nothing.`);
    process.exit(1);
  }
  const from = flag("from") ?? "0000";
  const to = `${flag("to") ?? "9999"}￿`;
  const all = text.split("\n").filter((line) => line.trim());
  const lines = all.filter((line) => {
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
  // The hash the extract's first line chains onto, so `verify --anchor` can check it alone.
  const firstIndex = lines.length ? all.indexOf(lines[0] as string) : -1;
  const anchor = firstIndex > 0 ? auditLineHash(all[firstIndex - 1] as string) : "genesis";
  const key = auditExportKey(process.env.SCRIPTORIUM_SIGNING_KEY);
  const digest = key ? `hmac-sha256 ${createHmac("sha256", key).update(`${anchor}\n${body}`).digest("hex")}` : `sha256 ${createHash("sha256").update(`${anchor}\n${body}`).digest("hex")}`;
  console.error(`${lines.length} lines · anchor ${anchor} · ${digest} (over the anchor line and the extract)`);
} else if (command === "export-key") {
  const key = auditExportKey(process.env.SCRIPTORIUM_SIGNING_KEY);
  if (!key) {
    console.error("SCRIPTORIUM_SIGNING_KEY is not set, so exports carry a plain sha256 and need no key.");
    process.exitCode = 1;
  } else {
    console.log(key);
  }
} else {
  console.error("usage: pnpm auditlog verify [--anchor <hash>] [file] | pnpm auditlog export --from YYYY-MM-DD --to YYYY-MM-DD [file] | pnpm auditlog export-key");
  process.exitCode = 2;
}
