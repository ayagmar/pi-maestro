import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userDataDirectory } from "./config.js";

/**
 * When a provider's exhausted usage window will reopen.
 *
 * Blind probing is the right fallback when nothing else is known, but a
 * provider that publishes its own reset clock should be asked once and then
 * waited for exactly. Codex subscriptions expose that clock; one real drive
 * spent an evening firing two-minute probes at a window that the status bar
 * two lines below already showed would reopen in three hours.
 */
export interface QuotaWindow {
  /** Human label such as "5h" or "Week". */
  label: string;
  usedPercent: number;
  /** Epoch milliseconds at which the window resets. */
  resetAt: number;
}

export interface QuotaStatus {
  provider: string;
  /** Windows sorted by reset time; the exhausted ones drive the wait. */
  windows: QuotaWindow[];
}

export type QuotaStatusResolver = (provider: string) => Promise<QuotaStatus | undefined>;

export interface QuotaResolverDependencies {
  fetch: typeof fetch;
  readAuthFile: () => string | undefined;
  now: () => number;
  timeoutMs: number;
}

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

function windowLabel(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "window";
  const hours = Math.round(seconds / 3600);
  if (hours >= 144) return "Week";
  if (hours >= 24) return "Day";
  return `${hours}h`;
}

function codexWindow(
  raw: CodexWindow | undefined,
  fallbackSeconds: number
): QuotaWindow | undefined {
  if (!raw || typeof raw.reset_at !== "number") return undefined;
  return {
    label: windowLabel(raw.limit_window_seconds ?? fallbackSeconds),
    usedPercent: typeof raw.used_percent === "number" ? raw.used_percent : 0,
    resetAt: raw.reset_at * 1000,
  };
}

function defaultReadAuthFile(): string | undefined {
  const file = join(userDataDirectory(), "auth.json");
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf-8");
}

/**
 * Codex publishes `used_percent` and `reset_at` per rate window on its usage
 * endpoint, authenticated with the same OAuth token pi stores in auth.json.
 * Any failure (no credentials, expired token, network) yields `undefined`
 * so the caller falls back to probing rather than guessing.
 */
export async function codexQuotaStatus(
  deps: QuotaResolverDependencies
): Promise<QuotaStatus | undefined> {
  let credentials: { access?: string; accountId?: string } | undefined;
  try {
    const raw = deps.readAuthFile();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entry = parsed["openai-codex"];
    if (entry && typeof entry === "object") credentials = entry as typeof credentials;
  } catch {
    return undefined;
  }
  if (!credentials?.access) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.access}`,
      Accept: "application/json",
    };
    if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
    const response = await deps.fetch(CODEX_USAGE_URL, { headers, signal: controller.signal });
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      rate_limit?: { primary_window?: CodexWindow; secondary_window?: CodexWindow };
    };
    const windows = [
      codexWindow(data.rate_limit?.primary_window, 18_000),
      codexWindow(data.rate_limit?.secondary_window, 604_800),
    ]
      .filter((window): window is QuotaWindow => window !== undefined)
      .sort((a, b) => a.resetAt - b.resetAt);
    if (windows.length === 0) return undefined;
    return { provider: "openai-codex", windows };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function createQuotaStatusResolver(
  overrides: Partial<QuotaResolverDependencies> = {}
): QuotaStatusResolver {
  const deps: QuotaResolverDependencies = {
    fetch: overrides.fetch ?? fetch,
    readAuthFile: overrides.readAuthFile ?? defaultReadAuthFile,
    now: overrides.now ?? Date.now,
    timeoutMs: overrides.timeoutMs ?? 10_000,
  };
  return async (provider) => {
    if (provider === "openai-codex") return codexQuotaStatus(deps);
    return undefined;
  };
}

/**
 * The moment the provider is expected to accept requests again: the latest
 * reset among windows that are exhausted. A window at 100% of its weekly
 * budget keeps blocking after the 5-hour window reopens, so the later reset
 * wins. Returns `undefined` when no window is exhausted (the failure was
 * something else, or the window already reset).
 */
export function quotaReopensAt(status: QuotaStatus, now: number): QuotaWindow | undefined {
  const exhausted = status.windows.filter(
    (window) => window.usedPercent >= 100 && window.resetAt > now
  );
  if (exhausted.length === 0) return undefined;
  return exhausted.reduce((latest, window) => (window.resetAt > latest.resetAt ? window : latest));
}

export function formatResetClock(resetAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((resetAt - now) / 60_000));
  const date = new Date(resetAt);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (minutes >= 90) {
    const hours = Math.floor(minutes / 60);
    return `${clock} (in ${hours}h ${String(minutes % 60).padStart(2, "0")}m)`;
  }
  return `${clock} (in ${minutes} min)`;
}
