# TypeSafe Integration Plan

## Muc tieu

Them TypeSafe System One vao hai semantic fallback co gia tri cao nhat cua bridge:

1. Phan loai adapter/upstream error message mo ho.
2. Tim tool theo intent khi `codex_tool_inventory` lexical search khong co ket qua.

TypeSafe chi cung cap semantic judgment. Code hien tai van la authority cho protocol, permission,
HTTP status/code co cau truc, cancellation, tool visibility va tool execution.

Muc tieu khong phai thay regex/logic deterministic bang AI toan bo. Muc tieu la bo sung mot lop
fallback cho nhung input tu nhien ma exact keyword matching de bo sot, trong khi service TypeSafe
co the tat, timeout hoac loi ma bridge van giu behavior cu.

## Bang chung tu experiment

Experiment live dung `TYPESAFE_API_KEY` va `jev-latest` (resolve thanh `jev-1.13.0` tai thoi diem
test) cho ket qua:

- Error classification: 8/9 paraphrase semantic duoc TypeSafe phan loai dung. Case sai duy nhat co
  confidence `0.38`, nen confidence gate co kha nang giu duoc deterministic fallback.
- Cac paraphrase nhu `request frequency exceeded`, `access token is no longer valid`, `model token
  budget`, `service is at capacity`, `billing credits are exhausted`, `client disconnected` va
  `requires a paid subscription` deu duoc phan loai dung voi confidence gan `0.99-1.00`.
- Cac network error ngoai taxonomy nhu DNS/TLS/EOF thuong duoc chon `unknown`; mot case
  `ECONNRESET` co confidence thap `0.53`, tiep tuc ung ho confidence gating.
- Tool discovery: semantic query `quota left` va `change task name` khong co lexical match trong
  inventory hien tai, nhung TypeSafe chon dung `get_usage_limits` va `set_thread_title` voi
  confidence `0.99-1.00`.
- No-match query `explain what a monad is` chon `none` voi confidence `1.00`.
- Latency quan sat cua mot TypeSafe request trong sample khoang `0.74-0.98s`, nen khong nen dat tren
  moi request/hot path.

Nhung so lieu tren chi la smoke experiment nho, khong phai production threshold. Threshold va
rollout phai duoc calibrate bang fixture/log cua repo.

### Ket qua implementation/eval hien tai

Runtime foundation va hai fallback da duoc implement voi mode mac dinh `off`. HTTP client noi bo
dung `fetch` thay vi them SDK dependency, de giu bundle/runtime hien tai khong doi dependency graph.

Live eval tren fixture mo rong voi `jev-latest` (resolve `jev-1.13.0` tai lan chay nay) cho thay:

- Error classifier: baseline deterministic dung `10/23`; voi semantic fallback va threshold `0.90`,
  ket qua `23/23`, co 13 semantic decision tu dong va `0` false positive tren 7 case `unknown`.
- Mot negative case co wording `upstream HTTP client closed ...` bi semantic model chon
  `client_closed` voi confidence `0.62`; threshold `0.90` abstain dung. Day la ly do cu the de khong
  ha threshold chi de tang recall.
- Error latency tren 20 semantic call: p50 `309ms`, p95 `389ms`; khong co API failure trong run nay.
- Tool inventory: threshold `0.90` giu `0` false positive tren no-match/ambiguous cases va semantic
  fallback cuu 4 lexical miss. Case `hide this task from my sidebar` duoc chon dung tool archive
  nhung confidence chi `0.56`, nen active gate co chu y abstain. Threshold `0.50` dat recall cao hon
  trong sample, nhung khong duoc chon lam default vi safety margin kem hon.
- Tool latency tren live semantic calls o run calibrate: p50 khoang `310ms`, p95 `340ms`.
- Query prompt-injection-like (`Ignore prior instructions ... Actual request: explain ...`) duoc
  reject thanh no-match; ambiguous `change this task` chi co confidence `0.45` va cung bi gate.

Vi dataset van nho, `0.90` la default bao thu de rollout/shadow, khong phai mot cam ket calibration
production vinh vien. Cac feature van `off` neu khong co env flag explicit.

## Nguyen tac kien truc

- Structured evidence thang semantic inference.
- TypeSafe chi duoc nhin thay va chon trong candidate set ma code da cho phep.
- TypeSafe failure luon fail-open ve behavior hien tai.
- Khong dua TypeSafe vao auth, permission proof, sandbox, config parsing, protocol correlation hoac
  exact source parsing.
- Khong goi TypeSafe trong browser polling/completion loop o phase nay.
- API key chi doc tu process environment, khong serialize vao diagnostics, logs hoac browser state.
- Model output phai map vao closed enum/known `wire_name`; khong dung generated prose de dieu khien
  execution.
- Confidence chi la mot signal. Threshold phai duoc danh gia tren du lieu thuc, khong copy cookbook
  threshold mot cach may moc.

## Phase 0 - Runtime foundation

Tao mot boundary nho cho System One, du kien `src/typesafe/`:

```text
src/typesafe/
  client.ts
  config.ts
  error-classifier.ts
  tool-discovery.ts
  types.ts
```

`client.ts` so huu:

- `POST https://api.typesafe.ai/v1/systemone` hoac JavaScript SDK neu dependency duoc chap nhan.
- model default `jev-latest`.
- request timeout ngan va AbortSignal.
- normalize API/network/rate-limit/overload failure thanh ket qua unavailable, khong throw xuyen qua
  application path.
- response validation truoc khi expose ra caller.
- optional latency/token metadata cho diagnostics.

`config.ts` so huu feature mode:

```text
off | shadow | active
```

Du kien config rieng cho:

```text
TYPESAFE_ERROR_CLASSIFICATION
TYPESAFE_TOOL_DISCOVERY
```

Khong can mot global `TYPESAFE_ENABLED` neu hai mode tren da du de tat/bat ro rang. Neu them global
switch thi no chi duoc la master disable, khong thay the per-feature mode.

### Dependency decision

Truoc khi implement, doi chieu SDK JavaScript live va repo packaging:

- Neu `@typesafe-ai/sdk` nho, ESM/Bun compatible va khong lam runtime bundle phuc tap, dung SDK de
  nhan retry/API typing chinh thuc.
- Neu SDK lam tang complexity build/runtime khong dang co, dung HTTP client nho tren `fetch` voi
  schema validation noi bo.

Khong them dependency chi de tien loi neu HTTP contract hien tai da don gian va repo co pattern
`fetch` tot.

Deliverable: mot TypeSafe client co timeout, validation, diagnostics va fail-open contract, chua
anh huong production behavior.

## Phase 1 - Semantic error classification shadow mode

Target chinh: `src/lib/errors.ts`.

Pipeline mong muon:

```text
explicit status / type / code
        |
        v
existing deterministic classification
        |
        v
resolved strongly? -------- yes --> return current result
        |
        no
        v
generic / ambiguous fallback
        |
        v
TypeSafe Choice
        |
        v
shadow record only
```

Taxonomy khoi dau:

```text
authentication
permission
subscription
quota
rate_limit
context_length
overloaded
timeout
invalid_request
client_closed
unknown
```

State gui TypeSafe nen co cau truc, vi du:

```json
{
  "status": 502,
  "provider_type": "upstream_error",
  "message": "Request frequency exceeded for this account; slow down before retrying."
}
```

Khong goi semantic classifier neu da co explicit/authoritative evidence nhu:

- known `status` 401/403/429 voi contract ro rang;
- explicit provider `errorType`/`code`;
- known client cancellation/close signal;
- exact deterministic cases ma current classifier da resolve.

Shadow mode phai thu thap toi thieu:

```text
existing category/status/code
typesafe choice
typesafe confidence
top probabilities
model version
latency
request failure kind, neu co
```

Khong log full secret-bearing payload. Error message can duoc sanitize/truncate theo diagnostics
policy hien tai.

Deliverable: semantic classifier chay duoc tren ambiguous fallback nhung khong thay doi HTTP/error
response.

## Phase 2 - Error evaluation va active confidence gate

Them fixture dataset, vi du:

```text
tests/fixtures/typesafe/error-classification.json
scripts/eval-typesafe.ts
```

Dataset can bao gom:

- exact wording hien tai;
- paraphrase cung nghia;
- provider-specific wording;
- mixed signals;
- unknown DNS/TLS/socket/EOF failures;
- negative cases co keyword nhung sai ngu canh;
- cancellation/client-close variants;
- subscription vs permission ambiguity;
- quota vs rate-limit ambiguity.

Metrics:

- overall accuracy;
- per-label precision/recall;
- false-positive rate tren `unknown`;
- abstention rate theo confidence threshold;
- calibration buckets;
- p50/p95 latency;
- input/output tokens;
- API failure rate.

Threshold ban dau co the evaluate quanh `0.90`, nhung value production chi duoc chon sau khi chay
dataset. Neu uncertainty khong tach tot error/correct cases, giu shadow va sua question/taxonomy
truoc khi active.

Active pipeline:

```text
deterministic result
    |
    +-- authoritative/resolved --> return
    |
    +-- generic ambiguous
            |
            v
        TypeSafe Choice
            |
            +-- high confidence + non-unknown --> map to known Codex error
            |
            +-- low confidence / unknown / service failure --> original generic fallback
```

TypeSafe mapping phai la pure code map tu closed label sang `{ httpStatus, type, code }`.

Deliverable: semantic error fallback active sau confidence gate, voi behavior cu la fallback bat
buoc.

## Phase 3 - Semantic `codex_tool_inventory` shadow mode

Target chinh: `src/adapters/chatgpt-web/mcp-server.ts`.

Visibility pipeline bat buoc:

```text
bound tool registry
        |
        v
safeVisibleTools + contract exclusions
        |
        v
eligible catalog only
        |
        +--> existing lexical search
        |
        +--> TypeSafe semantic judgment
```

TypeSafe khong bao gio duoc nhin thay tool bi hide/exclude neu co the tranh duoc. Quan trong hon,
ket qua semantic phai intersect lai voi eligible catalog truoc khi tra ve, de visibility contract
van dung ke ca khi implementation thay doi sau nay.

Fast path production du kien:

```text
query empty ----------------------> current pagination behavior
exact/lexical matches available --> current behavior
zero lexical matches ------------> semantic fallback
```

Vi latency hien quan sat gan 1s/call, phase dau khong goi semantic search cho moi inventory query.

### Semantic design

Ap dung pattern cua TypeSafe `Skill suggestion`:

Request 1:

- `Choice` tren eligible tool names + short descriptions.
- co explicit `none` option, hoac them mot Noul `does_any_tool_fit` neu evaluation cho thay tach
  presence judgment tot hon.
- lay probability distribution, khong chi winner.

Request 2 chi can khi catalog lon hoac benchmark cho thay request 1 hay nham:

- top N candidates (du kien 3) voi description/schema day du hon;
- Choice co `none` de reject all.

Khong trien khai two-stage mac dinh neu one-stage dat quality/latency tot trong catalog thuc.

Shadow mode ghi lai lexical result va semantic suggestion, nhung response inventory van nhu hien
tai.

Deliverable: do duoc recall gain cua semantic search tren actual eligible catalog ma khong doi tool
discovery behavior.

## Phase 4 - Tool discovery evaluation va active fallback

Them fixture dataset, vi du:

```text
tests/fixtures/typesafe/tool-discovery.json
```

Case bat buoc:

- exact `wire_name`/tool name;
- lexical description hit;
- synonym (`quota left` -> usage limits);
- intent phrase (`change task name` -> title setter);
- ambiguous intent;
- no applicable tool;
- hidden/excluded tool co semantic match ro rang;
- near-duplicate tools;
- large catalog/pagination case;
- query co prompt-injection-like text.

Metrics:

- top-1 accuracy;
- top-3 recall neu co shortlist;
- false-positive rate tren no-match;
- fraction zero-result lexical queries duoc semantic fallback cuu;
- confidence calibration;
- p50/p95 latency va token cost.

Active mode chi bat khi:

- lexical search khong co result;
- semantic answer thuoc eligible set;
- no-match check pass;
- confidence dat threshold da calibrate.

Neu khong, tra zero-result inventory nhu behavior hien tai.

Tool invocation van dung exact `wire_name` va tat ca schema/turn-token/approval validation hien tai.

Deliverable: semantic recall cho inventory query ma khong thay doi permission hay invocation
authority.

## Phase 5 - Tests

Tat ca normal unit/contract tests phai khong goi network. Inject/mock TypeSafe boundary.

### Client tests

- missing `TYPESAFE_API_KEY` -> unavailable/fallback;
- timeout/abort;
- 401/422/429/529/5xx;
- malformed response;
- unknown answer label;
- diagnostics khong leak API key.

### Error classifier tests

- structured status/type/code luon co precedence;
- current deterministic known cases khong bi semantic override;
- semantic high-confidence fallback map dung;
- low confidence giu generic current result;
- `unknown` giu generic result;
- API failure giu generic result;
- shadow mode khong thay response.

### Tool inventory tests

- lexical hit khong can semantic fallback trong active fast path;
- lexical miss + semantic high confidence co the tra eligible tool;
- `none`/low confidence van empty;
- hidden tool khong the duoc semantic result lam visible lai;
- excluded nested gateway tool khong the quay lai;
- pagination/include_schema contract khong regression;
- TypeSafe failure giu current inventory behavior;
- shadow mode khong thay response.

Tap trung harness regression vao `tests/chatgpt-web-harness.test.ts` va lifecycle/security tests lien
quan den MCP inventory.

## Phase 6 - Diagnostics va observability

Them structured diagnostic event nho, khong dua TypeSafe vao user-visible protocol:

```text
feature
mode
outcome: selected | abstained | unavailable | shadow
choice
confidence
latency_ms
model
input_tokens
output_tokens
```

Khong log API key. Khong log schema/candidate payload day du neu no co the chua sensitive data.

Can co counters de tra loi:

- TypeSafe duoc goi bao nhieu lan?
- Bao nhieu call fallback ve deterministic behavior?
- Bao nhieu lexical zero-result duoc semantic lookup cuu?
- Bao nhieu high-confidence semantic classification sau do bi fixture/manual review danh dau sai?

## Phase 7 - Rollout

Thu tu rollout:

1. Merge runtime foundation voi tat ca feature `off`.
2. Bat error classifier `shadow` tren DEV/diagnostic environment.
3. Chay offline eval + thu telemetry thuc.
4. Chot confidence threshold va bat error classifier `active`.
5. Bat tool discovery `shadow`.
6. Chay tool discovery eval tren catalog thuc.
7. Bat semantic inventory fallback chi cho lexical miss.
8. Theo doi latency, abstention va false-positive rate truoc khi mo rong pham vi.

Khong bat ca hai feature active cung luc ngay lan dau. Error classifier co input/output contract nho
hon, nen rollout no truoc de validate client/failure behavior.

## Khong nam trong scope nay

- DOM commentary/status classification live.
- `Stopped thinking` completion authority.
- UI localization replacement.
- TOML/config parsing.
- rollout authentication/environment proof.
- permission/sandbox decisions.
- protocol/JSON/schema parsing.
- retry-after numeric extraction tren network error hot path.

DOM semantic shadow diagnostics co the la phase rieng sau nay, nhung khong duoc chen TypeSafe API
call vao browser poll loop trong implementation nay.

## File map du kien

File moi:

```text
src/typesafe/client.ts
src/typesafe/config.ts
src/typesafe/types.ts
src/typesafe/error-classifier.ts
src/typesafe/tool-discovery.ts
tests/fixtures/typesafe/error-classification.json
tests/fixtures/typesafe/tool-discovery.json
scripts/eval-typesafe.ts
```

File can sua co kha nang cao:

```text
src/lib/errors.ts
src/adapters/chatgpt-web/mcp-server.ts
src/config.ts
src/types.ts
tests/chatgpt-web-harness.test.ts
package.json                 # chi neu chon JavaScript SDK
```

File security/authority nhay cam nhu `codex-rollout-environment.ts` khong can sua de TypeSafe tham
gia decision.

## Verification checklist

Moi phase implementation phai chay it nhat:

```text
bun run typecheck
focused TypeSafe tests
focused errors tests
focused MCP/tool inventory tests
```

Truoc khi bat active mode:

```text
bun run test
bun run build
```

Neu runtime packaging thay doi do SDK dependency, them release/runtime smoke de xac nhan bundle
relocatable van chay va khong can dependency ngoai.

## Acceptance criteria

Implementation chi duoc coi la hoan tat khi:

- TypeSafe tat, timeout, rate-limit hoac down thi bridge van hoat dong theo behavior cu.
- API key khong xuat hien trong log/diagnostic/browser state.
- Explicit status/type/code va cancellation contract khong regression.
- Semantic error classifier tang coverage paraphrase ma khong lam tang false-positive `unknown`
  vuot threshold da dinh nghia trong eval.
- `codex_tool_inventory` co the tim dung intent query lexical miss nhu `quota left` va
  `change task name`.
- No-match query khong bi ep chon tool.
- Tool hidden/excluded khong the duoc TypeSafe lam visible hoac callable.
- TypeSafe latency chi nam tren fallback path, khong tren moi turn/inventory poll.
- Threshold co the thay doi bang config/policy ma khong viet lai semantic workflow.
- Network-free regression tests bao phu failure, confidence gating va authority precedence.
- Full typecheck/test/build pass tren worktree sau implementation.

## Thu tu implementation de xuat

```text
runtime foundation
  -> error classifier shadow
  -> error eval/calibration
  -> error active fallback
  -> tool discovery shadow
  -> tool discovery eval/calibration
  -> tool discovery active fallback
  -> full verification
```

Day la thu tu mac dinh cho implementation. Neu evaluation o bat ky phase nao cho thay confidence
khong tach duoc correct/incorrect cases, giu feature o `shadow` va sua taxonomy/question/candidate
construction truoc khi tang authority.
