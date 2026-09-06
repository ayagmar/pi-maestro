import assert from "node:assert/strict";
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
    readAuthFile: () =>
      JSON.stringify({ "openai-codex": { access: "token-123", accountId: "acct-1" } }),
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
  assert.equal(await codexQuotaStatus(deps({ readAuthFile: () => undefined })), undefined);
  assert.equal(await codexQuotaStatus(deps({ readAuthFile: () => "{not json" })), undefined);
  assert.equal(
    await codexQuotaStatus(deps({ readAuthFile: () => JSON.stringify({ anthropic: {} }) })),
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
