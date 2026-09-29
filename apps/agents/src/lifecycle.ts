/**
 * Starting and stopping the process's surfaces (the Jira poller, the Slack apps).
 *
 * One surface failing to start must not take the others down: the Curator failing its
 * Slack handshake is no reason for Scribe to stop working Jira tickets. But it must not be
 * silent either. A failed surface is recorded here, and /health reports it as degraded
 * instead of green while a configured agent is not running.
 */
export interface SurfaceStatus {
  state: "up" | "failed";
  detail?: string;
}

export class Surfaces {
  private readonly statuses = new Map<string, SurfaceStatus>();

  /** Start one surface. A throw is recorded and logged, never rethrown. */
  async start<T>(name: string, start: () => Promise<T>): Promise<T | undefined> {
    try {
      const started = await start();
      this.statuses.set(name, { state: "up" });
      return started;
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      this.statuses.set(name, { state: "failed", detail });
      console.error(`[${name}] failed to start: ${detail}`);
      return undefined;
    }
  }

  snapshot(): Record<string, SurfaceStatus> {
    return Object.fromEntries(this.statuses);
  }

  failed(): string[] {
    return [...this.statuses].filter(([, status]) => status.state === "failed").map(([name]) => name);
  }
}

export interface ShutdownOptions {
  /** Cloud Run allows 10 s between SIGTERM and SIGKILL; finish (or give up) inside it. */
  deadlineMs?: number;
  exit?: (code: number) => void;
}

/**
 * The signal handler. A second signal while stopping does not start a second shutdown; a
 * stop that hangs does not hold the process past the deadline; and a stop that failed, or
 * the deadline passing, exits non-zero, so the platform logs a failed shutdown as one.
 */
export function shutdownHandler(stops: ReadonlyArray<() => void | Promise<unknown>>, { deadlineMs = 8_000, exit = (code) => process.exit(code) }: ShutdownOptions = {}): (signal: string) => Promise<void> {
  let stopping: Promise<void> | undefined;
  return (signal) => {
    if (stopping) return stopping;
    console.log(`[scriptorium] ${signal}: closing the poller, the ingress and the sockets`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), deadlineMs);
    });
    const all = Promise.allSettled(stops.map(async (stop) => stop()));
    stopping = Promise.race([all, deadline]).then((outcome) => {
      clearTimeout(timer);
      if (outcome === "timeout") {
        console.error(`[scriptorium] shutdown did not finish within ${deadlineMs} ms; exiting anyway`);
        return exit(1);
      }
      const failures = outcome.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      for (const failure of failures) console.error(`[scriptorium] a stop failed: ${failure.reason instanceof Error ? failure.reason.message : failure.reason}`);
      exit(failures.length ? 1 : 0);
    });
    return stopping;
  };
}
