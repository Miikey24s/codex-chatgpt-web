import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** In-memory high-water byte cap across all entries. Forced store:false continuation chains
 * store the full expanded input each turn — ~quadratic bytes per chain —
 * so a count cap alone cannot bound memory. Oldest-first eviction applies past this mark. */
const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;

interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  /** Trusted Codex thread owner captured when this response was produced. */
  threadId?: string;
  /** Approximate in-memory size, computed locally at insert time (never trusted from disk). */
  sizeBytes?: number;
}

const states = new Map<string, StoredResponseState>();
const latestResponseIdByThread = new Map<string, string>();
let storedResponseBytes = 0;

function refreshLatestThreadResponse(threadId: string): void {
  latestResponseIdByThread.delete(threadId);
  for (const [id, state] of [...states].reverse()) {
    if (state.threadId === threadId) {
      latestResponseIdByThread.set(threadId, id);
      return;
    }
  }
}

/** The ONLY size computation: approximate entry weight from its items payload. */
function measuredEntry(entry: Omit<StoredResponseState, "sizeBytes">): StoredResponseState {
  let sizeBytes = 0;
  try {
    sizeBytes = JSON.stringify(entry.items).length;
  } catch {
    /* unserializable items: weightless rather than fatal */
  }
  return { ...entry, sizeBytes };
}

/** The ONLY insertion point: keeps the byte counter consistent on replacement. */
function setEntry(id: string, entry: Omit<StoredResponseState, "sizeBytes">): void {
  deleteEntry(id);
  const measured = measuredEntry(entry);
  storedResponseBytes += measured.sizeBytes ?? 0;
  states.set(id, measured);
  if (measured.threadId) latestResponseIdByThread.set(measured.threadId, id);
}

/** The ONLY deletion point: TTL, count, byte, and explicit deletes all route here. */
function deleteEntry(id: string): void {
  const existing = states.get(id);
  if (!existing) return;
  storedResponseBytes -= existing.sizeBytes ?? 0;
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  states.delete(id);
  if (existing.threadId && latestResponseIdByThread.get(existing.threadId) === id) {
    refreshLatestThreadResponse(existing.threadId);
  }
}
// Expansion provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. Consumers use the prefix length to bind trusted history and rolling checkpoints to the
// exact replayed portion of this request.
const replayedInputPrefixLengths = new WeakMap<object, number>();
const replayedThreadOwners = new WeakMap<object, string>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

/**
 * Best-effort disk snapshot so previous_response_id chains survive a proxy restart (the
 * dominant expansion-miss cause: an in-memory-only store dies with the process, and the next
 * chained turn then reaches the upstream as a naked delta). Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const path = snapshotPath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.states)) return;
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, state] = entry as [unknown, unknown];
      if (typeof id !== "string" || !state || typeof state !== "object") continue;
      const rec = state as StoredResponseState;
      if (typeof rec.createdAt !== "number" || !Array.isArray(rec.items)) continue;
      // Recompute sizes locally while loading; persisted sizeBytes is never trusted.
      setEntry(id, {
        createdAt: rec.createdAt,
        items: rec.items,
        ...(typeof rec.threadId === "string" && rec.threadId ? { threadId: rec.threadId } : {}),
      });
    }
    pruneResponses();
  } catch {
    /* missing/corrupt snapshot: start empty */
  }
}

function persistNow(path: string): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  try {
    const entries: [string, StoredResponseState][] = [];
    let total = 0;
    // Newest-first so the most recent chains survive both caps.
    for (const entry of [...states].reverse()) {
      // sizeBytes is in-memory accounting only; keep it out of the disk snapshot.
      const [id, state] = entry;
      const { sizeBytes: _sizeBytes, ...persistable } = state;
      const persistEntry: [string, StoredResponseState] = [id, persistable];
      const size = JSON.stringify(persistEntry).length;
      if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
      if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
      total += size;
      entries.push(persistEntry);
    }
    entries.reverse();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies on creation — re-harden an existing config dir so the
    // conversation-content snapshot never lands in a group/world-readable directory.
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    atomicWriteFile(path, JSON.stringify({ version: 1, states: entries }));
  } catch {
    /* best-effort: disk trouble must never affect request handling */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  // Resolve the target path now: tests may swap CODEX_CHATGPT_WEB_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  pendingPersistPath = snapshotPath();
  const path = pendingPersistPath;
  persistTimer = setTimeout(() => persistNow(path), SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export function flushResponseState(): void {
  if (!persistTimer) return;
  // Use the path captured when the write was scheduled; CODEX_CHATGPT_WEB_HOME may have moved.
  persistNow(pendingPersistPath ?? snapshotPath());
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(at = now()): void {
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS) deleteEntry(id);
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
  // Byte high-water eviction, oldest-first (Map preserves insertion order).
  while (storedResponseBytes > MAX_STORED_RESPONSE_BYTES && states.size > 1) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) return body;
  const expanded = {
    ...request,
    input: [...previous.items, ...inputItems(request.input)],
  };
  replayedInputPrefixLengths.set(expanded, previous.items.length);
  if (previous.threadId) replayedThreadOwners.set(expanded, previous.threadId);
  return expanded;
}

function itemIds(items: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = (item as Record<string, unknown>).id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

/**
 * Cockpit Local Access currently drops previous_response_id while preserving prompt_cache_key and
 * native Codex turn metadata. In provider-only mode the server may therefore replay the newest
 * response owned by that exact thread. The prompt-cache/thread equality is the routing fence, and
 * any repeated item id means the caller already supplied history (retry/full replay), so we leave
 * that request untouched instead of duplicating context.
 */
export function expandLatestThreadResponseInput(body: unknown, threadId: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body) || !threadId) return body;
  const request = body as Record<string, unknown>;
  if (request.previous_response_id !== undefined || request.prompt_cache_key !== threadId) return body;
  ensureLoaded();
  pruneResponses();
  const previousId = latestResponseIdByThread.get(threadId);
  if (!previousId) return body;
  const previous = states.get(previousId);
  if (!previous || previous.threadId !== threadId) return body;

  const incoming = inputItems(request.input);
  const previousIds = itemIds(previous.items);
  if (incoming.some(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const id = (item as Record<string, unknown>).id;
    return typeof id === "string" && previousIds.has(id);
  })) return body;

  const expanded = {
    ...request,
    input: [...previous.items, ...incoming],
  };
  replayedInputPrefixLengths.set(expanded, previous.items.length);
  replayedThreadOwners.set(expanded, threadId);
  return expanded;
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

/** Trusted thread owner carried only through the proxy-private previous-response cache. */
export function previousResponseReplayThreadId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return replayedThreadOwners.get(body);
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown },
  opts?: { force?: boolean; threadId?: string },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store stays in-memory with a 1h TTL, so this is a proxy-internal continuation cache, not
  // real server-side response storage.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  setEntry(response.id, {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
    ...(opts?.threadId ? { threadId: opts.threadId } : {}),
  });
  pruneResponses();
  schedulePersist();
}
