import path from "node:path";
import { toPosix, type Vault } from "@scriptorium/core";
import { watch } from "chokidar";
import { organizeInboxFile, type OrganizeResult } from "./organizer";

/**
 * Watch vault/_inbox and organize whatever lands there.
 * ignoreInitial=false so files dropped while the process was down get filed on boot.
 */
export function watchInbox(vault: Vault, onResult: (result: OrganizeResult) => void): () => Promise<void> {
  const watcher = watch(vault.abs("_inbox"), {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on("add", (absPath: string) => {
    const relPath = toPosix(path.relative(vault.root, absPath));
    void organizeInboxFile(vault, relPath)
      .then(onResult)
      .catch((error: unknown) => {
        console.warn(`[curator] failed to organize ${relPath}:`, error instanceof Error ? error.message : error);
      });
  });

  return () => watcher.close();
}
