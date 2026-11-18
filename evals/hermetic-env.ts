import fs from "node:fs";

/**
 * What the evals may take from an operator's `.env`: the settings that choose and reach a
 * model, so `RUN_LLM_EVALS=1 pnpm eval` still runs on whichever provider is configured.
 * Nothing else: a signing key, approvers or channels from a real deployment changed what
 * the guardrail evals saw, and nine of them failed on a correctly configured machine.
 */
const PROVIDER_SETTING = /^(LLM_PROVIDER|MODEL|MODEL_FALLBACK|ANTHROPIC_[A-Z0-9_]+|VERTEX_[A-Z0-9_]+|GEMINI_[A-Z0-9_]+|GOOGLE_APPLICATION_CREDENTIALS|RETRIEVAL_EMBEDDINGS)$/;

/** `.env` text → its model provider settings, minus any the environment already sets (dotenv's precedence). */
export function providerSettings(dotenv: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const line of dotenv.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    const raw = match[2]!;
    if (!PROVIDER_SETTING.test(name) || environment[name] !== undefined) continue;
    const quoted = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(raw);
    const value = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, "").trim();
    if (value) settings[name] = value;
  }
  return settings;
}

/** The environment every eval runs in: the provider settings from `.env`, and `.env` itself off. */
export function evalEnvironment(file = ".env"): Record<string, string> {
  const dotenv = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  return { ...providerSettings(dotenv), SCRIPTORIUM_DOTENV: "off" };
}
