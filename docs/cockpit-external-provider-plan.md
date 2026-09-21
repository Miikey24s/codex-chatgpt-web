# Cockpit External Provider Plan

## Muc tieu

Bien `codex-chatgpt-web` thanh provider ChatGPT Web nam sau Cockpit, voi ownership ro rang:

```text
Codex
  -> Cockpit              = route owner duy nhat
  -> codex-chatgpt-web    = ChatGPT Web provider
  -> ChatGPT Plus / Pro
```

Muc tieu su dung khong doi: Codex Desktop/CLI van dung tai khoan ChatGPT Plus/Pro thong qua ChatGPT Web, thay vi chuyen sang OpenAI API tinh tien theo token.

## Trang thai thuc thi (2026-09-21)

- A - External-provider / routing ownership: source candidate da dung `integrationOwner = "cockpit"` lam provider-only mode; launcher khong tu connect/restore Codex route khi Cockpit so huu routing.
- B - Responses passthrough: Cockpit mode expose catalog ChatGPT Web rieng, giu Responses/function-call contract va fail closed thay vi forward native Codex model vao provider.
- C - Native Codex tool-call loop: da co regression end-to-end `Responses tool registry -> function_call -> function_call_output -> browser continuation`; tool execution van thuoc outer Codex.
- D - Bo dependency cwd/environment tren provider path: provider-only turn chi bind tool registry, khong can `cwd`, workspace roots hay sandbox envelope. Legacy environment path van duoc giu cho standalone/fallback.
- E - Resume + compaction validation & DEV browser isolation:
  - Source/typecheck/build va unit/contract tests pass: `bun run typecheck` (0 errors), focused provider/resume suite `13/13` pass (`tests/provider-only-contract.test.ts` + `tests/responses-state.test.ts`), va candidate runtime `dist/runtime-next` pass `RELOCATABLE_RUNTIME_SMOKE_OK`.
  - Candidate server live-smoke tren port test `17843` (dung TEMP HOME rieng va unique named pipe broker):
    - `/healthz` tra `status = ok`, `version = 5.0.8`, `mode = full`, `integration_owner = cockpit`, `routing_owner = cockpit`, `provider_base_url = http://127.0.0.1:17843/v1`, `active_http_turns = 0`, `active_browser_turns = 0`.
    - `/v1/models` chi expose 3 provider models: `chatgpt-web/light`, `chatgpt-web/medium`, `chatgpt-web/high`.
    - Native model fail closed: request model `gpt-5.6` tra HTTP 400.
    - Candidate stop sach se, port 17843 khong con listen, production config hash (`B50B7F1DBC5C5FD12B4E35EC765CE3F02B3F84CBCB15A44486E234453DE3A541`) khong bi sua.
  - Audit DEV launcher isolation:
    - DEV launcher (`--dev-profile`) hoan toan doc lap voi production ve profile (`development`), coreHome (`~/.codex-chatgpt-web-dev`), userData (`~/.codex-chatgpt-web-dev/launcher`), Chromium partition (`persist:codex-web-gpt-dev-chatgpt`), browser descriptor (`~/.codex-chatgpt-web-dev/runtime/launcher-browser.json`), Single Instance Lock (`Codex Web GPT DEV`), va dynamic CDP / control ports. DEV launcher co the chay song song voi production ma khong bi xung dot tien trinh.
    - DEV profile hien da ton tai, da authenticated va o `full (dev-harness)` voi MCP runtime `ready`; production browser khong duoc dung cho cac live test nay.
  - Live DEV browser validation sau khi profile duoc authenticated:
    - PASS plain browser turn: `chatgpt-web/light` tra dung `PHASE E PLAIN OK`.
    - PASS tool round tren live browser/DEV MCP: model phat `exec_command`, broker tra explicit simulated receipt, sau do model tiep tuc trong cung Responses turn. Day la bang chung transport/tool-boundary live; receipt ghi ro `simulated = true`, `side_effects_performed = false`, nen khong duoc tinh la real shell side effect.
    - PASS multi-turn continuity + model switch: named chat giu `ORCHID-7319`, sau do switch `chatgpt-web/light -> chatgpt-web/high` van tra dung gia tri.
    - PASS manual compaction + continuation: 6 history items duoc compact thanh 3 replacement items; turn sau compaction van giu dung `JADE-4826`.
    - PASS DEV launcher restart: launcher PID doi `12304 -> 16032`; profile van authenticated/MCP ready va named chat sau restart van giu `ORCHID-7319`.
  - Live provider-only HTTP candidate tren port `17844` dung DEV browser descriptor + DEV tunnel/broker rieng voi production:
    - PASS `/healthz`: `mode = full`, `integration_owner = cockpit`, `routing_owner = cockpit`, `provider_base_url = http://127.0.0.1:17844/v1`.
    - PASS `/v1/models`: chi `chatgpt-web/light`, `chatgpt-web/medium`, `chatgpt-web/high`.
    - PASS browser-backed `/v1/responses`: request co native `thread_id`/`turn_id` metadata tra dung `HTTP PLAIN OK`.
    - PASS persisted response state: `responses-state.json` luu response `resp_4c200df82e8346b3af6204480ef9f1ae` cung owner `thread_phase_e_http_plain`; state van ton tai sau candidate restart.
    - PASS live HTTP SSE qua harness doc lap.
    - PASS live `previous_response_id` continuation sau provider restart.
    - PASS isolated Cockpit restart continuation: Cockpit thuc te strip `previous_response_id` nhung giu `prompt_cache_key` va trusted `client_metadata.thread_id`; provider replay latest response chi trong dung thread va giu duoc marker qua restart.
    - Live tool-registry/function-call path da co bang chung pass truoc do. Lan re-run cuoi cung bi ChatGPT Web safety check chan forced `read_file` truoc khi tool call, nen harness co mode skip gate nay de xac minh rieng restart matrix; regression provider-only tool loop van pass trong focused suite.
    - Cleanup: ca candidate test `17843` va `17844` da stop, hai port khong con listen, cac TEMP HOME `cgw-phase-e-http-*` da xoa. Production config hash van la `B50B7F1DBC5C5FD12B4E35EC765CE3F02B3F84CBCB15A44486E234453DE3A541`.
- F - Cleanup legacy custom code: co y defer den sau live cutover va fallback window; khong xoa resolver/rollout code trong phase nay.

Production cutover da hoan tat thanh cong vao 2026-09-21:
- Production launcher va durable runtime da duoc update sang candidate bundle ID `19a9af94edc6012d2ffde9a791182cb58860e204f329cc36de3db37b19b48dea`.
- Fallback bundle cu (`5213387992722a3541fed75748670c8bb127ab4ae354a5446fee234db24333d6`) duoc luu tru an toan tai `~/.codex-chatgpt-web/versions/5.0.8-win32-x64-backup-52133879`.
- Production bridge dang chay voi bun.exe PID 8472 (Parent Launcher PID 23348) tren port 17841.
- `/healthz` xac nhan `integration_owner = cockpit`, `routing_owner = cockpit`, `provider_base_url = http://127.0.0.1:17841/v1`, va active turns deu = 0 khi idle.
- `/v1/models` chi expose 3 ChatGPT Web provider models (`chatgpt-web/light`, `chatgpt-web/medium`, `chatgpt-web/high`).
- Live smoke request qua Cockpit route (port 54005 -> 17841) tra ve thanh cong `SMOKE_TEST_SUCCESS` tren model `chatgpt-web/high`.

Ghi chu validation 2026-09-21:
- Production idle check truoc restart: PASS (0 active turns).
- Artifact/installer hash SHA256 `F5AE8332F0F3C52B196F9A796ABAA63B4E08014906981C6A806FC0331B45B5B2`: PASS.
- Production cutover & durable runtime install: PASS.
- Full restart & process verification: PASS.
- Cockpit route ownership & live smoke test: PASS.

## Nguyen tac kien truc

- Cockpit so huu routing, provider selection va `openai_base_url`.
- Codex so huu workspace, `cwd`, filesystem, shell, Git, MCP, sandbox va tool execution.
- `codex-chatgpt-web` chi so huu browser/session ChatGPT Web, model mapping, transport, streaming va chuyen doi Responses API.
- Provider khong duoc tu `route connect`, sua Codex config, hoac tranh route ownership voi Cockpit.
- Ve dich, provider khong duoc phu thuoc vao viec khoi phuc `cwd` tu rollout/resume/compaction.

## Pham vi

### Giu lai

- Login/session ChatGPT Web.
- Browser automation/backend transport dang hoat dong.
- Model mapping va model selector.
- Responses API va streaming.
- Usage/health/model metadata can thiet cho Cockpit.

### Tach khoi provider

- Codex route ownership.
- Tu dong sua `openai_base_url` / `model_provider`.
- Workspace authority.
- `cwd` resolution.
- Rollout parsing de xac dinh local environment.
- Sandbox/permission ownership.
- Local tool execution trong bridge.

## Phase 0 - Audit truoc khi sua

1. Lap ban do tat ca custom changes so voi upstream.
2. Phan loai code theo 5 nhom:
   - routing/config ownership;
   - ChatGPT Web transport;
   - local tools;
   - environment (`cwd`, roots, sandbox);
   - rollout/resume/compaction.
3. Doi chieu upstream va external-provider work de tranh viet lai logic da co.
4. Ghi ro file nao la transport core, file nao chi ton tai vi bridge dang lam Codex environment owner.

Deliverable: mot danh sach file/flow can giu, can tach, can deprecate.

## Phase 1 - External Provider Mode

Tao mode ro rang, vi du `external-provider`, trong do:

- daemon van khoi dong va login ChatGPT Web binh thuong;
- khong sua Codex config;
- khong tu chiem `openai_base_url`;
- khong chay route-connect logic;
- expose endpoint de Cockpit goi nhu mot provider binh thuong.

Cockpit se la route owner duy nhat:

```text
Codex -> Cockpit :54005 -> Web provider -> ChatGPT Web
```

Khong thay the bridge dang chay ngay. Chay mode moi song song tren port test rieng de A/B.

## Phase 2 - Responses API Passthrough

Uu tien giu Responses API end-to-end:

```text
Codex Responses
  -> Cockpit
  -> Web provider
  -> Cockpit
  -> Codex
```

Can bao toan toi da:

- response/item IDs;
- streaming event order;
- tool schemas;
- function call IDs;
- `function_call_output` continuation;
- usage metadata;
- resume/multi-turn semantics.

Tranh convert sang Chat Completions neu khong bat buoc.

## Phase 3 - Tra tool execution ve Codex

Muc tieu:

```text
ChatGPT Web
  -> function_call
Web provider
  -> Cockpit
  -> Codex
  -> native tool execution
  -> function_call_output
  -> Cockpit
  -> Web provider
  -> ChatGPT Web
```

Provider chi chuyen tool intent va tool result. Codex la noi thuc thi Shell/Files/Git/MCP.

Khi phase nay hoan tat, provider khong can biet thu muc lam viec thuc te de chay tool.

## Phase 4 - Go phu thuoc environment

Sau khi tool loop native hoat dong, co lap va deprecate dan cac dependency sau khoi provider path:

- `cwd` reconstruction;
- workspace-root inference;
- rollout lookup de khoi phuc environment;
- resume/compaction environment authority;
- local sandbox authority.

Khong xoa ngay code cu. Truoc tien cho no nam ngoai external-provider path va giu fallback den khi validation xong.

## Phase 5 - Validation

Test theo thu tu tu don gian den agentic:

1. Plain response.
2. Streaming response.
3. Shell tool call.
4. Read file.
5. Edit file.
6. Git operation.
7. MCP tool.
8. Multi-turn conversation.
9. Resume thread.
10. Compaction + continuation.
11. Model switch.
12. Subagent flow.
13. Restart Web provider giua session.
14. Restart Cockpit giua session.

## Tieu chi pass

- Cockpit van la route owner sau restart/update.
- `codex-chatgpt-web` khong sua Codex provider config trong external-provider mode.
- ChatGPT Plus/Pro session van la backend thuc te.
- Tool execution xay ra o Codex native path.
- Full tool loop hoat dong: schema -> function call -> execution -> function output -> continuation.
- Resume/compaction khong phu thuoc vao provider tu suy ra `cwd`.
- Khong con `missing cwd` tren external-provider path.
- Provider restart khong lam mat ownership/routing cua Cockpit.

## Cutover

1. Giu bridge hien tai lam fallback.
2. Chay external-provider mode tren port test rieng.
3. Route mot test model/profile tu Cockpit sang provider moi.
4. Chay het validation matrix.
5. Chuyen Web GPT route chinh sang provider moi.
6. Theo doi mot thoi gian voi fallback van con san.
7. Chi sau khi on dinh moi xoa cac custom patch `cwd`/rollout/compaction khong con can.

## Thu tu implement

```text
A. External-provider / routing ownership
B. Responses passthrough
C. Native Codex tool-call loop
D. Loai dependency vao cwd/environment
E. Resume + compaction validation
F. Cleanup legacy custom code
```

## Non-goals

- Khong tiep tuc mo rong `missing cwd` resolver bang them heuristic moi.
- Khong doi sang OpenAI API billing.
- Khong bo Cockpit.
- Khong thay browser/session ChatGPT Web neu transport hien tai van dung duoc.
- Khong xoa fallback truoc khi agentic validation pass.

## Quyet dinh kien truc

Van de can sua khong phai la "lam `cwd` resolver thong minh hon", ma la giam trach nhiem cua provider de no khong can lam environment owner cua Codex.

Kien truc dich:

```text
Cockpit = routing owner
Codex = workspace + tools owner
codex-chatgpt-web = ChatGPT Web provider only
```
