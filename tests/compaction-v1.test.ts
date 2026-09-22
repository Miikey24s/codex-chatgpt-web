import { expect, test } from "bun:test";
import {
  buildCompactV1Output,
  extractCompactUserMessages,
  isReadableCompactionSummaryText,
  SUMMARY_PREFIX,
} from "../src/responses/compaction";
import {
  isAcceptedCompactionContinuation,
  rememberCompactionContinuation,
} from "../src/adapters/chatgpt-web/compaction-continuation";
import type { CodexParsedRequest } from "../src/types";

test("recognizes both Codex v1 and transparent v2 readable compaction summaries", () => {
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\nv1 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\n\nv2 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}not a summary boundary`)).toBe(false);
});

test("v1 compaction keeps only the newest ten structured images without copying them into text", () => {
  const input = Array.from({ length: 12 }, (_, index) => ({
    type: "message",
    role: "user",
    id: `user-${index}`,
    metadata: { source: `turn-${index}` },
    content: [
      { type: "input_text", text: `request-${index}` },
      {
        type: "input_image",
        image_url: `data:image/png;base64,image-${index}`,
        detail: "high",
      },
    ],
  }));

  const output = buildCompactV1Output(extractCompactUserMessages(input), "checkpoint");
  const retained = output.slice(0, -1) as Array<{
    id?: string;
    metadata?: { source?: string };
    content: Array<{ type: string; text?: string; image_url?: string; detail?: string }>;
  }>;
  expect(retained).toHaveLength(12);
  expect(retained.map(item => item.id)).toEqual(input.map(item => item.id));
  expect(retained.map(item => item.metadata?.source)).toEqual(input.map(item => item.metadata.source));
  const imageUrls = retained.flatMap(item => item.content
    .filter(block => block.type === "input_image")
    .map(block => block.image_url));
  expect(imageUrls).toEqual(input.slice(2).map(item => item.content[1]!.image_url));
  expect(retained.flatMap(item => item.content)
    .filter(block => block.type === "input_text")
    .every(block => !block.text?.includes("data:image"))).toBe(true);
  expect(retained.at(-1)?.content.at(-1)).toMatchObject({ detail: "high" });
});

test("v1 compaction drops persisted one-pixel image sentinels", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const output = buildCompactV1Output(extractCompactUserMessages([{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "keep the request" },
      { type: "input_image", image_url: placeholder },
      { type: "input_image", image_url: "data:image/png;base64,real-image" },
    ],
  }]), "checkpoint");

  expect(JSON.stringify(output)).not.toContain(placeholder);
  expect(JSON.stringify(output)).toContain("data:image/png;base64,real-image");
});

test("accepts compaction continuation in both single-newline v1 and double-newline v2 format", () => {
  const summary = "Verified working directory and completed unit test suite.";
  const parsed = {
    modelId: "gpt-5.6-sol",
    options: { reasoning: "high" },
    _compactionRequest: true,
    _rawBody: { input: [] },
  } as unknown as CodexParsedRequest;
  const identity = { threadId: "thread_test_cont", turnId: "turn_test_cont" };
  const source = { turnId: "turn_source_0", content: "Original task prompt" };

  rememberCompactionContinuation(parsed, identity, [source], summary);

  const continuationV1 = {
    ...parsed,
    _compactionRequest: false,
    _rawBody: {
      input: [
        { role: "user", content: `${SUMMARY_PREFIX}\n${summary}` },
      ],
    },
  } as unknown as CodexParsedRequest;
  expect(isAcceptedCompactionContinuation(continuationV1, identity, source)).toBe(true);

  const continuationV2 = {
    ...parsed,
    _compactionRequest: false,
    _rawBody: {
      input: [
        { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary}` },
      ],
    },
  } as unknown as CodexParsedRequest;
  expect(isAcceptedCompactionContinuation(continuationV2, identity, source)).toBe(true);

  // Summary hash mismatch is rejected
  const alteredSummary = {
    ...continuationV2,
    _rawBody: {
      input: [{ role: "user", content: `${SUMMARY_PREFIX}\n\nAltered summary content` }],
    },
  } as unknown as CodexParsedRequest;
  expect(isAcceptedCompactionContinuation(alteredSummary, identity, source)).toBe(false);

  // Source revision mismatch is rejected
  const alteredSourceContent = { turnId: "turn_source_0", content: "Tampered source prompt" };
  expect(isAcceptedCompactionContinuation(continuationV2, identity, alteredSourceContent)).toBe(false);

  const alteredSourceTurn = { turnId: "turn_source_tampered", content: "Original task prompt" };
  expect(isAcceptedCompactionContinuation(continuationV2, identity, alteredSourceTurn)).toBe(false);

  // Scope mismatch (thread, turn, model, reasoning) fails closed
  expect(isAcceptedCompactionContinuation(continuationV2, { ...identity, threadId: "thread_tampered" }, source)).toBe(false);
  expect(isAcceptedCompactionContinuation(continuationV2, { ...identity, turnId: "turn_tampered" }, source)).toBe(false);
  expect(isAcceptedCompactionContinuation({ ...continuationV2, modelId: "gpt-5.6-other" } as unknown as CodexParsedRequest, identity, source)).toBe(false);
  expect(isAcceptedCompactionContinuation({ ...continuationV2, options: { reasoning: "low" } } as unknown as CodexParsedRequest, identity, source)).toBe(false);

  // Candidate scanning does not terminate early on non-matching candidates
  const candidateBeforeValid = {
    ...continuationV2,
    _rawBody: {
      input: [
        { role: "user", content: `${SUMMARY_PREFIX}\n\nStale summary from previous turn` },
        { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary}` },
      ],
    },
  } as unknown as CodexParsedRequest;
  expect(isAcceptedCompactionContinuation(candidateBeforeValid, identity, source)).toBe(true);

  const candidateAfterValid = {
    ...continuationV2,
    _rawBody: {
      input: [
        { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary}` },
        { role: "user", content: `${SUMMARY_PREFIX}\n\nStale summary from previous turn` },
      ],
    },
  } as unknown as CodexParsedRequest;
  expect(isAcceptedCompactionContinuation(candidateAfterValid, identity, source)).toBe(true);
});
