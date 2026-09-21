export type TypeSafeMode = "off" | "shadow" | "active";

export interface TypeSafeFeatureConfig {
  mode: TypeSafeMode;
  endpoint: string;
  model: string;
  timeoutMs: number;
  confidenceThreshold: number;
}

export interface TypeSafeChoiceRequest {
  state: string | Record<string, unknown> | unknown[];
  instructions: string | Record<string, unknown> | unknown[];
  criteria: Record<string, string | null>;
  signal?: AbortSignal;
}

export interface TypeSafeChoiceSuccess {
  ok: true;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  model: string;
  latencyMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export type TypeSafeUnavailableReason =
  | "missing_api_key"
  | "timeout"
  | "aborted"
  | "http_error"
  | "network_error"
  | "invalid_response";

export interface TypeSafeChoiceUnavailable {
  ok: false;
  reason: TypeSafeUnavailableReason;
  latencyMs: number;
  status?: number;
}

export type TypeSafeChoiceOutcome = TypeSafeChoiceSuccess | TypeSafeChoiceUnavailable;

export type TypeSafeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TypeSafeChoiceCallOptions extends TypeSafeFeatureConfig {
  apiKey?: string;
  fetchImpl?: TypeSafeFetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type TypeSafeChoiceFn = (
  request: TypeSafeChoiceRequest,
  options: TypeSafeChoiceCallOptions,
) => Promise<TypeSafeChoiceOutcome>;

export interface TypeSafeDiagnosticEvent {
  feature: "error_classification" | "tool_discovery";
  mode: Exclude<TypeSafeMode, "off">;
  outcome: "selected" | "abstained" | "shadow" | "unavailable";
  choice?: string;
  confidence?: number;
  model?: string;
  latency_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  reason?: string;
}
