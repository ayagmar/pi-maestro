import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Point the executor at the local stub model server. `MAESTRO_STUB_BASE_URL`
 * is supplied by the integration test, so the spawned `pi --mode rpc` process
 * reaches a scripted endpoint instead of a real provider.
 */
export default function stubProvider(pi: ExtensionAPI): void {
  const baseUrl = process.env.MAESTRO_STUB_BASE_URL;
  if (!baseUrl) return;

  pi.registerProvider("maestro-stub", {
    name: "Maestro Stub",
    baseUrl,
    apiKey: "stub-key",
    api: "openai-completions",
    models: [
      {
        id: "stub-model",
        name: "Stub Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
