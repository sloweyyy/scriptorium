/**
 * `fetch`, patient with rate limits. Atlassian and GitHub answer a burst with 429 (and
 * sometimes 503) plus a `Retry-After`; without this, one busy minute turned into failed
 * turns and "couldn't carry it out" on approved actions.
 *
 * - Retries only 429 and 503 — responses that mean the request was NOT processed, so a
 *   retry can't double a write (and every write is op-keyed besides).
 * - Waits what the server asks (seconds or an HTTP date), else 1s, 2s, 4s; never more than
 *   `maxWaitMs` in total. Past that, the last response is returned and the caller fails
 *   closed as it would have.
 */
export interface BackoffOptions {
  tries?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Told of each wait — the audit log's `connector.throttled`. */
  onThrottle?: (info: { url: string; status: number; waitMs: number; attempt: number }) => void;
}

const RETRYABLE = new Set([429, 503]);

export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export async function fetchWithBackoff(url: string, init: RequestInit = {}, options: BackoffOptions = {}): Promise<Response> {
  const tries = options.tries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let budget = options.maxWaitMs ?? 30_000;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, init);
    if (!RETRYABLE.has(response.status) || attempt >= tries) return response;
    const waitMs = Math.min(retryAfterMs(response.headers.get("retry-after")) ?? 1000 * 2 ** (attempt - 1), budget);
    if (waitMs <= 0 && budget <= 0) return response;
    options.onThrottle?.({ url: url.split("?")[0] as string, status: response.status, waitMs, attempt });
    await response.body?.cancel().catch(() => undefined);
    budget -= waitMs;
    await sleep(waitMs);
  }
}
