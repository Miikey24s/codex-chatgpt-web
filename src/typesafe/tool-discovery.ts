import { logTypeSafeDiagnostic, typeSafeChoice } from "./client";
import { TYPESAFE_MAX_CHOICE_OPTIONS, typeSafeToolDiscoveryConfig } from "./config";
import type {
  TypeSafeChoiceCallOptions,
  TypeSafeChoiceFn,
  TypeSafeFeatureConfig,
} from "./types";

const NONE_OPTION = "__NO_MATCH__";
const MAX_DESCRIPTION_CHARS = 700;

export interface TypeSafeToolCandidate {
  wireName: string;
  description: string;
}

export interface TypeSafeToolSelection {
  wireName?: string;
  attempted: boolean;
  candidateLimitExceeded?: boolean;
}

export async function selectToolWithTypeSafe(
  query: string,
  candidates: readonly TypeSafeToolCandidate[],
  options: {
    config?: TypeSafeFeatureConfig;
    choose?: TypeSafeChoiceFn;
    callOptions?: Partial<TypeSafeChoiceCallOptions>;
    signal?: AbortSignal;
  } = {},
): Promise<TypeSafeToolSelection> {
  const config = options.config ?? typeSafeToolDiscoveryConfig();
  const normalizedQuery = query.trim();
  if (config.mode === "off" || !normalizedQuery || candidates.length === 0) {
    return { attempted: false };
  }
  const unique = new Map<string, TypeSafeToolCandidate>();
  for (const candidate of candidates) {
    if (candidate.wireName === NONE_OPTION) continue;
    unique.set(candidate.wireName, candidate);
  }
  const maxCandidates = TYPESAFE_MAX_CHOICE_OPTIONS - 1;
  if (unique.size > maxCandidates) {
    logTypeSafeDiagnostic({
      feature: "tool_discovery",
      mode: config.mode,
      outcome: "unavailable",
      latency_ms: 0,
      reason: "candidate_limit",
    });
    return { attempted: false, candidateLimitExceeded: true };
  }
  const criteria: Record<string, string | null> = {};
  for (const [wireName, candidate] of unique) {
    criteria[wireName] = candidate.description.slice(0, MAX_DESCRIPTION_CHARS) || "No description supplied.";
  }
  criteria[NONE_OPTION] = "No listed tool meaningfully matches the requested intent.";
  const choose = options.choose ?? typeSafeChoice;
  const outcome = await choose({
    state: { query: normalizedQuery },
    instructions: "Which available tool best matches the tool-search query? Judge semantic intent, not word overlap. Choose __NO_MATCH__ when none fits.",
    criteria,
    signal: options.signal,
  }, {
    ...config,
    ...options.callOptions,
  });
  if (!outcome.ok) {
    logTypeSafeDiagnostic({
      feature: "tool_discovery",
      mode: config.mode,
      outcome: "unavailable",
      latency_ms: outcome.latencyMs,
      reason: outcome.reason,
    });
    return { attempted: true };
  }
  const selected = outcome.choice !== NONE_OPTION
    && unique.has(outcome.choice)
    && outcome.confidence >= config.confidenceThreshold;
  logTypeSafeDiagnostic({
    feature: "tool_discovery",
    mode: config.mode,
    outcome: config.mode === "shadow" ? "shadow" : selected ? "selected" : "abstained",
    choice: outcome.choice,
    confidence: outcome.confidence,
    model: outcome.model,
    latency_ms: outcome.latencyMs,
    input_tokens: outcome.usage.inputTokens,
    output_tokens: outcome.usage.outputTokens,
  });
  return {
    attempted: true,
    ...(config.mode === "active" && selected ? { wireName: outcome.choice } : {}),
  };
}
