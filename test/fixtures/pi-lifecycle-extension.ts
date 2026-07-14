import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function lifecycleFixture(pi: ExtensionAPI): void {
  pi.registerCommand("seed-lifecycle-message", {
    description: "Persist a lifecycle test message without starting a model turn",
    handler: async (args) => {
      const decisionId = args.trim();
      if (!decisionId) throw new Error("decision id is required");
      pi.sendMessage(
        {
          customType: "pi-lifecycle-test",
          content: "Persisted lifecycle marker",
          display: false,
          details: { decisionId },
        },
        { triggerTurn: false }
      );
    },
  });

  pi.registerCommand("reload-lifecycle", {
    description: "Reload the isolated lifecycle test runtime",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
