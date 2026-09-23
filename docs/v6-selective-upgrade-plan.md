# v6 Selective Upgrade Plan

## Goal

Upgrade the custom Cockpit-first Codex Web GPT branch to the useful runtime behavior from upstream `v6.0.0` while preserving the existing custom architecture and keeping the currently running Codex Web GPT session alive until the user manually restarts it.

Target architecture remains:

```text
Codex
  -> Cockpit
    -> managed Codex Web GPT account pool
      -> isolated browser worker per instance
        -> ChatGPT Web
```

Cockpit remains the router. Codex Web GPT remains the browser transport/provider. Multi-instance isolation, provider-only behavior, subagents V1/V2, custom compaction continuation, and queued native-turn lifecycle remain owned by this branch.

Pre-upgrade concurrency baseline: preserve `10` simultaneous browser turns per managed instance. The limit is per instance, not global, so two enabled instances can expose up to `20` concurrent browser-turn slots in aggregate. Upstream v6 changes must not silently restore the old five-turn cap in the worker, turn-session broker, or Electron browser host.

## Final product decisions

| v6 area | Decision | Notes |
| --- | --- | --- |
| Browser reliability/recovery | Adopt | Port behavior and tests selectively. |
| Cooldown handling | Adopt | Do not retry account cooldowns blindly. |
| Accepted-generation resubmit protection | Adopt | Avoid duplicate submissions. |
| Trusted workspace/environment recovery | Adopt | Preserve current ownership boundaries. |
| Markdown/response parsing fixes | Adopt | Port with regression coverage. |
| Bigger Context six-part transport | Adopt | Preserve current context/compaction budgets. |
| v6 model family selection/verification | Adopt | Verify family and effort before submission. |
| GPT-5.6 Luna | Adopt | Expose through the v6-style catalog. |
| GPT-5.6 Sol Instant | Adopt | Expose through the v6-style catalog. |
| GPT-5.6 Sol | Adopt | Expose supported native efforts. |
| GPT-5.6 Pro | Adopt engine/catalog support | User currently uses Plus, so availability is account-dependent. |
| GPT-6 Pro | Adopt engine/catalog support | User currently uses Plus, so availability is account-dependent. |
| Legacy `chatgpt-web/*` identities | Preserve | Existing saved config/calls must continue resolving. |
| Compaction/continuation fixes | Reconcile | Never overwrite custom implementation wholesale. |
| Native turn lifecycle fixes | Reconcile | Preserve custom queued-turn behavior. |
| Subagents Native V1/V2 | Preserve and update | Make model/effort handling v6-aware. |
| Cockpit model catalog | Move to v6-style catalog | User will adjust Cockpit presentation/routing later if desired. |
| Multi-account/multi-instance pool | Preserve | Accounts are Plus-focused; keep isolation and pool routing. |
| Fresh Chat each turn | Do not adopt | Explicit user decision. |
| Save chats in ChatGPT | Do not adopt | Explicit user decision; keep Temporary Chat behavior. |
| Pro Limits/quota tracking | Do not adopt | User does not use Pro accounts. |
| Pro $100/$200 plan logic | Do not adopt | Out of scope. |
| Staged updater / upstream auto-update | Do not adopt | Must not replace custom runtime automatically. |
| Linux ARM64/libnotify work | Do not adopt | Windows-focused deployment. |
| Upstream logo-only changes | Do not adopt | Cosmetic and unnecessary. |
| Upstream launcher rewrite wholesale | Do not adopt | Conflicts with custom multi-instance ownership. |

## Non-negotiable migration rules

- Do not merge or cherry-pick upstream `v6.0.0` wholesale.
- Do not run the upstream v6 installer or updater over the custom installation.
- Preserve Cockpit-first routing and Cockpit ownership of account selection/session affinity.
- Preserve provider-only environment restrictions for automatic Web GPT turns.
- Preserve the current multi-instance registry, stable ports, homes, partitions, control tokens, runtime state, and ownership markers.
- Preserve Native Subagents V1 compatibility and Native V2 toggle behavior.
- Preserve custom compaction continuation and queued native-turn lifecycle unless a specific upstream behavior is proven to supersede it.
- Do not touch unrelated untracked test/output files.
- Do not restart, stop, reload, or replace the currently running Codex Web GPT launcher/runtime during implementation or validation.
- Source, tests, and build artifacts may be updated on disk. Loading the new runtime is a separate manual user action after completion.

## Phase 0: Baseline and conflict map

Before edits:

1. Record branch, `git status`, remotes, current HEAD, upstream `v6.0.0`, and the exact merge base.
2. Reconfirm custom changes since the v5.0.8 baseline.
3. Produce a changed-file intersection between custom HEAD and upstream v6.
4. Recheck virtual-merge conflicts, especially:
   - launcher runtime/main/preload files
   - browser worker
   - model catalog
   - environment/trust handling
   - compaction continuation
   - server/parser paths
   - tests covering those paths
5. Tag each upstream hunk as `adopt`, `reconcile`, or `skip` before modifying code.

Acceptance:

- No repository files changed during the inventory step.
- Existing untracked files remain untouched.
- Every high-conflict ownership area has an explicit migration decision.

## Phase 1: v6 model definitions and compatibility layer

Port the upstream v6 model definitions and model-family metadata needed by the browser/runtime without removing legacy identities.

Target visible model families:

```text
GPT-5.6 Luna (Web)
GPT-5.6 Sol Instant (Web)
GPT-5.6 Sol (Web)
GPT-5.6 Pro (Web)
GPT-6 Pro (Web)
```

Target effort support follows upstream v6 semantics:

```text
Luna        -> low, medium
Sol Instant -> low
Sol         -> medium, high, xhigh
Pro         -> max
GPT-6 Pro   -> max
```

Implementation requirements:

- Add/port the v6 model family and effort types.
- Keep legacy `chatgpt-web/light`, `medium`, `high`, `extra-high`, `pro`, and any custom aliases resolvable.
- Separate browser model family selection from reasoning effort selection.
- Do not let a legacy identity silently map to a different historical mode.
- Keep provider-only route semantics unchanged.
- Avoid exposing impossible effort/model pairs.

Acceptance:

- New v6 model identities resolve correctly.
- Legacy identities still resolve.
- Invalid family/effort combinations fail before browser submission.
- Existing custom subagent compatibility tests still pass before subagent-specific changes begin.

## Phase 2: Browser model selection and submission reliability

Port the useful v6 browser selection/recovery behavior into the current custom worker instead of replacing the worker file.

Required behavior:

1. Detect the requested model family.
2. Select the correct ChatGPT model control.
3. Set the requested supported effort.
4. Verify model family, radio/selector state, slider/effort state, and relevant accessibility description before send.
5. Fail with a precise diagnostic if the UI cannot prove the intended state.
6. Do not blindly resubmit a prompt once ChatGPT has accepted generation.
7. Treat account cooldown separately from transient browser/network recovery.
8. Preserve same-turn steering behavior where already supported.
9. Preserve current browser partition and managed-instance ownership.

Also reconcile upstream improvements for:

- sign-in navigation
- tab closure/navigation races
- browser submission recovery
- account-aware effort selection
- family verification
- owned HTTP 413 classification
- clearer diagnostics

Acceptance:

- Worker proves model + effort before sending.
- Duplicate prompt submission is prevented in accepted-generation recovery cases.
- Cooldown errors do not enter inappropriate retry loops.
- Managed instances remain isolated.
- Provider-only turns do not gain trusted local environment access.

## Phase 3: Bigger Context six-part transport

Port upstream six-part large-context transport while preserving the existing total context and compaction budgets.

Required invariants:

- Small requests continue using the shorter one/two-part path when appropriate.
- Large requests may use up to six ordered context parts.
- Whole logical records stay intact; avoid arbitrary record splitting.
- Tool declarations and attachments remain final-part-only where upstream requires it.
- The selected execution model remains stable across all parts.
- ACKs remain transaction-bound and ordered.
- Only the final part starts the actual task turn.
- Existing advertised context/compaction multipliers are not silently changed.

Acceptance:

- Ordering tests cover all six parts.
- Missing, duplicate, stale, or out-of-order ACKs fail deterministically.
- Large context succeeds without changing the user-facing context budget.
- Existing smaller-context tests remain unchanged in behavior.

## Phase 4: Compaction and continuation reconciliation

This is a conflict-heavy ownership area. Compare custom behavior and upstream v6 behavior function-by-function and test-by-test.

Do not replace custom compaction files wholesale.

Reconcile:

- compaction continuation handoff
- new context epoch creation
- browser recovery after compaction
- native responses/memento compaction precision
- continuation state ownership
- upstream failure details and diagnostic propagation
- queued native-turn interaction with compaction
- stale/superseded temporary-chat navigation handling

Required custom behavior to preserve:

- current compaction continuation handoff fixes
- queued native-turn lifecycle fixes
- custom diagnostic instrumentation where still useful
- deterministic ownership of the continuation turn

Acceptance:

- Existing custom compaction tests pass.
- Relevant upstream v6 compaction regressions are ported and pass.
- No duplicate continuation is created.
- Failure details survive from the browser/native layer to the caller.
- Queued native turns do not become orphaned across compaction.

## Phase 5: Subagents Native V1/V2

Make the existing subagent system consume the new v6 model catalog without changing its ownership model.

Preserve:

- Native V1 compatibility behavior
- Native V2 toggle and status behavior
- current bounded `spawn_agent` registry semantics
- root/delegated priority behavior
- current native-template `multi_agent_version` inheritance logic

Update:

- model identity normalization for v6 families
- supported effort discovery
- delegated-model validation
- root-agent model validation
- model catalog serialization/deserialization where necessary
- tests for V1 and V2 using v6-era model rows

Important rule:

Do not allow Luna, Sol Instant, Pro, or GPT-6 catalog additions to accidentally evict or reorder delegated models merely because the catalog grew. Explicit subagent priority/compatibility rules must remain intentional.

Acceptance:

- V1 behavior remains backward compatible.
- V2 toggle still changes only the intended protocol behavior.
- Root and delegated models validate independently.
- Unsupported model/effort pairs are rejected before spawning.
- Model catalog growth does not silently alter bounded registry semantics.

## Phase 6: Cockpit catalog integration

Move the Web GPT provider catalog from the current single `chatgpt-web/high` exposure toward the v6-style model set selected by the user.

Backend target:

```text
GPT-5.6 Luna
GPT-5.6 Sol Instant
GPT-5.6 Sol
GPT-5.6 Pro
GPT-6 Pro
```

Requirements:

- Preserve Cockpit ownership of provider routing and account selection.
- Preserve native/OAuth provider records and user exclusions.
- Preserve Web GPT provider deduplication.
- Synchronize the same catalog shape for all eligible managed Web GPT instances.
- Keep compatibility aliases available where existing sessions/configuration need them.
- Do not introduce Pro quota tracking.
- Keep account capability failures explicit; catalog support does not imply a Plus account can actually use every Pro model.

The user may make additional Cockpit-side presentation/routing adjustments after this backend update.

Acceptance:

- Cockpit sync advertises the intended v6-era models/efforts.
- Multi-instance providers do not duplicate API keys or overwrite unrelated Cockpit providers.
- Legacy routes continue resolving during migration.
- A model unavailable to the signed-in account fails as an account/model capability issue, not as an unrelated transport error.

## Phase 7: Multi-account and multi-instance regression pass

Validate the model/catalog changes against the existing Plus-focused account pool.

Per instance, preserve:

```text
stable instance id
stable bridge port
isolated CODEX_CHATGPT_WEB_HOME
isolated browser partition
isolated response/runtime state
isolated control token
isolated ownership marker
```

Validate:

- primary instance behavior
- managed instance startup metadata
- browser partition isolation
- Cockpit pool synchronization
- enable/disable semantics
- selected-instance UI binding
- route replacement/journal resolution
- no cross-account browser state leakage

Explicitly out of scope:

- Pro usage limits
- Pro billing-plan detection
- Pro $100/$200 quota policies

Acceptance:

- Multiple Plus accounts can coexist exactly as before.
- Catalog updates do not collapse providers into one account.
- Disabling one instance does not alter another account's state.

## Phase 8: Windows/runtime reliability fixes

Selectively port v6 fixes relevant to the Windows deployment.

Candidates:

- equivalent Windows TOML trust-key recognition
- trusted workspace recovery
- setup deadline enforcement
- hook command mutation/serialization regression coverage
- runtime/tunnel startup ownership fixes that do not break custom multi-instance lifecycle
- clearer runtime/setup diagnostics

Skip:

- Linux ARM64 packaging
- Linux libnotify SONAME changes
- staged release updater
- upstream auto-updater behavior
- logo-only changes

Acceptance:

- Windows trust recognition remains strict about ownership.
- Setup cannot hang past its intended deadline.
- Hook command tests pass on Windows semantics.
- Primary and managed runtime ownership remain deterministic.

## Phase 9: Markdown and response fidelity

Port relevant upstream parser/response fidelity fixes without replacing custom routing/server behavior.

Validate:

- Markdown block fidelity
- links and code fences
- streamed/final response assembly
- error-response classification
- server response shape expected by Cockpit/Codex

Acceptance:

- Existing response parser tests pass.
- New upstream regression cases pass.
- No response-shape regression reaches Cockpit.

## Phase 10: Validation matrix

Run focused tests first, then broad validation.

### Focused backend tests

1. Model definitions and legacy aliases.
2. Model family + effort selection.
3. Browser worker contract/recovery.
4. Environment/trust handling.
5. Bigger Context six-part ordering and ACKs.
6. Compaction continuation and browser recovery.
7. Queued native-turn lifecycle.
8. Subagents Native V1.
9. Subagents Native V2.
10. Cockpit model catalog/provider sync.
11. Multi-instance pool/journal/ownership behavior.
12. Response/Markdown parser regressions.

### Launcher/runtime tests

1. Runtime host/supervisor tests.
2. Managed instance lifecycle tests.
3. Browser host isolation tests.
4. Cockpit controls/provider synchronization tests.
5. Windows-specific setup/hook tests.

### Broad validation

- Backend test suite.
- Launcher test suite.
- Backend TypeScript/typecheck.
- Launcher TypeScript/typecheck.
- Renderer/build validation.
- Runtime/package build or smoke checks that do not replace the currently running live installation.

Any upstream test that assumes Fresh Chat, Saved Chats, Pro Limits, staged updater, or stock single-instance launcher ownership must be omitted or adapted to the explicitly selected custom scope.

## Phase 11: Source/build complete, live runtime unchanged

This phase is an explicit stop gate.

After code and tests are complete:

```text
source tree       = updated
focused tests     = passed or documented
broad tests       = passed or documented
build artifacts   = prepared if required
running app       = unchanged
running runtime   = unchanged
running browser   = unchanged
```

Do not:

- restart Electron
- stop/start managed instances
- reload the browser host
- replace the runtime used by the active session
- kill the tunnel/runtime process
- trigger an updater
- run an installer over the active custom app

Report clearly what is only on disk versus what is already live.

The user will manually restart Codex Web GPT after the implementation report, at which point the new source/runtime may be loaded.

## Implementation order

Use this order to minimize cross-layer breakage:

```text
1. Baseline/conflict map
2. v6 model definitions + compatibility
3. Browser model selection/reliability
4. Bigger Context six-part transport
5. Compaction/continuation reconciliation
6. Subagents Native V1/V2
7. Cockpit v6-style catalog
8. Multi-account/multi-instance regression
9. Windows/runtime reliability
10. Markdown/response fidelity
11. Focused tests
12. Broad tests + typecheck + build
13. STOP before restart/reload
```

## Completion report format

At completion, report four separate states so source success is not confused with deployment:

```text
Adopted from v6:
- ...

Intentionally skipped:
- Fresh Chat
- Saved Chats
- Pro Limits/quota logic
- staged/automatic updater
- Linux-only changes
- cosmetic-only changes

Validation:
- focused tests: ...
- broad tests: ...
- typecheck/build: ...

Deployment state:
- source on disk: updated
- running Codex Web GPT: NOT restarted/reloaded
- next action: user manually restarts the app
```

The upgrade is complete only when the source and test work is finished. Activation of the new runtime is intentionally left to the user's manual restart.
