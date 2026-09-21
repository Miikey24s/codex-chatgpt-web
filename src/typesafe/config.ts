import type { TypeSafeFeatureConfig, TypeSafeMode } from "./types";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_CONFIDENCE = 0.9;

function parseMode(value: string | undefined): TypeSafeMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "shadow" || normalized === "active" ? normalized : "off";
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function endpoint(value: string | undefined): string {
  const configured = value?.trim();
  if (!configured) return DEFAULT_ENDPOINT;
  try {
    const parsed = new URL(configured);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : DEFAULT_ENDPOINT;
  } catch {
    return DEFAULT_ENDPOINT;
  }
}

function commonConfig(env: NodeJS.ProcessEnv): Omit<TypeSafeFeatureConfig, "mode" | "confidenceThreshold"> {
  return {
    endpoint: endpoint(env.TYPESAFE_ENDPOINT),
    model: env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: boundedNumber(env.TYPESAFE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 250, 10_000),
  };
}

export function typeSafeErrorClassificationConfig(env: NodeJS.ProcessEnv = process.env): TypeSafeFeatureConfig {
  return {
    ...commonConfig(env),
    mode: parseMode(env.TYPESAFE_ERROR_CLASSIFICATION),
    confidenceThreshold: boundedNumber(
      env.TYPESAFE_ERROR_CONFIDENCE,
      DEFAULT_CONFIDENCE,
      0,
      1,
    ),
  };
}

export function typeSafeToolDiscoveryConfig(env: NodeJS.ProcessEnv = process.env): TypeSafeFeatureConfig {
  return {
    ...commonConfig(env),
    mode: parseMode(env.TYPESAFE_TOOL_DISCOVERY),
    confidenceThreshold: boundedNumber(
      env.TYPESAFE_TOOL_CONFIDENCE,
      DEFAULT_CONFIDENCE,
      0,
      1,
    ),
  };
}

export const TYPESAFE_MAX_CHOICE_OPTIONS = 255;
