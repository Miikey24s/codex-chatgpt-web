import { expect, test } from "bun:test";
import { typeSafeChoice } from "../src/typesafe/client";
import {
  classifyAdapterErrorArrayWithTypeSafe,
  classifyErrorWithTypeSafe,
} from "../src/typesafe/error-classifier";
import {
  TYPESAFE_MAX_CHOICE_OPTIONS,
  typeSafeErrorClassificationConfig,
  typeSafeToolDiscoveryConfig,
} from "../src/typesafe/config";
import { selectToolWithTypeSafe } from "../src/typesafe/tool-discovery";
import type {
  TypeSafeChoiceCallOptions,
  TypeSafeChoiceFn,
  TypeSafeChoiceSuccess,
  TypeSafeFeatureConfig,
} from "../src/typesafe/types";
import type { AdapterEvent } from "../src/types";

const ACTIVE: TypeSafeFeatureConfig = {
  mode: "active",
  endpoint: "https://typesafe.invalid/v1/systemone",
  model: "jev-latest",
  timeoutMs: 2_500,
  confidenceThreshold: 0.9,
};

const SHADOW: TypeSafeFeatureConfig = { ...ACTIVE, mode: "shadow" };

function success(choice: string, confidence = 1): TypeSafeChoiceSuccess {
  return {
    ok: true,
    choice,
    confidence,
    probabilities: { [choice]: 1 },
    model: "jev-test",
    latencyMs: 7,
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}

function chooser(choice: string, confidence = 1): TypeSafeChoiceFn {
  return async () => success(choice, confidence);
}

test("TypeSafe feature config defaults off and accepts bounded overrides", () => {
  expect(typeSafeErrorClassificationConfig({})).toMatchObject({
    mode: "off",
    model: "jev-latest",
    timeoutMs: 2_500,
    confidenceThreshold: 0.9,
  });
  expect(typeSafeErrorClassificationConfig({
    TYPESAFE_ERROR_CLASSIFICATION: "active",
    TYPESAFE_ERROR_CONFIDENCE: "0.97",
    TYPESAFE_TIMEOUT_MS: "1800",
  })).toMatchObject({ mode: "active", confidenceThreshold: 0.97, timeoutMs: 1_800 });
  expect(typeSafeToolDiscoveryConfig({
    TYPESAFE_TOOL_DISCOVERY: "shadow",
    TYPESAFE_TOOL_CONFIDENCE: "not-a-number",
  })).toMatchObject({ mode: "shadow", confidenceThreshold: 0.9 });
});

test("TypeSafe client fails open before network when the API key is missing", async () => {
  let calls = 0;
  const outcome = await typeSafeChoice({
    state: "hello",
    instructions: "Pick one",
    criteria: { yes: null, no: null },
  }, {
    ...ACTIVE,
    apiKey: "",
    fetchImpl: async () => {
      calls += 1;
      return Response.json({});
    },
  });
  expect(outcome).toMatchObject({ ok: false, reason: "missing_api_key" });
  expect(calls).toBe(0);
});

test("TypeSafe client validates Choice responses and never exposes the key in its outcome", async () => {
  let authorization = "";
  const options: TypeSafeChoiceCallOptions = {
    ...ACTIVE,
    apiKey: "secret-test-key",
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        model: "jev-test",
        answers: {
          decision: {
            type: "choice",
            choice: "yes",
            probabilities: { yes: 0.95, no: 0.05 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 42, output_tokens: 5 },
      });
    },
  };
  const outcome = await typeSafeChoice({
    state: { value: 1 },
    instructions: "Pick one",
    criteria: { yes: null, no: null },
  }, options);
  expect(outcome).toMatchObject({
    ok: true,
    choice: "yes",
    confidence: 0.9,
    model: "jev-test",
    usage: { inputTokens: 42, outputTokens: 5 },
  });
  expect(authorization).toBe("Bearer secret-test-key");
  expect(JSON.stringify(outcome)).not.toContain("secret-test-key");
});

test("TypeSafe client retries 429/529 within its budget and rejects malformed answers", async () => {
  for (const retryStatus of [429, 529]) {
    let attempts = 0;
    const outcome = await typeSafeChoice({
      state: "retry",
      instructions: "Pick one",
      criteria: { yes: null, no: null },
    }, {
      ...ACTIVE,
      apiKey: "test-key",
      sleep: async () => {},
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) return new Response("busy", { status: retryStatus });
        return Response.json({
          model: "jev-test",
          answers: {
            decision: {
              type: "choice",
              choice: "not-an-option",
              probabilities: { yes: 0.5, no: 0.5 },
              confidence: 0,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    expect(attempts).toBe(2);
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_response" });
  }
});

test("semantic error fallback fails open when TypeSafe is unavailable", async () => {
  const event: Extract<AdapterEvent, { type: "error" }> = {
    type: "error",
    message: "Request frequency exceeded for this account; slow down before retrying.",
  };
  expect(await classifyErrorWithTypeSafe(event, {
    config: ACTIVE,
    choose: async () => ({
      ok: false,
      reason: "network_error",
      latencyMs: 8,
    }),
  })).toEqual(event);
});

test("TypeSafe client fails open for non-retryable HTTP errors", async () => {
  for (const status of [401, 422, 500]) {
    const outcome = await typeSafeChoice({
      state: "http failure",
      instructions: "Pick one",
      criteria: { yes: null, no: null },
    }, {
      ...ACTIVE,
      apiKey: "test-key",
      fetchImpl: async () => new Response("failed", { status }),
    });
    expect(outcome).toMatchObject({ ok: false, reason: "http_error", status });
  }
});

test("TypeSafe client distinguishes caller aborts from its own timeout", async () => {
  const pendingFetch: TypeSafeChoiceCallOptions["fetchImpl"] = async (_input, init) => {
    await new Promise<void>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    throw new Error("unreachable");
  };

  const controller = new AbortController();
  controller.abort();
  const aborted = await typeSafeChoice({
    state: "caller abort",
    instructions: "Pick one",
    criteria: { yes: null, no: null },
    signal: controller.signal,
  }, {
    ...ACTIVE,
    apiKey: "test-key",
    fetchImpl: pendingFetch,
  });
  expect(aborted).toMatchObject({ ok: false, reason: "aborted" });

  const timedOut = await typeSafeChoice({
    state: "timeout",
    instructions: "Pick one",
    criteria: { yes: null, no: null },
  }, {
    ...ACTIVE,
    timeoutMs: 10,
    apiKey: "test-key",
    fetchImpl: pendingFetch,
  });
  expect(timedOut).toMatchObject({ ok: false, reason: "timeout" });
});

test("structured and deterministic error evidence bypasses TypeSafe", async () => {
  let calls = 0;
  const choose: TypeSafeChoiceFn = async () => {
    calls += 1;
    return success("rate_limit");
  };
  const structured: Extract<AdapterEvent, { type: "error" }> = {
    type: "error",
    message: "anything",
    status: 401,
    errorType: "authentication_error",
    code: "invalid_api_key",
  };
  const known: Extract<AdapterEvent, { type: "error" }> = {
    type: "error",
    message: "ChatGPT rate limit: too many requests.",
  };
  expect(await classifyErrorWithTypeSafe(structured, { config: ACTIVE, choose })).toEqual(structured);
  expect(await classifyErrorWithTypeSafe(known, { config: ACTIVE, choose })).toEqual(known);
  expect(calls).toBe(0);
});

test("active semantic error fallback maps only high-confidence non-unknown choices", async () => {
  const event: Extract<AdapterEvent, { type: "error" }> = {
    type: "error",
    message: "Request frequency exceeded for this account; slow down before retrying.",
  };
  expect(await classifyErrorWithTypeSafe(event, {
    config: ACTIVE,
    choose: chooser("rate_limit", 0.99),
  })).toEqual({
    ...event,
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
  });
  expect(await classifyErrorWithTypeSafe(event, {
    config: ACTIVE,
    choose: chooser("rate_limit", 0.4),
  })).toEqual(event);
  expect(await classifyErrorWithTypeSafe(event, {
    config: ACTIVE,
    choose: chooser("unknown", 1),
  })).toEqual(event);
  expect(await classifyErrorWithTypeSafe(event, {
    config: SHADOW,
    choose: chooser("rate_limit", 1),
  })).toEqual(event);
});

test("batch error transform preserves event order and non-error events", async () => {
  const events: AdapterEvent[] = [
    { type: "text_delta", text: "partial" },
    { type: "error", message: "The service is at capacity; please try again shortly." },
  ];
  const previous = process.env.TYPESAFE_ERROR_CLASSIFICATION;
  process.env.TYPESAFE_ERROR_CLASSIFICATION = "off";
  try {
    expect(await classifyAdapterErrorArrayWithTypeSafe(events)).toEqual(events);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_ERROR_CLASSIFICATION;
    else process.env.TYPESAFE_ERROR_CLASSIFICATION = previous;
  }
});

test("tool discovery selects only provided candidates and obeys confidence/mode gates", async () => {
  const candidates = [
    { wireName: "get_usage_limits", description: "Read usage limits, remaining quota, and reset times." },
    { wireName: "set_thread_title", description: "Rename the current Codex task." },
  ];
  expect(await selectToolWithTypeSafe("quota left", candidates, {
    config: ACTIVE,
    choose: chooser("get_usage_limits", 0.99),
  })).toEqual({ attempted: true, wireName: "get_usage_limits" });
  expect(await selectToolWithTypeSafe("quota left", candidates, {
    config: ACTIVE,
    choose: chooser("get_usage_limits", 0.5),
  })).toEqual({ attempted: true });
  expect(await selectToolWithTypeSafe("quota left", candidates, {
    config: ACTIVE,
    choose: chooser("__NO_MATCH__", 1),
  })).toEqual({ attempted: true });
  expect(await selectToolWithTypeSafe("quota left", candidates, {
    config: SHADOW,
    choose: chooser("get_usage_limits", 1),
  })).toEqual({ attempted: true });
  expect(await selectToolWithTypeSafe("quota left", candidates, {
    config: ACTIVE,
    choose: chooser("hidden_tool", 1),
  })).toEqual({ attempted: true });
});

test("tool discovery abstains before the API when the Choice candidate limit would be exceeded", async () => {
  let calls = 0;
  const candidates = Array.from({ length: TYPESAFE_MAX_CHOICE_OPTIONS }, (_, index) => ({
    wireName: `tool_${index}`,
    description: `Tool ${index}`,
  }));
  const result = await selectToolWithTypeSafe("find it", candidates, {
    config: ACTIVE,
    choose: async () => {
      calls += 1;
      return success("tool_0");
    },
  });
  expect(result).toEqual({ attempted: false, candidateLimitExceeded: true });
  expect(calls).toBe(0);
});
