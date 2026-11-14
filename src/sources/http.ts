// Fetch with a timeout and one retry on network errors / 5xx (NASA and ORNL endpoints are occasionally flaky).
// Every request identifies the client: some public APIs (e.g. FRED) reject requests without a User-Agent.

export const USER_AGENT = "farm-rotation-pipeline/1.0 (NASA Space Apps 2026)";

export async function fetchText(url: string, timeoutMs = 25_000, retries = 1, accept = "*/*"): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept, "user-agent": USER_AGENT } });
    } catch (e) {
      lastError = e; // network error or timeout: retry
      continue;
    }
    if (res.ok) return res.text();
    lastError = new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    if (res.status < 500) break; // client error: retrying will not help
  }
  throw lastError;
}

export async function fetchJson<T>(url: string, timeoutMs?: number, retries?: number): Promise<T> {
  return JSON.parse(await fetchText(url, timeoutMs, retries, "application/json")) as T;
}
