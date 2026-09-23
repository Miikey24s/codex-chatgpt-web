import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import {
  isAcceptedCompactionContinuation,
  rememberCompactionContinuation,
  setCompactionDiagnosticsEmitter,
} from "../src/adapters/chatgpt-web/compaction-continuation";
import type { CodexParsedRequest } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type CapturedEvent = Record<string, unknown>;

function captureEmitter(): { events: CapturedEvent[]; emitter: (event: CapturedEvent) => void } {
  const events: CapturedEvent[] = [];
  return { events, emitter: event => events.push(event) };
}

function parsedRequest(overrides: Partial<{
  modelId: string;
  reasoning: string;
  compactionRequest: boolean;
  input: unknown[];
}>): CodexParsedRequest {
  return {
    modelId: overrides.modelId ?? "gpt-5.6-sol",
    options: { reasoning: overrides.reasoning ?? "high" },
    _compactionRequest: overrides.compactionRequest ?? false,
    _rawBody: { input: overrides.input ?? [] },
  } as unknown as CodexParsedRequest;
}

const MODEL = "gpt-5.6-sol";
const REASONING = "high";
const SUMMARY = "Completed unit tests. Next: run integration suite.";
const IDENTITY = { threadId: "thread_diag_test", turnId: "turn_diag_test" };
const SOURCE = { turnId: "turn_source_diag", content: "Implement the requested feature." };

// Build request bodies for each summary format
function v1Body(summary: string, extra: unknown[] = []): unknown[] {
  return [...extra, { role: "user", content: `${SUMMARY_PREFIX}\n${summary}` }];
}
function v2Body(summary: string, extra: unknown[] = []): unknown[] {
  return [...extra, { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary}` }];
}

// Reset emitter after every test so captured events don't bleed between tests.
afterEach(() => {
  setCompactionDiagnosticsEmitter(undefined);
});

// ---------------------------------------------------------------------------
// 1. Valid v1 continuation accepted
// ---------------------------------------------------------------------------
test("diagnostic: valid v1 continuation accepted — event has accepted=true, candidateType=readable_v1", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  // Store checkpoint
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, IDENTITY, [SOURCE], SUMMARY);

  // Clear emitter events accumulated during rememberCompactionContinuation so we isolate the check event
  events.length = 0;

  const continuation = parsedRequest({ input: v1Body(SUMMARY) });
  const accepted = isAcceptedCompactionContinuation(continuation, IDENTITY, SOURCE);

  expect(accepted).toBe(true);

  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  const observedEvent = events.find(e => e.event === "compaction_continuation_request_observed");
  expect(checkEvent).toBeDefined();
  expect(observedEvent).toBeDefined();
  expect(checkEvent!.requestId).toBe(observedEvent!.requestId);
  expect(checkEvent!.accepted).toBe(true);
  expect(checkEvent!.candidateType).toBe("readable_v1");
  expect(checkEvent!.summaryHashMatched).toBe(true);
  expect(checkEvent!.checkpointFound).toBe(true);
  expect(checkEvent!.sourceMatched).toBe(true);
  expect(checkEvent!.rejectionReason).toBeUndefined();
  expect(checkEvent!.threadId).toBe(IDENTITY.threadId);
  expect(checkEvent!.turnId).toBe(IDENTITY.turnId);
  expect(checkEvent!.modelId).toBe(MODEL);
  expect(checkEvent!.reasoning).toBe(REASONING);
  expect(typeof checkEvent!.candidatesScanned).toBe("number");
  expect(checkEvent!.candidatesScanned as number).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// 2. Valid transparent-v2 continuation accepted
// ---------------------------------------------------------------------------
test("diagnostic: valid transparent-v2 continuation accepted — event has candidateType=readable_v2", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, IDENTITY, [SOURCE], SUMMARY);
  events.length = 0;

  const continuation = parsedRequest({ input: v2Body(SUMMARY) });
  const accepted = isAcceptedCompactionContinuation(continuation, IDENTITY, SOURCE);

  expect(accepted).toBe(true);

  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  const observedEvent = events.find(e => e.event === "compaction_continuation_request_observed");
  expect(checkEvent).toBeDefined();
  expect(observedEvent).toBeDefined();
  expect(checkEvent!.requestId).toBe(observedEvent!.requestId);
  expect(checkEvent!.accepted).toBe(true);
  expect(checkEvent!.candidateType).toBe("readable_v2");
  expect(checkEvent!.summaryHashMatched).toBe(true);
  expect(checkEvent!.checkpointSummaryHash).toBe(sha256(SUMMARY));
  expect(checkEvent!.matchedSummaryHash).toBe(sha256(SUMMARY));
  expect(checkEvent!.candidateSummaryHashes).toEqual([sha256(SUMMARY)]);
  expect(checkEvent!.rejectionReason).toBeUndefined();
});

test("diagnostic: repeated checks for one parsed continuation share one request id", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_repeat_check", turnId: "turn_repeat_check" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const continuation = parsedRequest({ input: v2Body(SUMMARY) });
  expect(isAcceptedCompactionContinuation(continuation, identity, SOURCE)).toBe(true);
  expect(isAcceptedCompactionContinuation(continuation, identity, SOURCE)).toBe(true);

  const observed = events.filter(e => e.event === "compaction_continuation_request_observed");
  const checked = events.filter(e => e.event === "compaction_continuation_checked");
  expect(observed).toHaveLength(1);
  expect(checked).toHaveLength(2);
  expect(typeof observed[0]!.requestId).toBe("string");
  expect(checked.every(event => event.requestId === observed[0]!.requestId)).toBe(true);
  expect(checked.every(event => event.checkpointId === checked[0]!.checkpointId)).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. No checkpoint — checkpoint never stored for this scope
// ---------------------------------------------------------------------------
test("diagnostic: no checkpoint — event has accepted=false, rejectionReason=missing_checkpoint", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_no_checkpoint", turnId: "turn_no_checkpoint" };
  const continuation = parsedRequest({ input: v2Body(SUMMARY) });
  const accepted = isAcceptedCompactionContinuation(continuation, identity, SOURCE);

  expect(accepted).toBe(false);

  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent).toBeDefined();
  expect(checkEvent!.accepted).toBe(false);
  expect(checkEvent!.rejectionReason).toBe("missing_checkpoint");
  expect(checkEvent!.checkpointFound).toBe(false);
  expect(checkEvent!.sourceMatched).toBe(false);
  expect(checkEvent!.candidatesScanned).toBe(0);
  expect(checkEvent!.summaryHashMatched).toBe(false);
});

// ---------------------------------------------------------------------------
// 4. Source mismatch — checkpoint exists but source content is wrong
// ---------------------------------------------------------------------------
test("diagnostic: source mismatch — event has accepted=false, rejectionReason=source_mismatch", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_source_mismatch", turnId: "turn_source_mismatch" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const alteredSource = { turnId: SOURCE.turnId, content: "Completely different task." };
  const continuation = parsedRequest({ input: v2Body(SUMMARY) });
  const accepted = isAcceptedCompactionContinuation(continuation, identity, alteredSource);

  expect(accepted).toBe(false);

  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent).toBeDefined();
  expect(checkEvent!.accepted).toBe(false);
  expect(checkEvent!.rejectionReason).toBe("source_mismatch");
  expect(checkEvent!.checkpointFound).toBe(true);
  expect(checkEvent!.sourceMatched).toBe(false);
  expect(checkEvent!.candidatesScanned).toBe(0);
});

// ---------------------------------------------------------------------------
// 5. Summary/hash mismatch — checkpoint exists, source matches, but summary hash differs
// ---------------------------------------------------------------------------
test("diagnostic: summary hash mismatch — event has accepted=false, candidatesScanned>=1", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_hash_mismatch", turnId: "turn_hash_mismatch" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const alteredSummary = "Completely different summary text.";
  const continuation = parsedRequest({ input: v2Body(alteredSummary) });
  const accepted = isAcceptedCompactionContinuation(continuation, identity, SOURCE);

  expect(accepted).toBe(false);

  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent).toBeDefined();
  expect(checkEvent!.accepted).toBe(false);
  expect(checkEvent!.rejectionReason).toBe("summary_hash_mismatch");
  expect(checkEvent!.checkpointFound).toBe(true);
  expect(checkEvent!.sourceMatched).toBe(true);
  expect(checkEvent!.summaryHashMatched).toBe(false);
  expect(checkEvent!.candidatesScanned as number).toBeGreaterThanOrEqual(1);
  // candidateType should be set since we saw a structurally recognized candidate
  expect(checkEvent!.candidateType).toBe("readable_v2");
});

// ---------------------------------------------------------------------------
// 6. Stale candidate before valid candidate — still accepted, candidatesScanned>=2
// ---------------------------------------------------------------------------
test("diagnostic: stale candidate before valid candidate — accepted=true, candidatesScanned>=2", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_stale_before", turnId: "turn_stale_before" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  // Stale summary item appears first (last in array = scanned first by reverse loop), valid second
  const input = [
    { role: "user", content: `${SUMMARY_PREFIX}\n\n${SUMMARY}` },       // valid (at lower index)
    { role: "user", content: `${SUMMARY_PREFIX}\n\nStale old summary` }, // stale (at higher index)
  ];
  const continuation = parsedRequest({ input });
  const accepted = isAcceptedCompactionContinuation(continuation, identity, SOURCE);

  expect(accepted).toBe(true);

  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent).toBeDefined();
  expect(checkEvent!.accepted).toBe(true);
  expect(checkEvent!.candidatesScanned as number).toBeGreaterThanOrEqual(2);
  expect(checkEvent!.summaryHashMatched).toBe(true);
});

// ---------------------------------------------------------------------------
// 7. Candidates exist but none match — all have wrong hashes
// ---------------------------------------------------------------------------
test("diagnostic: candidates exist but none match — accepted=false, rejectionReason=summary_hash_mismatch", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_none_match", turnId: "turn_none_match" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const input = [
    { role: "user", content: `${SUMMARY_PREFIX}\n\nWrong summary A` },
    { role: "user", content: `${SUMMARY_PREFIX}\n\nWrong summary B` },
  ];
  const continuation = parsedRequest({ input });
  const accepted = isAcceptedCompactionContinuation(continuation, identity, SOURCE);

  expect(accepted).toBe(false);

  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent).toBeDefined();
  expect(checkEvent!.accepted).toBe(false);
  expect(checkEvent!.rejectionReason).toBe("summary_hash_mismatch");
  expect(checkEvent!.candidatesScanned as number).toBeGreaterThanOrEqual(1);
  expect(checkEvent!.summaryHashMatched).toBe(false);
  expect(checkEvent!.checkpointFound).toBe(true);
  expect(checkEvent!.sourceMatched).toBe(true);
});

test("diagnostic: no summary candidate — accepted=false, rejectionReason=no_matching_candidate", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_no_candidate", turnId: "turn_no_candidate" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const continuation = parsedRequest({
    input: [{ role: "user", content: "Ordinary continuation without any compaction summary." }],
  });
  const accepted = isAcceptedCompactionContinuation(continuation, identity, SOURCE);

  expect(accepted).toBe(false);
  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent).toBeDefined();
  expect(checkEvent!.rejectionReason).toBe("no_matching_candidate");
  expect(checkEvent!.candidatesScanned).toBe(0);
  expect(checkEvent!.candidateSummaryHashes).toEqual([]);
});

// ---------------------------------------------------------------------------
// 8. Wrong thread/turn/model/reasoning — each rejected, each with correct reason
// ---------------------------------------------------------------------------
test("diagnostic: wrong thread rejected — accepted=false, rejectionReason=missing_checkpoint", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_scope_test", turnId: "turn_scope_test" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const wrongThread = { ...identity, threadId: "thread_wrong" };
  const continuation = parsedRequest({ input: v2Body(SUMMARY) });
  const accepted = isAcceptedCompactionContinuation(continuation, wrongThread, SOURCE);

  expect(accepted).toBe(false);
  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent!.accepted).toBe(false);
  // Wrong thread produces a different scope key → missing_checkpoint
  expect(checkEvent!.rejectionReason).toBe("missing_checkpoint");
  expect(checkEvent!.threadId).toBe("thread_wrong");
});

test("diagnostic: wrong turn rejected — accepted=false, rejectionReason=missing_checkpoint", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_scope_turn", turnId: "turn_scope_turn" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const wrongTurn = { ...identity, turnId: "turn_wrong" };
  const continuation = parsedRequest({ input: v2Body(SUMMARY) });
  const accepted = isAcceptedCompactionContinuation(continuation, wrongTurn, SOURCE);

  expect(accepted).toBe(false);
  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent!.accepted).toBe(false);
  expect(checkEvent!.rejectionReason).toBe("missing_checkpoint");
});

test("diagnostic: wrong model rejected — accepted=false, rejectionReason=missing_checkpoint", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_scope_model", turnId: "turn_scope_model" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const continuation = parsedRequest({ modelId: "gpt-5.6-other", input: v2Body(SUMMARY) });
  const accepted = isAcceptedCompactionContinuation(continuation, identity, SOURCE);

  expect(accepted).toBe(false);
  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent!.accepted).toBe(false);
  // Different model → different scope key → missing_checkpoint
  expect(checkEvent!.rejectionReason).toBe("missing_checkpoint");
  expect(checkEvent!.modelId).toBe("gpt-5.6-other");
});

test("diagnostic: wrong reasoning rejected — accepted=false, rejectionReason=missing_checkpoint", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_scope_reasoning", turnId: "turn_scope_reasoning" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const continuation = parsedRequest({ reasoning: "low", input: v2Body(SUMMARY) });
  const accepted = isAcceptedCompactionContinuation(continuation, identity, SOURCE);

  expect(accepted).toBe(false);
  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent!.accepted).toBe(false);
  expect(checkEvent!.rejectionReason).toBe("missing_checkpoint");
});

// ---------------------------------------------------------------------------
// checkpoint_remembered event fields
// ---------------------------------------------------------------------------
test("diagnostic: compaction_checkpoint_remembered event emitted with correct fields", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_chk_remembered", turnId: "turn_chk_remembered" };
  const source1 = { turnId: "turn_src_1", content: "Source task A." };
  const source2 = { turnId: "turn_src_2", content: "Source task B." };

  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [source1, source2], SUMMARY);

  const rememberedEvent = events.find(e => e.event === "compaction_checkpoint_remembered");
  expect(rememberedEvent).toBeDefined();
  expect(rememberedEvent!.threadId).toBe(identity.threadId);
  expect(rememberedEvent!.turnId).toBe(identity.turnId);
  expect(rememberedEvent!.modelId).toBe(MODEL);
  expect(rememberedEvent!.reasoning).toBe(REASONING);
  expect(rememberedEvent!.summaryHash).toBe(sha256(SUMMARY));
  expect(typeof rememberedEvent!.timestamp).toBe("string");
  expect(typeof rememberedEvent!.requestId).toBe("string");
  expect(typeof rememberedEvent!.checkpointId).toBe("string");
  expect(rememberedEvent!.sourceCount).toBe(2);
  expect(Array.isArray(rememberedEvent!.sourceHashes)).toBe(true);
  expect((rememberedEvent!.sourceHashes as string[]).length).toBe(2);
  expect(typeof rememberedEvent!.checkpointRegistrySize).toBe("number");

  // Privacy: no summary text, no source content
  const raw = JSON.stringify(rememberedEvent);
  expect(raw).not.toContain(SUMMARY);
  expect(raw).not.toContain("Source task");
});

// ---------------------------------------------------------------------------
// Privacy: continuation_checked event must not contain summary text
// ---------------------------------------------------------------------------
test("diagnostic: continuation_checked event contains no summary text or source content", () => {
  const { events, emitter } = captureEmitter();
  setCompactionDiagnosticsEmitter(emitter);

  const identity = { threadId: "thread_privacy", turnId: "turn_privacy" };
  const compactionParsed = parsedRequest({ compactionRequest: true });
  rememberCompactionContinuation(compactionParsed, identity, [SOURCE], SUMMARY);
  events.length = 0;

  const continuation = parsedRequest({ input: v2Body(SUMMARY) });
  isAcceptedCompactionContinuation(continuation, identity, SOURCE);

  const checkEvent = events.find(e => e.event === "compaction_continuation_checked");
  expect(checkEvent).toBeDefined();
  const raw = JSON.stringify(events);
  // No summary text
  expect(raw).not.toContain(SUMMARY.slice(0, 20));
  // No source content
  expect(raw).not.toContain("Implement the requested");
  // No SUMMARY_PREFIX prefix text
  expect(raw).not.toContain("Another language model");
});
