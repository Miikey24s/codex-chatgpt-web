import type {
  TypeSafeChoiceCallOptions,
  TypeSafeChoiceOutcome,
  TypeSafeChoiceRequest,
  TypeSafeDiagnosticEvent,
} from "./types";

const RETRYABLE_STATUSES = new Set([429, 529]);
const RETRY_DELAYS_MS = [100, 250] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseChoice(
  body: unknown,
  latencyMs: number,
  expectedOptions: ReadonlySet<string>,
): TypeSafeChoiceOutcome {
  if (!isRecord(body) || typeof body.model !== "string" || !isRecord(body.answers) || !isRecord(body.usage)) {
    return { ok: false, reason: "invalid_response", latencyMs };
  }
  const answerValues = Object.values(body.answers);
  if (answerValues.length !== 1 || !isRecord(answerValues[0])) {
    return { ok: false, reason: "invalid_response", latencyMs };
  }
  const answer = answerValues[0];
  if (answer.type !== "choice"
    || typeof answer.choice !== "string"
    || !expectedOptions.has(answer.choice)
    || !isRecord(answer.probabilities)
    || typeof answer.confidence !== "number"
    || !Number.isFinite(answer.confidence)
    || answer.confidence < 0
    || answer.confidence > 1) {
    return { ok: false, reason: "invalid_response", latencyMs };
  }
  const probabilities: Record<string, number> = {};
  for (const option of expectedOptions) {
    const probability = answer.probabilities[option];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { ok: false, reason: "invalid_response", latencyMs };
    }
    probabilities[option] = probability;
  }
  const inputTokens = body.usage.input_tokens;
  const outputTokens = body.usage.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 0
    || !Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) {
    return { ok: false, reason: "invalid_response", latencyMs };
  }
  return {
    ok: true,
    choice: answer.choice,
    probabilities,
    confidence: answer.confidence,
    model: body.model,
    latencyMs,
    usage: {
      inputTokens: inputTokens as number,
      outputTokens: outputTokens as number,
    },
  };
}

function abortSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

export async function typeSafeChoice(
  request: TypeSafeChoiceRequest,
  options: TypeSafeChoiceCallOptions,
): Promise<TypeSafeChoiceOutcome> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY?.trim();
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  if (!apiKey) return { ok: false, reason: "missing_api_key", latencyMs: elapsed(now, startedAt) };

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const questionId = "decision";
  const body = JSON.stringify({
    state: request.state,
    model: options.model,
    questions: {
      [questionId]: {
        type: "choice",
        instructions: request.instructions,
        criteria: request.criteria,
      },
    },
  });
  const expectedOptions = new Set(Object.keys(request.criteria));
  const deadline = startedAt + options.timeoutMs;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const remaining = Math.max(0, deadline - now());
    if (remaining <= 0) return { ok: false, reason: "timeout", latencyMs: elapsed(now, startedAt) };
    const bounded = abortSignal(request.signal, remaining);
    try {
      const response = await fetchImpl(options.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: bounded.signal,
      });
      if (response.ok) {
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          return { ok: false, reason: "invalid_response", latencyMs: elapsed(now, startedAt) };
        }
        return responseChoice(parsed, elapsed(now, startedAt), expectedOptions);
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (!RETRYABLE_STATUSES.has(response.status) || delay === undefined) {
        return { ok: false, reason: "http_error", status: response.status, latencyMs: elapsed(now, startedAt) };
      }
      const afterResponse = Math.max(0, deadline - now());
      if (afterResponse <= delay) {
        return { ok: false, reason: "timeout", latencyMs: elapsed(now, startedAt) };
      }
      await sleep(delay);
    } catch (error) {
      if (bounded.signal.aborted) {
        return {
          ok: false,
          reason: bounded.timedOut() ? "timeout" : "aborted",
          latencyMs: elapsed(now, startedAt),
        };
      }
      return { ok: false, reason: "network_error", latencyMs: elapsed(now, startedAt) };
    } finally {
      bounded.dispose();
    }
  }
  return { ok: false, reason: "network_error", latencyMs: elapsed(now, startedAt) };
}

export function logTypeSafeDiagnostic(event: TypeSafeDiagnosticEvent): void {
  console.error(`[typesafe] ${JSON.stringify(event)}`);
}
