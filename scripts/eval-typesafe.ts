import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adapterFailureFromMessage } from "../src/lib/errors";
import { typeSafeChoice } from "../src/typesafe/client";
import { typeSafeErrorClassificationConfig, typeSafeToolDiscoveryConfig } from "../src/typesafe/config";
import { classifyErrorWithTypeSafe, type TypeSafeErrorLabel } from "../src/typesafe/error-classifier";
import { selectToolWithTypeSafe, type TypeSafeToolCandidate } from "../src/typesafe/tool-discovery";
import type { TypeSafeChoiceOutcome } from "../src/typesafe/types";

interface ErrorFixture {
  id: string;
  message: string;
  gold: TypeSafeErrorLabel;
}

interface ToolFixture {
  candidates: TypeSafeToolCandidate[];
  cases: Array<{ id: string; query: string; gold: string | null }>;
}

const root = process.cwd();
const errors = JSON.parse(readFileSync(
  join(root, "tests", "fixtures", "typesafe", "error-classification.json"),
  "utf8",
)) as ErrorFixture[];
const tools = JSON.parse(readFileSync(
  join(root, "tests", "fixtures", "typesafe", "tool-discovery.json"),
  "utf8",
)) as ToolFixture;

if (!process.env.TYPESAFE_API_KEY?.trim()) {
  throw new Error("TYPESAFE_API_KEY is required for the live TypeSafe evaluation");
}

const errorConfig = { ...typeSafeErrorClassificationConfig(), mode: "active" as const, confidenceThreshold: 0 };
const toolConfig = { ...typeSafeToolDiscoveryConfig(), mode: "active" as const, confidenceThreshold: 0 };
const thresholds = [0.5, 0.7, 0.8, 0.9, 0.95];
const calibratedThreshold = 0.9;

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))]!;
}

function outcomeStats(outcomes: Array<TypeSafeChoiceOutcome | undefined>): string {
  const available = outcomes.filter((outcome): outcome is Extract<TypeSafeChoiceOutcome, { ok: true }> => outcome?.ok === true);
  const attempted = outcomes.filter((outcome): outcome is TypeSafeChoiceOutcome => outcome !== undefined);
  return [
    `calls=${attempted.length}`,
    `failures=${attempted.length - available.length}`,
    `p50_ms=${percentile(available.map(outcome => outcome.latencyMs), 0.5)}`,
    `p95_ms=${percentile(available.map(outcome => outcome.latencyMs), 0.95)}`,
    `input_tokens=${available.reduce((sum, outcome) => sum + outcome.usage.inputTokens, 0)}`,
    `output_tokens=${available.reduce((sum, outcome) => sum + outcome.usage.outputTokens, 0)}`,
  ].join(" ");
}

function baselineErrorLabel(message: string): TypeSafeErrorLabel {
  const failure = adapterFailureFromMessage(message);
  const code = failure.error.code;
  if (code === "rate_limit_exceeded") return "rate_limit";
  if (code === "invalid_api_key") return "authentication";
  if (code === "context_length_exceeded") return "context_length";
  if (code === "server_is_overloaded") return "overloaded";
  if (code === "insufficient_quota") return "quota";
  if (code === "client_closed_request" || code === "client_cancelled") return "client_closed";
  if (code === "subscription_required") return "subscription";
  if (code === "permission_denied") return "permission";
  if (failure.httpStatus === 504) return "timeout";
  if (code === "invalid_request_error") return "invalid_request";
  return "unknown";
}

const errorRows: Array<{
  id: string;
  gold: TypeSafeErrorLabel;
  baseline: TypeSafeErrorLabel;
  semantic?: TypeSafeChoiceOutcome;
}> = [];

for (const fixture of errors) {
  let semantic: TypeSafeChoiceOutcome | undefined;
  await classifyErrorWithTypeSafe({ type: "error", message: fixture.message }, {
    config: errorConfig,
    choose: async (request, options) => {
      semantic = await typeSafeChoice(request, options);
      return semantic;
    },
  });
  errorRows.push({
    id: fixture.id,
    gold: fixture.gold,
    baseline: baselineErrorLabel(fixture.message),
    ...(semantic ? { semantic } : {}),
  });
}

const baselineCorrect = errorRows.filter(row => row.baseline === row.gold).length;
console.log(`errors baseline ${baselineCorrect}/${errorRows.length}`);
for (const threshold of thresholds) {
  let correct = 0;
  let automatic = 0;
  let unknownFalsePositive = 0;
  for (const row of errorRows) {
    let prediction = row.baseline;
    if (row.semantic?.ok) {
      const choice = row.semantic.choice as TypeSafeErrorLabel;
      const confident = row.semantic.confidence >= threshold && choice !== "unknown";
      prediction = confident ? choice : "unknown";
      if (confident) automatic += 1;
    }
    if (prediction === row.gold) correct += 1;
    if (row.gold === "unknown" && prediction !== "unknown") unknownFalsePositive += 1;
  }
  console.log(`errors threshold=${threshold.toFixed(2)} accuracy=${correct}/${errorRows.length} automatic=${automatic} unknown_fp=${unknownFalsePositive}`);
}
console.log(`errors ${outcomeStats(errorRows.map(row => row.semantic))}`);

const calibratedErrorPredictions = errorRows.map(row => {
  if (!row.semantic?.ok) return { gold: row.gold, prediction: row.baseline };
  const choice = row.semantic.choice as TypeSafeErrorLabel;
  const prediction = row.semantic.confidence >= calibratedThreshold && choice !== "unknown" ? choice : "unknown";
  return { gold: row.gold, prediction };
});
for (const label of [...new Set(errors.map(row => row.gold))].sort()) {
  const truePositive = calibratedErrorPredictions.filter(row => row.gold === label && row.prediction === label).length;
  const predicted = calibratedErrorPredictions.filter(row => row.prediction === label).length;
  const actual = calibratedErrorPredictions.filter(row => row.gold === label).length;
  const precision = predicted === 0 ? 1 : truePositive / predicted;
  const recall = actual === 0 ? 1 : truePositive / actual;
  console.log(`errors label=${label} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} support=${actual}`);
}

for (const row of errorRows) {
  const semantic = row.semantic;
  console.log(JSON.stringify({
    kind: "error",
    id: row.id,
    gold: row.gold,
    baseline: row.baseline,
    semantic: semantic?.ok ? semantic.choice : semantic?.reason ?? "skipped",
    confidence: semantic?.ok ? semantic.confidence : null,
    latency_ms: semantic?.latencyMs ?? 0,
  }));
}

const toolRows: Array<{
  id: string;
  gold: string | null;
  lexical: string[];
  semantic?: TypeSafeChoiceOutcome;
}> = [];

for (const fixture of tools.cases) {
  const needle = fixture.query.trim().toLowerCase();
  const lexical = tools.candidates
    .filter(candidate => `${candidate.wireName}\n${candidate.description}`.toLowerCase().includes(needle))
    .map(candidate => candidate.wireName);
  if (lexical.length > 0) {
    toolRows.push({ id: fixture.id, gold: fixture.gold, lexical });
    continue;
  }
  let semantic: TypeSafeChoiceOutcome | undefined;
  await selectToolWithTypeSafe(fixture.query, tools.candidates, {
    config: toolConfig,
    choose: async (request, options) => {
      semantic = await typeSafeChoice(request, options);
      return semantic;
    },
  });
  if (!semantic) throw new Error(`Tool evaluation did not execute for ${fixture.id}`);
  toolRows.push({ id: fixture.id, gold: fixture.gold, lexical, semantic });
}

for (const threshold of thresholds) {
  let correct = 0;
  let automatic = 0;
  let noMatchFalsePositive = 0;
  let rescued = 0;
  let semanticCases = 0;
  for (const row of toolRows) {
    if (row.lexical.length > 0) {
      if (row.gold !== null && row.lexical.includes(row.gold)) correct += 1;
      continue;
    }
    semanticCases += 1;
    const predicted = row.semantic?.ok
      && row.semantic.confidence >= threshold
      && row.semantic.choice !== "__NO_MATCH__"
      ? row.semantic.choice
      : null;
    if (predicted === row.gold) correct += 1;
    if (predicted !== null) {
      automatic += 1;
      if (predicted === row.gold) rescued += 1;
    }
    if (row.gold === null && predicted !== null) noMatchFalsePositive += 1;
  }
  console.log(`tools threshold=${threshold.toFixed(2)} inventory_success=${correct}/${toolRows.length} semantic_cases=${semanticCases} automatic=${automatic} rescued=${rescued} no_match_fp=${noMatchFalsePositive}`);
}
console.log(`tools ${outcomeStats(toolRows.map(row => row.semantic))}`);

for (const row of toolRows) {
  console.log(JSON.stringify({
    kind: "tool",
    id: row.id,
    gold: row.gold,
    lexical: row.lexical,
    semantic: row.semantic?.ok ? row.semantic.choice : row.semantic?.reason ?? "skipped",
    confidence: row.semantic?.ok ? row.semantic.confidence : null,
    latency_ms: row.semantic?.latencyMs ?? 0,
  }));
}
