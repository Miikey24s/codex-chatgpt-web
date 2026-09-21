import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "../src/adapters/chatgpt-web/native-compaction-control";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { defaultBrokerEndpoint } from "../src/config";

function testEnvironment(root: string): ChatGptTurnEnvironment {
  const ownNamespace = "mcp__codex_safe";
  return {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [
      { name: "codex_exec", namespace: ownNamespace, description: "Recursive bridge", parameters: { type: "object" } },
      { name: "shadow_tool", namespace: ownNamespace, description: "Hidden quota and reset helper", parameters: { type: "object" } },
      { name: CODEX_COMPACTION_CONTROL_WIRE_NAME, description: "Internal compaction control", parameters: { type: "object" } },
      {
        name: "useful_tool",
        namespace: "mcp__useful",
        description: "Read current Codex usage limits, remaining allowance, and reset times.",
        parameters: {
          type: "object",
          properties: { detail: { type: "boolean" } },
          additionalProperties: false,
        },
      },
      {
        name: "set_thread_title",
        namespace: "mcp__useful",
        description: "Rename the current task.",
        parameters: { type: "object", properties: { title: { type: "string" } } },
      },
    ],
  };
}

test("active TypeSafe inventory fallback preserves visibility, pagination, and lexical fast paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-typesafe-mcp-"));
  const socketPath = defaultBrokerEndpoint(join(root, "broker"));
  const broker = TurnBroker.forSocket(socketPath);
  const requestId = await broker.registerSafe(
    testEnvironment(root),
    "typesafe_surface_nonce_0123456789",
    60_000,
    "typesafe-inventory",
  );
  const observedCriteria: string[][] = [];
  let semanticCalls = 0;
  const typeSafeServer = Bun.serve({
    port: 0,
    async fetch(request) {
      semanticCalls += 1;
      expect(request.headers.get("authorization")).toBe("Bearer integration-test-key");
      const body = await request.json() as {
        state?: { query?: string };
        questions?: { decision?: { criteria?: Record<string, unknown> } };
      };
      const criteria = body.questions?.decision?.criteria ?? {};
      const choices = Object.keys(criteria);
      observedCriteria.push(choices);
      expect(choices).not.toContain("mcp__codex_safe__shadow_tool");
      expect(choices).not.toContain(CODEX_COMPACTION_CONTROL_WIRE_NAME);
      expect(choices).toContain("mcp__useful__useful_tool");
      expect(choices).toContain("__NO_MATCH__");

      if (body.state?.query === "typesafe unavailable") {
        return new Response("unavailable", { status: 503 });
      }
      const choice = body.state?.query === "explain monads"
        ? "__NO_MATCH__"
        : "mcp__useful__useful_tool";
      return Response.json({
        model: "jev-integration-test",
        answers: {
          decision: {
            type: "choice",
            choice,
            probabilities: Object.fromEntries(choices.map(candidate => [candidate, candidate === choice ? 0.99 : 0.01])),
            confidence: 0.99,
          },
        },
        usage: { input_tokens: 12, output_tokens: 3 },
      });
    },
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", "safe", "--broker-socket", socketPath],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      TYPESAFE_API_KEY: "integration-test-key",
      TYPESAFE_ENDPOINT: `http://127.0.0.1:${typeSafeServer.port}/v1/systemone`,
      TYPESAFE_TOOL_DISCOVERY: "active",
      TYPESAFE_TOOL_CONFIDENCE: "0.9",
      TYPESAFE_TIMEOUT_MS: "1000",
    },
  });
  const client = new Client({ name: "typesafe-inventory-integration", version: "1.0.0" });

  try {
    await client.connect(transport);
    expect(broker.confirmSafeTurnSent(requestId, "typesafe_surface_nonce_0123456789"))
      .toEqual({ confirmed: true, duplicate: false });
    const started = await client.callTool({
      name: "codex_turn_start",
      arguments: { request_id: requestId },
    });
    expect(started.structuredContent).toEqual({ started: true, duplicate: false });

    const lexical = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { request_id: requestId, query: "useful_tool", include_schema: false },
    });
    expect(lexical.structuredContent).toMatchObject({
      total: 1,
      tools: [{ wire_name: "mcp__useful__useful_tool" }],
    });
    expect(semanticCalls).toBe(0);

    const semantic = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { request_id: requestId, query: "quota left", include_schema: true },
    });
    expect(semantic.structuredContent).toMatchObject({
      total: 1,
      next_offset: null,
      tools: [{
        wire_name: "mcp__useful__useful_tool",
        kind: "function",
        parameters: { type: "object" },
      }],
    });
    expect(semanticCalls).toBe(1);

    const secondPage = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { request_id: requestId, query: "quota left", offset: 1, include_schema: false },
    });
    expect(secondPage.structuredContent).toEqual({ tools: [], total: 1, next_offset: null });
    expect(semanticCalls).toBe(2);

    const noMatch = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { request_id: requestId, query: "explain monads", include_schema: false },
    });
    expect(noMatch.structuredContent).toEqual({ tools: [], total: 0, next_offset: null });

    const unavailable = await client.callTool({
      name: "codex_tool_inventory",
      arguments: { request_id: requestId, query: "typesafe unavailable", include_schema: false },
    });
    expect(unavailable.structuredContent).toEqual({ tools: [], total: 0, next_offset: null });
    expect(semanticCalls).toBe(4);
    expect(observedCriteria.length).toBe(4);
  } finally {
    await client.close().catch(() => {});
    await broker.close();
    await typeSafeServer.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
