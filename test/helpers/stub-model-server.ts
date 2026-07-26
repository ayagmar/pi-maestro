import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

/**
 * A local OpenAI-completions endpoint that replays scripted assistant turns.
 *
 * Real executors are `pi --mode rpc` subprocesses, and the only reason they
 * need a network is the model call. Pointing them at this server exercises the
 * genuine RPC transport, session writing, tool execution, and process teardown
 * with no provider account, no tokens, and no outbound traffic.
 */

export interface ScriptedTurn {
  /** Assistant text for this turn. The last turn should carry the final report. */
  text?: string;
  /** Optional shell command the executor should run before answering. */
  bash?: string;
}

export interface StubModelServer {
  baseUrl: string;
  /** Prompts received, in order, for asserting what the executor was actually told. */
  requests: string[];
  close(): Promise<void>;
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Serve one scripted turn per request. `script` is consumed in order; once it
 * is exhausted every further request repeats the final turn, so a run that
 * takes an unexpected extra turn still terminates instead of hanging.
 */
export async function startStubModelServer(script: ScriptedTurn[]): Promise<StubModelServer> {
  const requests: string[] = [];
  let index = 0;

  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push(body);
      if (request.url?.includes("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
        return;
      }

      const turn: ScriptedTurn = script[Math.min(index, script.length - 1)] ?? { text: "done" };
      index += 1;
      const id = `chatcmpl-${index}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      const toolCall = turn.bash
        ? [
            {
              index: 0,
              id: `call_${index}`,
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: turn.bash }) },
            },
          ]
        : undefined;

      response.write(
        sseChunk({
          id,
          object: "chat.completion.chunk",
          model: "stub-model",
          choices: [
            {
              index: 0,
              delta: toolCall
                ? { role: "assistant", tool_calls: toolCall }
                : { role: "assistant", content: turn.text },
              finish_reason: null,
            },
          ],
        })
      );
      response.write(
        sseChunk({
          id,
          object: "chat.completion.chunk",
          model: "stub-model",
          choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
      response.end("data: [DONE]\n\n");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
