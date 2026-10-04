import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  codexQuotaStatus,
  createQuotaStatusResolver,
  formatResetClock,
  quotaReopensAt,
  type QuotaResolverDependencies,
} from "../src/provider-quota.js";

const NOW = Date.UTC(2026, 8, 6, 16, 30, 0);

function deps(overrides: Partial<QuotaResolverDependencies> = {}): QuotaResolverDependencies {
  return {
    fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    readCredential: (providerId) =>
      providerId === "openai-codex"
        ? {
            type: "oauth",
            access: "token-123",
            refresh: "refresh-123",
            expires: NOW + 3_600_000,
            accountId: "acct-1",
          }
        : undefined,
    now: () => NOW,
    timeoutMs: 1_000,
    ...overrides,
  };
}

const usagePayload = {
  rate_limit: {
    primary_window: {
      used_percent: 100,
      limit_window_seconds: 18_000,
      reset_after_seconds: 11_376,
      reset_at: Math.floor(NOW / 1000) + 11_376,
    },
    secondary_window: {
      used_percent: 54,
      limit_window_seconds: 604_800,
      reset_at: Math.floor(NOW / 1000) + 390_093,
    },
  },
};

test("codex usage is fetched with pi's stored OAuth credentials and parsed into windows", async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const status = await codexQuotaStatus(
    deps({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          headers: init?.headers as Record<string, string>,
        });
        return new Response(JSON.stringify(usagePayload), { status: 200 });
      }) as typeof fetch,
    })
  );
  assert.equal(requests[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(requests[0]?.headers.Authorization, "Bearer token-123");
  assert.equal(requests[0]?.headers["ChatGPT-Account-Id"], "acct-1");
  assert.deepEqual(status, {
    provider: "openai-codex",
    windows: [
      { label: "5h", usedPercent: 100, resetAt: (Math.floor(NOW / 1000) + 11_376) * 1000 },
      { label: "Week", usedPercent: 54, resetAt: (Math.floor(NOW / 1000) + 390_093) * 1000 },
    ],
  });
});

test("missing credentials, HTTP errors, and network failures all fall back to undefined", async () => {
  assert.equal(await codexQuotaStatus(deps({ readCredential: () => undefined })), undefined);
  assert.equal(
    await codexQuotaStatus(deps({ readCredential: () => ({ type: "api_key", key: "sk-test" }) })),
    undefined,
    "an API-key credential has no OAuth token for the usage endpoint"
  );
  assert.equal(
    await codexQuotaStatus(
      deps({
        readCredential: () => {
          throw new Error("unreadable auth.json");
        },
      })
    ),
    undefined
  );
  assert.equal(
    await codexQuotaStatus(
      deps({ fetch: (async () => new Response("", { status: 401 })) as typeof fetch })
    ),
    undefined,
    "an expired token must not be mistaken for a reset clock"
  );
  assert.equal(
    await codexQuotaStatus(
      deps({
        fetch: (async () => {
          throw new Error("fetch failed");
        }) as typeof fetch,
      })
    ),
    undefined
  );
});

test("the resolver only knows Codex; other providers fall back to probing", async () => {
  const resolver = createQuotaStatusResolver(
    deps({
      fetch: (async () =>
        new Response(JSON.stringify(usagePayload), { status: 200 })) as typeof fetch,
    })
  );
  assert.equal(await resolver("anthropic"), undefined);
  assert.equal((await resolver("openai-codex"))?.windows.length, 2);
});

test("by default the resolver reads the token pi stored in its own auth.json", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "maestro-quota-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Editors on Windows save a byte-order mark; pi's own reader tolerates it.
  writeFileSync(
    join(agentDir, "auth.json"),
    `\uFEFF${JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "stored-token",
        refresh: "refresh",
        expires: NOW + 3_600_000,
        accountId: "stored-account",
      },
    })}`
  );
  const seen: Array<Record<string, string>> = [];
  try {
    const resolver = createQuotaStatusResolver({
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return new Response(JSON.stringify(usagePayload), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal((await resolver("openai-codex"))?.windows.length, 2);
    assert.equal(seen[0]?.Authorization, "Bearer stored-token");
    assert.equal(seen[0]?.["ChatGPT-Account-Id"], "stored-account");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the reopening moment is the latest reset among exhausted windows", () => {
  const fiveHour = { label: "5h", usedPercent: 100, resetAt: NOW + 3 * 3_600_000 };
  const week = { label: "Week", usedPercent: 54, resetAt: NOW + 4 * 86_400_000 };
  assert.deepEqual(
    quotaReopensAt({ provider: "openai-codex", windows: [fiveHour, week] }, NOW),
    fiveHour
  );
  // Both exhausted: the 5h window reopening changes nothing while the week is spent.
  assert.deepEqual(
    quotaReopensAt(
      { provider: "openai-codex", windows: [fiveHour, { ...week, usedPercent: 100 }] },
      NOW
    ),
    { ...week, usedPercent: 100 }
  );
  // Nothing exhausted, or already reset: the failure was something else.
  assert.equal(
    quotaReopensAt({ provider: "openai-codex", windows: [{ ...fiveHour, usedPercent: 97 }] }, NOW),
    undefined
  );
  assert.equal(
    quotaReopensAt({ provider: "openai-codex", windows: [{ ...fiveHour, resetAt: NOW - 1 }] }, NOW),
    undefined
  );
});

test("reset clocks read as a wall-clock time with a relative distance", () => {
  assert.match(formatResetClock(NOW + 25 * 60_000, NOW), /\(in 25 min\)$/);
  assert.match(formatResetClock(NOW + (3 * 60 + 10) * 60_000, NOW), /\(in 3h 10m\)$/);
  assert.match(formatResetClock(NOW - 60_000, NOW), /\(in 0 min\)$/);
});
