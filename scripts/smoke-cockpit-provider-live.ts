import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createLauncherDevAdapter } from "../src/dev-chat/driver";
import { loadConfig } from "../src/config";
import { startServer } from "../src/server";

type JsonObject = Record<string, unknown>;

const sourceDevHome = join(homedir(), ".codex-chatgpt-web-dev");
const sourceConfigPath = join(sourceDevHome, "config.json");
const root = mkdtempSync(join(tmpdir(), "cgw-cockpit-provider-live-"));
const codexHome = join(root, "codex-home");
mkdirSync(codexHome, { recursive: true });

function freePort(): number {
  const reservation = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = reservation.port;
  reservation.stop();
  return port;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function outputText(response: JsonObject): string {
  const output = Array.isArray(response.output) ? response.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const content = (item as JsonObject).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      const text = (part as JsonObject).text;
      if (typeof text === "string") chunks.push(text);
    }
  }
  return chunks.join("");
}

function turnBody(options: {
  threadId: string;
  turnId: string;
  model?: string;
  prompt?: string;
  input?: unknown[];
  stream?: boolean;
  tools?: unknown[];
  previousResponseId?: string;
  toolChoice?: unknown;
}): JsonObject {
  const input = options.input ?? [{
    type: "message",
    id: randomId("msg_live"),
    role: "user",
    content: [{ type: "input_text", text: options.prompt ?? "" }],
    internal_chat_message_metadata_passthrough: { turn_id: options.turnId },
  }];
  return {
    model: options.model ?? "chatgpt-web/light",
    instructions: "Follow the user request exactly. Use only the tools explicitly supplied by this Responses request.",
    input,
    tools: options.tools ?? [],
    tool_choice: options.toolChoice ?? "auto",
    parallel_tool_calls: true,
    reasoning: { summary: "none" },
    stream: options.stream === true,
    store: false,
    prompt_cache_key: options.threadId,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: options.threadId,
        turn_id: options.turnId,
        request_kind: "turn",
      }),
    },
    ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
  };
}

type CockpitSidecar = {
  baseUrl: string;
  apiKey: string;
  child: ReturnType<typeof Bun.spawn>;
};

function replaceLoopbackProviderUrl(value: unknown, providerBaseUrl: string): number {
  if (!value || typeof value !== "object") return 0;
  let replacements = 0;
  for (const [key, child] of Object.entries(value as JsonObject)) {
    const normalized = key.toLowerCase().replaceAll("_", "-");
    if ((normalized === "base-url" || normalized === "baseurl")
      && typeof child === "string"
      && /^http:\/\/127\.0\.0\.1:\d+\/v1\/?$/.test(child)) {
      (value as JsonObject)[key] = providerBaseUrl;
      replacements += 1;
      continue;
    }
    replacements += replaceLoopbackProviderUrl(child, providerBaseUrl);
  }
  return replacements;
}

async function waitForCockpit(baseUrl: string, apiKey: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated Cockpit sidecar exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("isolated Cockpit sidecar did not become ready");
}

async function startIsolatedCockpit(
  providerBaseUrl: string,
  sidecarRoot: string,
  requestedPort?: number,
): Promise<CockpitSidecar> {
  const cockpitExe = process.env.COCKPIT_CLIPROXY_EXE?.trim()
    || join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Cockpit Tools", "cockpit-cliproxy.exe");
  if (!existsSync(cockpitExe)) throw new Error(`Cockpit sidecar executable not found: ${cockpitExe}`);

  const sourceRoot = join(homedir(), ".antigravity_cockpit", "codex_local_access_sidecar");
  const configPath = join(sidecarRoot, "config.json");
  const manifestPath = join(sidecarRoot, "manifest.json");
  const reservePath = join(sidecarRoot, "quota-reserve.json");
  const poolPath = join(sidecarRoot, "quota-pool-state.json");
  mkdirSync(sidecarRoot, { recursive: true });
  for (const [source, target] of [
    [join(sourceRoot, "manifest.json"), manifestPath],
    [join(sourceRoot, "quota-reserve.json"), reservePath],
    [join(sourceRoot, "quota-pool-state.json"), poolPath],
  ]) {
    if (!existsSync(source)) throw new Error(`Cockpit sidecar fixture is missing: ${source}`);
    copyFileSync(source, target);
  }

  const sourceConfig = join(sourceRoot, "config.json");
  const config = JSON.parse(readFileSync(sourceConfig, "utf8")) as JsonObject;
  const apiKeys = Array.isArray(config["api-keys"])
    ? config["api-keys"].filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const apiKey = apiKeys[0] ?? "";
  if (!apiKey) throw new Error("Cockpit sidecar fixture has no Local Access API key");
  const port = requestedPort ?? freePort();
  config.port = port;
  config.host = "127.0.0.1";
  const replacements = replaceLoopbackProviderUrl(config, providerBaseUrl);
  if (replacements === 0) throw new Error("Cockpit sidecar fixture has no loopback provider URL to isolate");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const child = Bun.spawn([
    cockpitExe,
    "--config", configPath,
    "--manifest", manifestPath,
    "--quota-reserve-state", reservePath,
    "--quota-pool-state", poolPath,
    "--parent-pid", String(process.pid),
  ], { stdout: "ignore", stderr: "ignore" });
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  await waitForCockpit(baseUrl, apiKey, child);
  return { baseUrl, apiKey, child };
}

async function stopIsolatedCockpit(sidecar: CockpitSidecar): Promise<void> {
  sidecar.child.kill();
  await Promise.race([
    sidecar.child.exited,
    Bun.sleep(10_000).then(() => { throw new Error("isolated Cockpit sidecar did not exit"); }),
  ]);
}

async function cockpitPostJson(sidecar: CockpitSidecar, body: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${sidecar.baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sidecar.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as JsonObject;
  if (!response.ok) throw new Error(`Cockpit HTTP ${response.status}: ${JSON.stringify(payload)}`);
  if (payload.status !== "completed") throw new Error(`Cockpit Responses request did not complete: ${JSON.stringify(payload)}`);
  return payload;
}

async function probeCockpitContinuationMetadataForwarding(probeRoot: string): Promise<void> {
  const upstreamPort = freePort();
  const received: JsonObject[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: upstreamPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({
          object: "list",
          data: [{ id: "chatgpt-web/high", object: "model", created: 0, owned_by: "probe" }],
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/responses")) {
        const body = await request.json() as JsonObject;
        received.push(body);
        const response = {
          id: `resp_cockpit_forward_probe_${received.length}`,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "completed",
          model: typeof body.model === "string" ? body.model : "chatgpt-web/high",
          output: [{
            type: "message",
            id: randomId("msg_probe"),
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "PROBE", annotations: [] }],
            phase: "final_answer",
          }],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          end_turn: true,
        };
        const event = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`;
        return new Response(event, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  let sidecar: CockpitSidecar | undefined;
  try {
    const sidecarRoot = join(probeRoot, "cockpit-forwarding-probe");
    sidecar = await startIsolatedCockpit(`http://127.0.0.1:${upstreamPort}/v1`, sidecarRoot);
    const cockpitPort = Number(new URL(sidecar.baseUrl).port);
    const threadId = randomId("thread_cockpit_probe");
    const first = await cockpitPostJson(sidecar, turnBody({
      threadId,
      turnId: randomId("turn_cockpit_probe_a"),
      model: "chatgpt-web/high",
      prompt: "probe",
    }));
    const previousResponseId = typeof first.id === "string" ? first.id : "";
    if (!previousResponseId) throw new Error("Cockpit forwarding probe returned no response id");
    await stopIsolatedCockpit(sidecar);
    sidecar = undefined;
    sidecar = await startIsolatedCockpit(
      `http://127.0.0.1:${upstreamPort}/v1`,
      sidecarRoot,
      cockpitPort,
    );
    await cockpitPostJson(sidecar, turnBody({
      threadId,
      turnId: randomId("turn_cockpit_probe_b"),
      model: "chatgpt-web/high",
      previousResponseId,
      prompt: "probe again",
    }));
    const last = received.at(-1) ?? {};
    if (last.previous_response_id !== undefined) {
      throw new Error(`Cockpit unexpectedly forwarded previous_response_id across restart: ${String(last.previous_response_id)}`);
    }
    if (last.prompt_cache_key !== threadId) {
      throw new Error(`Cockpit did not preserve prompt_cache_key across restart: ${String(last.prompt_cache_key)}`);
    }
    const metadata = last.client_metadata && typeof last.client_metadata === "object" && !Array.isArray(last.client_metadata)
      ? last.client_metadata as JsonObject
      : {};
    const encodedTurnMetadata = metadata["x-codex-turn-metadata"];
    const turnMetadata = typeof encodedTurnMetadata === "string"
      ? JSON.parse(encodedTurnMetadata) as JsonObject
      : {};
    if (turnMetadata.thread_id !== threadId) {
      throw new Error(`Cockpit did not preserve trusted thread_id across restart: ${JSON.stringify(last.client_metadata)}`);
    }
  } finally {
    if (sidecar) {
      try { await stopIsolatedCockpit(sidecar); } catch {}
    }
    upstream.stop(true);
  }
}

async function postJson(baseUrl: string, body: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as JsonObject;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  if (payload.status !== "completed") throw new Error(`Responses request did not complete: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForClosed(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`candidate port ${port} did not close`);
}

const previousAppHome = process.env.CODEX_CHATGPT_WEB_HOME;
const previousCodexHome = process.env.CODEX_HOME;
let server: ReturnType<typeof startServer> | undefined;
let isolatedCockpit: CockpitSidecar | undefined;

async function startCandidate() {
  const config = loadConfig();
  const { adapterFactory } = createLauncherDevAdapter(config, join(root, "runtime-state"));
  server = startServer(config, { adapterFactory });
  const baseUrl = `http://127.0.0.1:${config.port}/v1`;
  const health = await fetch(`http://127.0.0.1:${config.port}/healthz`);
  if (!health.ok) throw new Error(`candidate health failed with HTTP ${health.status}`);
  return { config, baseUrl };
}

async function stopCandidate(baseUrl: string, controlToken: string): Promise<void> {
  const origin = baseUrl.replace(/\/v1$/, "");
  const headers = { authorization: `Bearer ${controlToken}` };
  const drain = await fetch(`${origin}/admin/drain`, { method: "POST", headers });
  if (!drain.ok) throw new Error(`candidate drain failed with HTTP ${drain.status}`);
  const shutdown = await fetch(`${origin}/admin/shutdown`, { method: "POST", headers });
  if (!shutdown.ok) throw new Error(`candidate shutdown failed with HTTP ${shutdown.status}: ${await shutdown.text()}`);
  await waitForClosed(Number(new URL(origin).port));
  server = undefined;
}

try {
  const raw = JSON.parse(readFileSync(sourceConfigPath, "utf8")) as JsonObject;
  delete raw.purpose;
  raw.integrationOwner = "cockpit";
  raw.subagentProtocol = "native";
  raw.host = "127.0.0.1";
  raw.port = freePort();
  raw.controlToken = randomId("live_control");
  writeFileSync(join(root, "config.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  process.env.CODEX_HOME = codexHome;

  await probeCockpitContinuationMetadataForwarding(root);

  let running = await startCandidate();
  const catalogResponse = await fetch(`${running.baseUrl}/models`);
  const catalog = await catalogResponse.json() as { data?: Array<{ id?: string }> };
  const modelIds = (catalog.data ?? []).map(model => model.id);
  if (!catalogResponse.ok || modelIds.length === 0 || modelIds.some(id => !id?.startsWith("chatgpt-web/"))) {
    throw new Error(`provider-only model catalog is invalid: ${JSON.stringify(catalog)}`);
  }

  const sseThread = randomId("thread_sse");
  const sseTurn = randomId("turn_sse");
  const sse = await fetch(`${running.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(turnBody({
      threadId: sseThread,
      turnId: sseTurn,
      prompt: "Reply with exactly: LIVE SSE OK",
      stream: true,
    })),
  });
  const sseText = await sse.text();
  if (!sse.ok
    || !sse.headers.get("content-type")?.includes("text/event-stream")
    || !sseText.includes("response.output_text.delta")
    || !sseText.includes("response.completed")
    || !sseText.includes("LIVE SSE OK")) {
    throw new Error(`live SSE contract failed: HTTP ${sse.status} ${sseText.slice(-4_000)}`);
  }

  if (process.env.CGW_SKIP_LIVE_TOOL !== "1") {
    const tool = {
      type: "function",
      name: "read_file",
      description: "Read one file through outer Codex. For this live contract smoke, call it exactly once when requested.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    };
    const toolThread = randomId("thread_tool");
    const toolTurn = randomId("turn_tool");
    const initialInput = [{
      type: "message",
      id: randomId("msg_tool"),
      role: "user",
      content: [{
        type: "input_text",
        text: "Use read_file to read README.md. Then reply with only the content field returned by that tool, verbatim. The answer is not present in this request, so do not answer before receiving the tool result.",
      }],
      internal_chat_message_metadata_passthrough: { turn_id: toolTurn },
    }];
    const toolFirst = await postJson(running.baseUrl, turnBody({
      threadId: toolThread,
      turnId: toolTurn,
      model: "chatgpt-web/high",
      input: initialInput,
      tools: [tool],
      toolChoice: { type: "function", name: "read_file" },
    }));
    const firstOutput = Array.isArray(toolFirst.output) ? toolFirst.output : [];
    const call = firstOutput.find(item => (
      item && typeof item === "object" && !Array.isArray(item) && (item as JsonObject).type === "function_call"
    )) as JsonObject | undefined;
    if (!call || typeof call.call_id !== "string" || call.name !== "read_file") {
      throw new Error(`live tool round returned no read_file call: ${JSON.stringify(toolFirst)}`);
    }
    const toolContinuationInput = [
      ...initialInput,
      ...firstOutput,
      {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify({ content: "provider live tool evidence" }),
        internal_chat_message_metadata_passthrough: { turn_id: toolTurn },
      },
    ];
    const toolFinal = await postJson(running.baseUrl, turnBody({
      threadId: toolThread,
      turnId: toolTurn,
      model: "chatgpt-web/high",
      input: toolContinuationInput,
      tools: [tool],
      toolChoice: "auto",
    }));
    if (outputText(toolFinal).trim() !== "provider live tool evidence") {
      throw new Error(`live tool continuation failed: ${JSON.stringify(toolFinal)}`);
    }
  }

  const resumeThread = randomId("thread_resume");
  const firstTurn = randomId("turn_resume_a");
  const marker = `EMBER-${Math.floor(1000 + Math.random() * 9000)}`;
  const remembered = await postJson(running.baseUrl, turnBody({
    threadId: resumeThread,
    turnId: firstTurn,
    prompt: `Remember exactly this value for the next turn: ${marker}. Reply exactly: STORED ${marker}`,
  }));
  const responseId = typeof remembered.id === "string" ? remembered.id : "";
  if (!responseId || !outputText(remembered).includes(marker)) {
    throw new Error(`initial previous_response_id turn failed: ${JSON.stringify(remembered)}`);
  }

  await stopCandidate(running.baseUrl, running.config.controlToken);
  running = await startCandidate();
  const resumed = await postJson(running.baseUrl, turnBody({
    threadId: resumeThread,
    turnId: randomId("turn_resume_b"),
    previousResponseId: responseId,
    prompt: "What exact value did I ask you to remember? Reply with only that value.",
  }));
  if (outputText(resumed).trim() !== marker) {
    throw new Error(`previous_response_id restart continuation lost state: ${JSON.stringify(resumed)}`);
  }

  const cockpitRoot = join(root, "cockpit-sidecar");
  isolatedCockpit = await startIsolatedCockpit(running.baseUrl, cockpitRoot);
  const cockpitPort = Number(new URL(isolatedCockpit.baseUrl).port);
  const cockpitThread = randomId("thread_cockpit_restart");
  const cockpitMarker = `COPPER-${Math.floor(1000 + Math.random() * 9000)}`;
  const cockpitInitial = await cockpitPostJson(isolatedCockpit, turnBody({
    threadId: cockpitThread,
    turnId: randomId("turn_cockpit_a"),
    model: "chatgpt-web/high",
    prompt: `Remember exactly this value across a Cockpit restart: ${cockpitMarker}. Reply exactly: STORED ${cockpitMarker}`,
  }));
  const cockpitResponseId = typeof cockpitInitial.id === "string" ? cockpitInitial.id : "";
  if (!cockpitResponseId || !outputText(cockpitInitial).includes(cockpitMarker)) {
    throw new Error(`Cockpit pre-restart turn failed: ${JSON.stringify(cockpitInitial)}`);
  }

  await stopIsolatedCockpit(isolatedCockpit);
  isolatedCockpit = undefined;
  isolatedCockpit = await startIsolatedCockpit(running.baseUrl, cockpitRoot, cockpitPort);
  const cockpitResumed = await cockpitPostJson(isolatedCockpit, turnBody({
    threadId: cockpitThread,
    turnId: randomId("turn_cockpit_b"),
    model: "chatgpt-web/high",
    previousResponseId: cockpitResponseId,
    prompt: "What exact value did I ask you to remember before the Cockpit restart? Reply with only that value.",
  }));
  if (outputText(cockpitResumed).trim() !== cockpitMarker) {
    throw new Error(`Cockpit restart continuation lost provider routing or state: ${JSON.stringify(cockpitResumed)}`);
  }
  await stopIsolatedCockpit(isolatedCockpit);
  isolatedCockpit = undefined;

  await stopCandidate(running.baseUrl, running.config.controlToken);
  process.stdout.write(JSON.stringify({
    status: "ok",
    checks: [
      "provider-only model catalog",
      "Cockpit strips previous_response_id but preserves continuation metadata",
      "live HTTP SSE",
      ...(process.env.CGW_SKIP_LIVE_TOOL === "1" ? [] : ["live tool call + function_call_output continuation"]),
      "previous_response_id continuation after provider restart",
      "isolated Cockpit restart + thread-scoped fallback continuation",
    ],
  }, null, 2) + "\n");
} finally {
  if (isolatedCockpit) {
    try { await stopIsolatedCockpit(isolatedCockpit); } catch {}
  }
  if (server) {
    try { await server.stop(true); } catch {}
  }
  if (previousAppHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previousAppHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  rmSync(root, { recursive: true, force: true });
}
