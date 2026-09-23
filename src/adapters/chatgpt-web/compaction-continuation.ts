import { createHash, randomUUID } from "node:crypto";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";

interface CompletedCheckpoint {
  checkpointId: string;
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
}

// Evidence of a checkpoint actually returned by this daemon, not authority inferred from text
// that happens to look like a summary. A new process must not invent a missing handoff.
const checkpoints = new Map<string, CompletedCheckpoint>();
const MAX_CHECKPOINTS = 256;
const diagnosticRequestIds = new WeakMap<CodexParsedRequest, string>();
const observedContinuationRequests = new WeakSet<CodexParsedRequest>();

// ---------------------------------------------------------------------------
// Diagnostic event infrastructure
// ---------------------------------------------------------------------------

/**
 * Structured reason for a rejected compaction continuation.
 * Each category maps to a distinct code branch; no category is manufactured speculatively.
 */
type CompactionRejectionReason =
  | "missing_scope"       // scope() returned undefined — native threadId/turnId missing
  | "missing_checkpoint"  // scope valid but no checkpoint in registry for this scope key
  | "source_mismatch"     // checkpoint found but sourceHashes.has(sourceDigest) is false
  | "input_missing"       // parsed._rawBody.input is absent or not an array
  | "summary_hash_mismatch" // one or more summary candidates were present but none matched
  | "no_matching_candidate"; // no structurally valid summary candidate was present

/**
 * Internal structured result of a continuation check. Not part of the public API.
 * Preserved only for diagnostic emission; callers outside this module see only boolean.
 */
interface CompactionContinuationResult {
  accepted: boolean;
  rejectionReason?: CompactionRejectionReason;
  checkpointFound: boolean;
  checkpointId?: string;
  checkpointSummaryHash?: string;
  sourceMatched: boolean;
  candidatesScanned: number;
  /** Set on the first candidate that was structurally recognized (regardless of hash outcome). */
  candidateType?: "readable_v1" | "readable_v2" | "structured_item";
  summaryHashMatched: boolean;
  candidateSummaryHashes: readonly string[];
  matchedSummaryHash?: string;
}

/**
 * Sink for structured compaction diagnostic events. Receives one JSON-serializable object per event.
 * The default implementation writes to stderr via console.warn, consistent with existing
 * [codex-chatgpt-web] diagnostic patterns in this process. Tests inject a capture sink.
 *
 * Privacy contract: emitted objects MUST NOT contain prompt text, summary text, auth tokens,
 * or cookies. Only hashes, counts, enum values, and identifiers are permitted.
 */
export type CompactionDiagnosticsEmitter = (event: Record<string, unknown>) => void;

const defaultEmitter: CompactionDiagnosticsEmitter = event => {
  try {
    console.warn(`[codex-chatgpt-web] ${JSON.stringify(event)}`);
  } catch {
    // Diagnostics are a side channel; failures must never surface to callers.
  }
};

let activeEmitter: CompactionDiagnosticsEmitter = defaultEmitter;

/**
 * Override the compaction diagnostics emitter. Intended for testing only.
 * Pass `undefined` to restore the default console.warn sink.
 */
export function setCompactionDiagnosticsEmitter(emitter: CompactionDiagnosticsEmitter | undefined): void {
  activeEmitter = emitter ?? defaultEmitter;
}

export function emitCompactionDiagnostic(event: Record<string, unknown>): void {
  try {
    activeEmitter({
      timestamp: new Date().toISOString(),
      ...event,
    });
  } catch {
    // Diagnostics are a side channel; failures must never surface to callers.
  }
}

export function compactionDiagnosticRequestId(parsed: CodexParsedRequest): string {
  const existing = diagnosticRequestIds.get(parsed);
  if (existing) return existing;
  const requestId = randomUUID();
  diagnosticRequestIds.set(parsed, requestId);
  return requestId;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  return JSON.stringify([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceDigest(source: ChatGptTurnUserRevision): string {
  return digest([source.turnId, source.content]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function rememberCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  sources: readonly ChatGptTurnUserRevision[],
  summary: string,
): void {
  const key = scope(parsed, identity);
  if (!key || !parsed._compactionRequest || !summary) return;
  const checkpointId = randomUUID();
  const summaryHash = digest(summary);
  const sourceHashes = new Set(sources.map(sourceDigest));
  checkpoints.delete(key);
  checkpoints.set(key, { checkpointId, summaryHash, sourceHashes });
  while (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
  emitCompactionDiagnostic({
    event: "compaction_checkpoint_remembered",
    requestId: compactionDiagnosticRequestId(parsed),
    checkpointId,
    threadId: identity.threadId,
    turnId: identity.turnId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning ?? null,
    summaryHash,
    sourceCount: sources.length,
    sourceHashes: [...sourceHashes],
    checkpointRegistrySize: checkpoints.size,
  });
}

/**
 * Internal implementation returning a structured diagnostic result.
 * Behavior is identical to the previous boolean implementation; only the return type changes.
 */
function checkCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): CompactionContinuationResult {
  const key = scope(parsed, identity);
  if (!key) {
    return { accepted: false, rejectionReason: "missing_scope", checkpointFound: false, sourceMatched: false, candidatesScanned: 0, summaryHashMatched: false, candidateSummaryHashes: [] };
  }
  const checkpoint = checkpoints.get(key);
  if (!checkpoint) {
    return { accepted: false, rejectionReason: "missing_checkpoint", checkpointFound: false, sourceMatched: false, candidatesScanned: 0, summaryHashMatched: false, candidateSummaryHashes: [] };
  }
  if (!checkpoint.sourceHashes.has(sourceDigest(source))) {
    return { accepted: false, rejectionReason: "source_mismatch", checkpointFound: true, checkpointId: checkpoint.checkpointId, checkpointSummaryHash: checkpoint.summaryHash, sourceMatched: false, candidatesScanned: 0, summaryHashMatched: false, candidateSummaryHashes: [] };
  }
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) {
    return { accepted: false, rejectionReason: "input_missing", checkpointFound: true, checkpointId: checkpoint.checkpointId, checkpointSummaryHash: checkpoint.summaryHash, sourceMatched: true, candidatesScanned: 0, summaryHashMatched: false, candidateSummaryHashes: [] };
  }
  let candidatesScanned = 0;
  let firstCandidateType: CompactionContinuationResult["candidateType"] | undefined;
  const candidateSummaryHashes: string[] = [];
  const rememberCandidateHash = (summaryText: string): string => {
    const hash = digest(summaryText);
    if (candidateSummaryHashes.length < 8) candidateSummaryHashes.push(hash);
    return hash;
  };
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
      const summaryText = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
      if (summaryText !== null) {
        candidatesScanned += 1;
        if (firstCandidateType === undefined) firstCandidateType = "structured_item";
        const candidateHash = rememberCandidateHash(summaryText);
        if (acceptsSummary(key, checkpoint, summaryText)) {
          return {
            accepted: true,
            checkpointFound: true,
            checkpointId: checkpoint.checkpointId,
            checkpointSummaryHash: checkpoint.summaryHash,
            sourceMatched: true,
            candidatesScanned,
            candidateType: "structured_item",
            summaryHashMatched: true,
            candidateSummaryHashes,
            matchedSummaryHash: candidateHash,
          };
        }
      }
    }
    if (item.role !== "user") continue;
    const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
      ? item.content.map(part => (part as { text?: unknown })?.text ?? "").join("\n") : "";
    if (isReadableCompactionSummaryText(text)) {
      const isV2 = text.startsWith(`${SUMMARY_PREFIX}\n\n`);
      const summaryText = isV2
        ? text.slice(SUMMARY_PREFIX.length + 2)
        : text.slice(SUMMARY_PREFIX.length + 1);
      candidatesScanned += 1;
      const thisType: CompactionContinuationResult["candidateType"] = isV2 ? "readable_v2" : "readable_v1";
      if (firstCandidateType === undefined) firstCandidateType = thisType;
      const candidateHash = rememberCandidateHash(summaryText);
      if (acceptsSummary(key, checkpoint, summaryText)) {
        return {
          accepted: true,
          checkpointFound: true,
          checkpointId: checkpoint.checkpointId,
          checkpointSummaryHash: checkpoint.summaryHash,
          sourceMatched: true,
          candidatesScanned,
          candidateType: thisType,
          summaryHashMatched: true,
          candidateSummaryHashes,
          matchedSummaryHash: candidateHash,
        };
      }
    }
  }
  return {
    accepted: false,
    rejectionReason: candidatesScanned > 0 ? "summary_hash_mismatch" : "no_matching_candidate",
    checkpointFound: true,
    checkpointId: checkpoint.checkpointId,
    checkpointSummaryHash: checkpoint.summaryHash,
    sourceMatched: true,
    candidatesScanned,
    ...(firstCandidateType !== undefined ? { candidateType: firstCandidateType } : {}),
    summaryHashMatched: false,
    candidateSummaryHashes,
  };
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  const requestId = compactionDiagnosticRequestId(parsed);
  if (!observedContinuationRequests.has(parsed)) {
    observedContinuationRequests.add(parsed);
    const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
    emitCompactionDiagnostic({
      event: "compaction_continuation_request_observed",
      requestId,
      threadId: identity.threadId ?? null,
      turnId: identity.turnId ?? null,
      modelId: parsed.modelId ?? null,
      reasoning: parsed.options.reasoning ?? null,
      inputItemCount: Array.isArray(input) ? input.length : null,
    });
  }
  const result = checkCompactionContinuation(parsed, identity, source);
  emitCompactionDiagnostic({
    event: "compaction_continuation_checked",
    requestId,
    threadId: identity.threadId ?? null,
    turnId: identity.turnId ?? null,
    modelId: parsed.modelId ?? null,
    reasoning: parsed.options.reasoning ?? null,
    checkpointFound: result.checkpointFound,
    ...(result.checkpointId !== undefined ? { checkpointId: result.checkpointId } : {}),
    ...(result.checkpointSummaryHash !== undefined ? { checkpointSummaryHash: result.checkpointSummaryHash } : {}),
    sourceMatched: result.sourceMatched,
    candidatesScanned: result.candidatesScanned,
    ...(result.candidateType !== undefined ? { candidateType: result.candidateType } : {}),
    summaryHashMatched: result.summaryHashMatched,
    candidateSummaryHashes: result.candidateSummaryHashes,
    candidateHashesTruncated: result.candidatesScanned > result.candidateSummaryHashes.length,
    ...(result.matchedSummaryHash !== undefined ? { matchedSummaryHash: result.matchedSummaryHash } : {}),
    accepted: result.accepted,
    ...(result.rejectionReason !== undefined ? { rejectionReason: result.rejectionReason } : {}),
  });
  return result.accepted;
}

function acceptsSummary(key: string, checkpoint: CompletedCheckpoint, summary: string): boolean {
  if (digest(summary) !== checkpoint.summaryHash) return false;
  // A long-running continuation does not become invalid merely because time passed. Keep the
  // bounded registry ordered by actual use instead of expiring a still-active native turn.
  checkpoints.delete(key);
  checkpoints.set(key, checkpoint);
  return true;
}
