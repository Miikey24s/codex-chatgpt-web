import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { extractChatGptToolRegistryEnvironment } from "../src/adapters/chatgpt-web/environment";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultConfig, defaultBrokerEndpoint, providerConfig } from "../src/config";
import { modelsRequest, responseRequest } from "../src/server";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig, CodexTool } from "../src/types";

const tool: CodexTool = {
  name: "read_file",
  description: "Read a file through outer Codex",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

async function invokeAfterBrowserBoundary<T>(turn: BrowserTurn, invoke: () => Promise<T>): Promise<T> {
  const progress = turn.externalProgress;
  if (!progress) throw new Error("provider-only browser turn has no outer-tool progress transport");
  const previousBatchRevision = progress.snapshot().lastToolBatchRevision;
  const invocation = invoke();
  let snapshot = progress.snapshot();
  while (snapshot.lastToolBatchRevision <= previousBatchRevision) {
    snapshot = await progress.waitForChange(snapshot.revision, turn.abortSignal);
  }
  await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  return await invocation;
}

function providerOnlyRequest(): CodexParsedRequest {
  const threadId = "thread_provider_only";
  const turnId = "turn_provider_only";
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools: [tool],
      messages: [{ role: "user", content: "Read README.md", timestamp: 1 }],
    },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Read README.md" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    },
  };
}

test("Cockpit config marks ChatGPT Web as provider-only without disabling native Codex tools", () => {
  const cockpit = defaultConfig("full");
  cockpit.integrationOwner = "cockpit";
  const standalone = defaultConfig("full");
  standalone.integrationOwner = "standalone";

  expect(providerConfig(cockpit).chatgptWeb?.localToolsEnabled).toBe(true);
  expect(providerConfig(cockpit).chatgptWeb?.providerOnly).toBe(true);
  expect(providerConfig(standalone).chatgptWeb?.providerOnly).toBe(false);
});

test("provider-only tool authority needs the Responses tool registry but no cwd or sandbox envelope", () => {
  const environment = extractChatGptToolRegistryEnvironment({
    context: { tools: [tool] },
  } as CodexParsedRequest);

  expect(environment).toEqual({ authority: "tool-registry", tools: [tool] });
  expect("cwd" in environment).toBe(false);
  expect("sandboxPolicy" in environment).toBe(false);
});

test("turn broker accepts provider-only tool authority and lets later rounds refresh the registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-provider-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({ authority: "tool-registry", tools: [tool] }, 10_000, "trace_provider");
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
    await broker.updateEnvironment(token, {
      authority: "tool-registry",
      tools: [tool, { ...tool, name: "write_file" }],
    });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider-only tool loop returns native Responses calls without cwd and resumes on Codex output", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-provider-native-loop-"));
  const socketPath = defaultBrokerEndpoint(root);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://provider-only-native-loop-${Date.now()}`,
    chatgptWeb: {
      brokerSocketPath: socketPath,
      turnTimeoutMs: 30_000,
      localToolsEnabled: true,
      providerOnly: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  let preparedPrompt = "";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    const prepared = await turn.prepare();
    preparedPrompt = prepared.text;
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("provider-only prompt did not expose its turn token");
      const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
      const result = await invokeAfterBrowserBoundary(turn, () => callTurnBroker<{
        structuredContent?: unknown;
      }>(socketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "read_file",
        freeform: false,
        arguments: { path: "README.md" },
      }, 30_000));
      const content = (result.structuredContent as { content?: unknown } | undefined)?.content;
      const answer = `Read result: ${String(content ?? "missing")}`;
      turn.onTextDelta(answer);
      return answer;
    } finally {
      prepared.release();
    }
  };

  const adapter = createChatGptWebAdapter(provider);
  const first = providerOnlyRequest();
  const firstEvents: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(first, { headers: new Headers() }, event => firstEvents.push(event));
    const call = firstEvents.find(
      (event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start",
    );
    expect(call?.name).toBe("read_file");
    expect(firstEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    expect(preparedPrompt).not.toContain("<cwd>");
    expect(preparedPrompt).not.toContain("<environment_context>");

    const continuation = structuredClone(first);
    continuation.context.messages.push(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: call!.id, name: "read_file", arguments: { path: "README.md" } }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: call!.id,
        toolName: "read_file",
        content: JSON.stringify({ content: "provider-only evidence" }),
        isError: false,
        timestamp: 3,
      },
    );
    ((continuation._rawBody as { input: unknown[] }).input).push(
      {
        type: "function_call",
        call_id: call!.id,
        name: "read_file",
        arguments: JSON.stringify({ path: "README.md" }),
      },
      {
        type: "function_call_output",
        call_id: call!.id,
        output: JSON.stringify({ content: "provider-only evidence" }),
      },
    );

    const finalEvents: AdapterEvent[] = [];
    await adapter.runTurn!(continuation, { headers: new Headers() }, event => finalEvents.push(event));
    expect(browserStarts).toBe(1);
    expect(finalEvents.filter(
      (event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta",
    ).map(event => event.text).join(""))
      .toBe("Read result: provider-only evidence");
    expect(finalEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider-only forced tool_choice rejects a browser final that skipped the required tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-provider-forced-tool-"));
  const socketPath = defaultBrokerEndpoint(root);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://provider-only-forced-tool-${Date.now()}`,
    chatgptWeb: {
      brokerSocketPath: socketPath,
      turnTimeoutMs: 30_000,
      localToolsEnabled: true,
      providerOnly: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let preparedPrompt = "";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepare();
    preparedPrompt = prepared.text;
    try {
      turn.onTextDelta("SKIPPED TOOL");
      return "SKIPPED TOOL";
    } finally {
      prepared.release();
    }
  };

  const request = providerOnlyRequest();
  request.options.toolChoice = { name: "read_file" };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
    expect(preparedPrompt).toContain('requires the outer Responses tool "read_file"');
    expect(preparedPrompt).toContain('codex_tool_call with wire_name="read_file"');
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "chatgpt_tool_choice_violation",
      retryable: true,
    }));
    expect(events.some(event => event.type === "done")).toBe(false);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(socketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cockpit provider catalog and Responses fail closed without native Codex fallback", async () => {
  const config = defaultConfig("full");
  config.integrationOwner = "cockpit";
  let nativeCalls = 0;
  const models = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models"),
    config,
    async () => {
      nativeCalls += 1;
      throw new Error("native Codex must not be called by provider-only catalog");
    },
  );
  expect(models.status).toBe(200);
  const catalog = await models.json() as { data: Array<{ id: string }> };
  expect(catalog.data.length).toBeGreaterThan(0);
  expect(catalog.data.every(model => model.id.startsWith("chatgpt-web/"))).toBe(true);
  expect(nativeCalls).toBe(0);

  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
  }), config, () => {
    throw new Error("provider adapter must not start for a native model");
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("not provided by codex-chatgpt-web behind Cockpit");
});
