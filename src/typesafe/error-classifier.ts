import { adapterFailureFromMessage } from "../lib/errors";
import type { AdapterEvent } from "../types";
import { logTypeSafeDiagnostic, typeSafeChoice } from "./client";
import { typeSafeErrorClassificationConfig } from "./config";
import type {
  TypeSafeChoiceCallOptions,
  TypeSafeChoiceFn,
  TypeSafeFeatureConfig,
} from "./types";

export type TypeSafeErrorLabel =
  | "authentication"
  | "permission"
  | "subscription"
  | "quota"
  | "rate_limit"
  | "context_length"
  | "overloaded"
  | "timeout"
  | "invalid_request"
  | "client_closed"
  | "unknown";

const ERROR_CRITERIA: Record<TypeSafeErrorLabel, string> = {
  authentication: "Credentials, login, API key, signature, session token, or authentication failed.",
  permission: "The identity is authenticated but is not allowed to use the requested model or resource.",
  subscription: "Access requires a paid subscription, plan, tier, or upgrade.",
  quota: "An account, billing, usage, daily, monthly, credit, or other quota is exhausted.",
  rate_limit: "Requests are arriving too frequently or a request-rate/throttling limit was hit.",
  context_length: "The prompt or conversation exceeds the model context or token capacity.",
  overloaded: "The upstream service is busy, overloaded, at capacity, or temporarily unavailable.",
  timeout: "The operation exceeded a deadline or time limit.",
  invalid_request: "The request or model identifier is malformed, unsupported, invalid, or does not exist.",
  client_closed: "The caller/client disconnected, cancelled, or closed its request before completion.",
  unknown: "None of the defined causes is supported by the message, including generic DNS/TLS/socket/decoding failures.",
};

const ERROR_MAPPING: Record<Exclude<TypeSafeErrorLabel, "unknown">, {
  status: number;
  errorType: string;
  code: string;
}> = {
  authentication: { status: 401, errorType: "authentication_error", code: "invalid_api_key" },
  permission: { status: 403, errorType: "permission_error", code: "permission_denied" },
  subscription: { status: 403, errorType: "permission_error", code: "subscription_required" },
  quota: { status: 429, errorType: "insufficient_quota", code: "insufficient_quota" },
  rate_limit: { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded" },
  context_length: { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded" },
  overloaded: { status: 503, errorType: "server_error", code: "server_is_overloaded" },
  timeout: { status: 504, errorType: "server_error", code: "upstream_server_error" },
  invalid_request: { status: 400, errorType: "invalid_request_error", code: "invalid_request_error" },
  client_closed: { status: 499, errorType: "invalid_request_error", code: "client_closed_request" },
};

type ErrorEvent = Extract<AdapterEvent, { type: "error" }>;

function ambiguousUnstructuredError(event: ErrorEvent): boolean {
  if (event.status !== undefined || event.errorType !== undefined || event.code !== undefined) return false;
  const current = adapterFailureFromMessage(event.message);
  return current.httpStatus === 502
    && current.error.type === "server_error"
    && current.error.code === "upstream_server_error";
}

export async function classifyErrorWithTypeSafe(
  event: ErrorEvent,
  options: {
    config?: TypeSafeFeatureConfig;
    choose?: TypeSafeChoiceFn;
    callOptions?: Partial<TypeSafeChoiceCallOptions>;
    signal?: AbortSignal;
  } = {},
): Promise<ErrorEvent> {
  const config = options.config ?? typeSafeErrorClassificationConfig();
  if (config.mode === "off" || !ambiguousUnstructuredError(event)) return event;
  const choose = options.choose ?? typeSafeChoice;
  const outcome = await choose({
    state: {
      status: 502,
      provider_type: "server_error",
      message: event.message,
    },
    instructions: "Classify the operational error by its primary cause. Use unknown unless the message supports one defined cause.",
    criteria: ERROR_CRITERIA,
    signal: options.signal,
  }, {
    ...config,
    ...options.callOptions,
  });
  if (!outcome.ok) {
    logTypeSafeDiagnostic({
      feature: "error_classification",
      mode: config.mode,
      outcome: "unavailable",
      latency_ms: outcome.latencyMs,
      reason: outcome.reason,
    });
    return event;
  }
  const label = outcome.choice as TypeSafeErrorLabel;
  const eligible = label !== "unknown" && outcome.confidence >= config.confidenceThreshold;
  logTypeSafeDiagnostic({
    feature: "error_classification",
    mode: config.mode,
    outcome: config.mode === "shadow" ? "shadow" : eligible ? "selected" : "abstained",
    choice: label,
    confidence: outcome.confidence,
    model: outcome.model,
    latency_ms: outcome.latencyMs,
    input_tokens: outcome.usage.inputTokens,
    output_tokens: outcome.usage.outputTokens,
  });
  if (config.mode !== "active" || !eligible) return event;
  return { ...event, ...ERROR_MAPPING[label as Exclude<TypeSafeErrorLabel, "unknown">] };
}

export async function* classifyAdapterErrorsWithTypeSafe(
  events: AsyncIterable<AdapterEvent>,
  signal?: AbortSignal,
): AsyncGenerator<AdapterEvent> {
  for await (const event of events) {
    yield event.type === "error"
      ? await classifyErrorWithTypeSafe(event, { signal })
      : event;
  }
}

export async function classifyAdapterErrorArrayWithTypeSafe(
  events: AdapterEvent[],
  signal?: AbortSignal,
): Promise<AdapterEvent[]> {
  const output: AdapterEvent[] = [];
  for (const event of events) {
    output.push(event.type === "error"
      ? await classifyErrorWithTypeSafe(event, { signal })
      : event);
  }
  return output;
}
