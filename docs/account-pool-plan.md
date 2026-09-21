# Account Pool Plan

## Goal

Turn the existing Codex Web GPT launcher into one multi-instance manager while preserving the current production instance as the rollback baseline.

The target path is:

```text
Codex -> Cockpit -> Codex Web GPT instance pool -> ChatGPT Web
```

Cockpit remains the request router. The launcher manages instance lifecycle, login state, isolation, diagnostics, and Cockpit registration.

## Non-negotiable migration rules

- The existing production profile remains `primary` on port `17841`.
- Primary keeps its current `CODEX_CHATGPT_WEB_HOME` and browser partition so it does not require a fresh login.
- New instances get durable ports beginning at `17842`; ports do not reshuffle on restart.
- Every managed instance has a distinct core home, browser partition, response/runtime state, control token, broker endpoint, logs, and ownership marker.
- Cockpit-owned routing/provider state is not replaced by launcher-side round robin logic.
- Existing single-instance behavior remains usable until the multi-instance path passes live A/B validation.

## Target domain model

```text
Manager
  manager state
  selectedInstanceId
  Map<instanceId, ManagedInstance>

ManagedInstance
  registry metadata
  instance state store
  BrowserHost
  BrowserControlServer
  RuntimeSupervisor
  RuntimeHost
  health/activity
```

Registry metadata starts with:

```text
id
name
port
coreHome
browserPartition
enabled
createdAt
```

Manager state owns app-level preferences such as language, sidebar state, update preferences, and selected instance. Login/setup/runtime preferences move toward per-instance state as the lifecycle layer is introduced.

## Implementation phases

### 1. Registry and migration

Add a durable instance registry. On first launch, migrate the current launcher into a `primary` record without moving data. Add stable allocation for `instance-2`, `instance-3`, and later instances.

Acceptance:

- Primary remains `17841` with the exact current core home and browser partition.
- New records receive unique ports, homes, and partitions.
- Duplicate ownership is rejected instead of silently rewritten.
- Registry persists atomically and survives restart.

### 2. ManagedInstance lifecycle

Replace the launcher-wide runtime/browser singletons with a `ManagedInstance` owner and a manager map. Keep one Electron app and one single-instance lock.

Acceptance:

- Starting/stopping one managed instance does not change another instance's state.
- Primary behavior remains equivalent to the pre-manager launcher.
- Quit drains and shuts down every started instance deterministically.

### 3. Runtime and browser isolation

Make runtime environment injection instance-scoped. Descriptor records become instance-aware while retaining compatibility with the current primary descriptor during migration.

Acceptance:

- Each runtime receives its own `CODEX_CHATGPT_WEB_HOME`.
- Broker/socket, runtime state, browser descriptor, and control token do not collide.
- Browser cookies/storage are not visible across instances.
- Only the selected instance binds its browser surface into the visible viewport.

### 4. Cockpit pool adapter

Extend Cockpit sync from one bridge port to a list of managed Web GPT instances. Each enabled instance becomes one Cockpit account/backend for the same `chatgpt-web/high` catalog.

The adapter must mutate only Web GPT-owned Cockpit records and preserve native/OAuth accounts and user exclusions. Keep the current single-port sync entry point as a compatibility wrapper until migration is complete.

Acceptance:

- Cockpit sees `17841`, `17842`, ... as separate eligible accounts.
- Disabling/stopping an instance removes it from new routing without deleting unrelated Cockpit state.
- Same-thread/session affinity stays Cockpit-owned.

### 5. Instance-aware IPC

Move renderer contracts from one launcher snapshot to a manager snapshot:

```text
ManagerSnapshot
  managerState
  selectedInstanceId
  instances: InstanceSnapshot[]
```

Runtime/browser actions and events carry `instanceId`.

### 6. Manager UI

Use one operational UI, not separate launcher windows and not a card-heavy dashboard.

Default `Instances` view:

```text
STATUS  NAME       ACCOUNT     ENDPOINT   HEALTH   COCKPIT
ready   Primary    Signed in   :17841     Ready    Synced
ready   Work 2     Signed in   :17842     Busy     Synced
off     Work 3     Signed out  :17843     Stopped  Disabled

                                           + Add instance
```

Instance detail reuses the existing surfaces:

```text
Primary                                  Ready
127.0.0.1:17841                Stop  Restart  ...

Browser | Setup | Diagnostics | Settings
```

Global navigation becomes `Instances`, `Activity`, and `Settings`. Activity aggregates all instances with an instance filter. Instance setup owns login, browser/session status, MCP/runtime setup, and per-instance diagnostics.

`Add instance` flow:

1. Allocate durable id/name/port.
2. Create isolated home and browser partition.
3. Start the instance browser profile.
4. Login the account.
5. Run smoke/health validation.
6. Register the instance in Cockpit.

Paths and ports remain hidden under Advanced unless the user needs them.

### 7. Drain and deletion semantics

Stop/restart/delete uses `disable -> drain active turns -> stop runtime`. Do not migrate an in-flight conversation between accounts. Deleting an instance removes only the Cockpit record owned by that instance and asks separately whether durable profile data should be retained.

### 8. Live validation and benchmark

First live expansion is exactly one new instance on `17842`.

Required validation:

1. Primary resumes without a new login.
2. A/B cookies and storage are isolated.
3. Two runtimes operate concurrently without broker/state collision.
4. Cockpit exposes both Web GPT accounts for `chatgpt-web/high`.
5. Independent threads can run concurrently across the two instances.
6. Same thread keeps affinity.
7. Subagents can occupy different instances.
8. Restarting instance B does not interrupt A.
9. Stopped/disabled B receives no new turns.
10. Resume, compaction, and tool loops continue to pass.
11. Packaged Windows restart/smoke passes.
12. Benchmark 1 vs 2 vs 3 instances before claiming a throughput gain.

## Commit sequence

1. `instance registry + primary migration`
2. `ManagedInstance lifecycle`
3. `browser descriptor and partition isolation`
4. `instance-scoped runtime env/state`
5. `Cockpit pool adapter`
6. `instance-aware IPC/types`
7. `manager UI`
8. `migration/lifecycle regression tests`
9. `live A/B validation`
10. `package smoke and docs`

The key rollback invariant is that `primary` continues to represent the existing `17841` setup until the new pool has passed live validation.
