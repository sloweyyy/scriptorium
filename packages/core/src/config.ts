import path from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export interface SlackAppTokens {
  botToken?: string;
  appToken?: string;
}

export interface AppConfig {
  model: string;
  hasAnthropicKey: boolean;
  repoRoot: string;
  vaultDir: string;
  auditFile: string;
  scribe: SlackAppTokens;
  curator: SlackAppTokens;
}

export function loadConfig(repoRoot = process.cwd()): AppConfig {
  return {
    model: env("MODEL") ?? "claude-opus-5",
    hasAnthropicKey: Boolean(env("ANTHROPIC_API_KEY")),
    repoRoot,
    vaultDir: path.resolve(repoRoot, env("VAULT_DIR") ?? "vault"),
    auditFile: path.resolve(repoRoot, env("AUDIT_FILE") ?? "audit/log.jsonl"),
    scribe: {
      botToken: env("SCRIBE_SLACK_BOT_TOKEN"),
      appToken: env("SCRIBE_SLACK_APP_TOKEN"),
    },
    curator: {
      botToken: env("CURATOR_SLACK_BOT_TOKEN"),
      appToken: env("CURATOR_SLACK_APP_TOKEN"),
    },
  };
}
