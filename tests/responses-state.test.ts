import { describe, expect, test } from "bun:test";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { parseRequest } from "../src/responses/parser";
import {
  expandLatestThreadResponseInput,
  expandPreviousResponseInput,
  previousResponseReplayThreadId,
  rememberResponseState,
} from "../src/responses/state";

describe("previous response trusted owner", () => {
  test("replays the latest response for the same Cockpit thread when previous_response_id was stripped", () => {
    const responseId = `resp_cockpit_${crypto.randomUUID()}`;
    const threadId = `thread_${crypto.randomUUID()}`;
    const firstItemId = `msg_${crypto.randomUUID()}`;
    rememberResponseState(
      {
        model: "chatgpt-web/high",
        prompt_cache_key: threadId,
        input: [{ type: "message", id: firstItemId, role: "user", content: "first" }],
      },
      {
        id: responseId,
        status: "completed",
        output: [{ type: "message", id: `msg_${crypto.randomUUID()}`, role: "assistant", content: "done" }],
      },
      { force: true, threadId },
    );

    const expanded = expandLatestThreadResponseInput({
      model: "chatgpt-web/high",
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: `turn_${crypto.randomUUID()}` }),
      },
      input: [{ type: "message", id: `msg_${crypto.randomUUID()}`, role: "user", content: "second" }],
    }, threadId);

    expect(previousResponseReplayThreadId(expanded)).toBe(threadId);
    const parsed = parseRequest(expanded);
    expect(parsed._replayPrefixLen).toBe(2);
    expect(parsed._replayThreadId).toBe(threadId);
    expect(extractChatGptTurnIdentity(parsed).threadId).toBe(threadId);
  });

  test("does not replay Cockpit fallback history across prompt-cache or duplicate-history boundaries", () => {
    const responseId = `resp_cockpit_fence_${crypto.randomUUID()}`;
    const threadId = `thread_${crypto.randomUUID()}`;
    const firstItemId = `msg_${crypto.randomUUID()}`;
    rememberResponseState(
      {
        model: "chatgpt-web/high",
        prompt_cache_key: threadId,
        input: [{ type: "message", id: firstItemId, role: "user", content: "first" }],
      },
      {
        id: responseId,
        status: "completed",
        output: [{ type: "message", id: `msg_${crypto.randomUUID()}`, role: "assistant", content: "done" }],
      },
      { force: true, threadId },
    );

    const wrongPromptCache = {
      model: "chatgpt-web/high",
      prompt_cache_key: `other_${crypto.randomUUID()}`,
      input: [{ type: "message", id: `msg_${crypto.randomUUID()}`, role: "user", content: "second" }],
    };
    expect(expandLatestThreadResponseInput(wrongPromptCache, threadId)).toBe(wrongPromptCache);

    const alreadyReplayed = {
      model: "chatgpt-web/high",
      prompt_cache_key: threadId,
      input: [{ type: "message", id: firstItemId, role: "user", content: "first" }],
    };
    expect(expandLatestThreadResponseInput(alreadyReplayed, threadId)).toBe(alreadyReplayed);
  });

  test("carries the verified Codex thread owner through a synthetic reconnect", () => {
    const responseId = `resp_owner_${crypto.randomUUID()}`;
    const threadId = `thread_${crypto.randomUUID()}`;
    rememberResponseState(
      { model: "chatgpt-web/high", input: [{ type: "message", role: "user", content: "first" }] },
      {
        id: responseId,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: "done" }],
      },
      { force: true, threadId },
    );

    const expanded = expandPreviousResponseInput({
      model: "chatgpt-web/high",
      previous_response_id: responseId,
      input: [],
    });
    expect(previousResponseReplayThreadId(expanded)).toBe(threadId);

    const parsed = parseRequest(expanded);
    expect(parsed._replayThreadId).toBe(threadId);
    expect(extractChatGptTurnIdentity(parsed).threadId).toBe(threadId);
  });

  test("rejects native metadata that conflicts with the cached response owner", () => {
    const parsed = parseRequest({ model: "chatgpt-web/high", input: [] });
    parsed._replayThreadId = "thread_trusted";
    parsed._rawBody = {
      model: "chatgpt-web/high",
      input: [],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_other", turn_id: "turn_new" }),
      },
    };

    expect(() => extractChatGptTurnIdentity(parsed)).toThrow("thread owner conflicts");
  });

  test("reuses the trusted cwd when a reconnect carries no new Codex environment", () => {
    const cwd = process.cwd();
    const threadId = `thread_${crypto.randomUUID()}`;
    const turnId = `turn_${crypto.randomUUID()}`;
    const responseId = `resp_${crypto.randomUUID()}`;
    const environment = `<environment_context>\n  <cwd>${cwd}</cwd>\n  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
    const metadata = JSON.stringify({ thread_id: threadId, turn_id: turnId });
    const raw = {
      model: "chatgpt-web/high",
      client_metadata: { "x-codex-turn-metadata": metadata },
      input: [
        {
          type: "message",
          role: "user",
          id: "msg_environment",
          content: [{ type: "input_text", text: environment }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message",
          role: "user",
          id: "msg_user",
          content: [{ type: "input_text", text: "first" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };
    const store = new ChatGptThreadEnvironmentStore();
    expect(store.resolve(parseRequest(raw)).cwd).toBe(cwd);
    rememberResponseState(
      raw,
      { id: responseId, status: "completed", output: [{ type: "message", role: "assistant", content: "done" }] },
      { force: true, threadId },
    );

    const expanded = expandPreviousResponseInput({
      model: "chatgpt-web/high",
      previous_response_id: responseId,
      input: [],
    });
    const reconnect = parseRequest(expanded);
    expect(reconnect._replayPrefixLen).toBeGreaterThan(0);
    expect(extractChatGptTurnIdentity(reconnect).threadId).toBe(threadId);
    expect(store.resolve(reconnect).cwd).toBe(cwd);
  });

  test("recovers a legacy reconnect without a cached thread owner only from one trusted authority", () => {
    const cwd = process.cwd();
    const visualizationRoot = `${cwd}\\visualizations\\thread_legacy_unique`;
    const threadId = `thread_${crypto.randomUUID()}`;
    const turnId = `turn_${crypto.randomUUID()}`;
    const environment = `<environment_context>\n  <cwd>${cwd}</cwd>\n  <filesystem><workspace_roots><root>${cwd}</root><root>${visualizationRoot}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
    const raw = {
      model: "chatgpt-web/high",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
      input: [
        {
          type: "message",
          role: "user",
          id: "msg_environment",
          content: [{ type: "input_text", text: environment }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message",
          role: "user",
          id: "msg_user",
          content: [{ type: "input_text", text: "first" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };
    const store = new ChatGptThreadEnvironmentStore();
    expect(store.resolve(parseRequest(raw)).cwd).toBe(cwd);

    const responseId = `resp_legacy_${crypto.randomUUID()}`;
    rememberResponseState(
      raw,
      { id: responseId, status: "completed", output: [{ type: "message", role: "assistant", content: "done" }] },
      { force: true },
    );
    const reconnect = parseRequest(expandPreviousResponseInput({
      model: "chatgpt-web/high",
      previous_response_id: responseId,
      input: [],
    }));

    expect(extractChatGptTurnIdentity(reconnect).threadId).toBeUndefined();
    expect(store.resolve(reconnect).cwd).toBe(cwd);
  });

  test("legacy replay recovery stays fail-closed when authority is ambiguous", () => {
    const cwd = process.cwd();
    const environment = `<environment_context>\n  <cwd>${cwd}</cwd>\n  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`;
    const store = new ChatGptThreadEnvironmentStore();
    for (const threadId of ["thread_legacy_one", "thread_legacy_two"]) {
      const raw = {
        model: "chatgpt-web/high",
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: `turn_${threadId}` }) },
        input: [
          {
            type: "message",
            role: "user",
            id: `env_${threadId}`,
            content: [{ type: "input_text", text: environment }],
            internal_chat_message_metadata_passthrough: { turn_id: `turn_${threadId}` },
          },
          {
            type: "message",
            role: "user",
            id: `user_${threadId}`,
            content: [{ type: "input_text", text: "first" }],
            internal_chat_message_metadata_passthrough: { turn_id: `turn_${threadId}` },
          },
        ],
      };
      expect(store.resolve(parseRequest(raw)).cwd).toBe(cwd);
    }

    const responseId = `resp_legacy_ambiguous_${crypto.randomUUID()}`;
    rememberResponseState(
      { model: "chatgpt-web/high", input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: environment }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      ] },
      { id: responseId, status: "completed", output: [{ type: "message", role: "assistant", content: "done" }] },
      { force: true },
    );
    const reconnect = parseRequest(expandPreviousResponseInput({
      model: "chatgpt-web/high",
      previous_response_id: responseId,
      input: [],
    }));

    expect(() => store.resolve(reconnect)).toThrow("missing cwd");
  });
});
