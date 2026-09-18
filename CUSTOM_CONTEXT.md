# Context & Architecture Summary: Codex Web GPT (Custom Cockpit Edition)

> Tài liệu này được biên soạn cho các **AI Coding Agent** tiếp theo để nắm bắt toàn bộ kiến trúc, các chỉnh sửa tùy biến (customizations), lỗi đã khắc phục và quy trình vận hành / debug của hệ thống **Codex Web GPT + Antigravity Cockpit**.

## 0. Ownership model hiện tại (Cockpit-first)

Custom build này dùng **một codebase Codex Web GPT với hai integration owner rõ ràng**, không tách fork/binary riêng:

- `integrationOwner = "cockpit"` là mặc định của build này. Cockpit sở hữu global Codex route/provider/model catalog và local-access account routing. Codex Web GPT chỉ đăng ký provider bridge của chính nó, Compatibility V1/hook mà nó thực sự sở hữu, cùng launcher/tunnel/connector automation.
- `integrationOwner = "standalone"` giữ hành vi Codex Web GPT truyền thống: bridge trực tiếp có thể sở hữu `openai_base_url`, route journal và rollback của nó.
- Không suy luận ownership lâu dài chỉ từ marker file Cockpit. Marker cũ chỉ phù hợp cho migration; journal/config explicit mới là source of truth.
- Electron launcher **không chứa bản sync routing thứ hai**. Mọi mutation Cockpit integration phải đi qua core command `codex-chatgpt-web cockpit sync`; helper Electron chỉ đọc status.
- Active Cockpit model catalog hiện tại là `~/.codex/cockpit-model-catalog.json`. File `.cockpit-experimental-model-catalog-config.json` chỉ còn vai trò compatibility/migration khi có mặt.

### Port / data flow

```text
Codex Desktop
  -> Cockpit Local Access :54005 /v1    (Cockpit owns global Codex routing)
  -> Codex Web GPT provider :17841 /v1  (Web GPT bridge, only for chatgpt-web/high)
  -> ChatGPT Web / MCP connector / Tunnel
```

`55928` là Cockpit internal service, **không phải** Codex local-access route chính. Launcher phải hiển thị `54005` là Cockpit Local Access và `17841` là Web GPT Bridge.

### Update / deploy rule

Có thể update source Codex Web GPT rồi reconcile lớp custom Cockpit-first trên cùng repo. Build/test source trước. Nếu agent hiện tại đang được phục vụ qua chính Web GPT bridge, **không restart/stop/deploy runtime giữa phiên**; chỉ restart ở bước deploy cuối, tốt nhất từ một task/agent Codex khác để giữ continuity. Không chỉnh source/config thuộc ownership của ứng dụng Cockpit trừ khi người dùng yêu cầu riêng.

---

## 1. Thông Tin Môi Trường & Mã Nguồn

* **Kho mã nguồn:** `d:\ANNAM\AI\codex-chatgpt-web-cockpit`
* **Git Remote:** `https://github.com/miuuyy/codex-chatgpt-web.git`
* **Phiên bản hiện tại:** `5.0.8` (nâng cấp từ `5.0.4`, đồng bộ upstream chính thức)
* **Đường dẫn cài đặt ứng dụng Electron:** `C:\Users\MIIKEY\AppData\Local\Programs\Codex Web GPT\`
* **File ASAR chính của app:** `C:\Users\MIIKEY\AppData\Local\Programs\Codex Web GPT\resources\app.asar`
* **Thư mục cấu hình dữ liệu:**
  * Thư mục dữ liệu Codex Web GPT: `C:\Users\MIIKEY\.codex-chatgpt-web\`
  * Thư mục cấu hình Antigravity Cockpit: `C:\Users\MIIKEY\.antigravity_cockpit\`
  * Thư mục cấu hình Codex Desktop: `C:\Users\MIIKEY\.codex\`
* **Bản backup an toàn:** `d:\ANNAM\AI\backups\codex-chatgpt-web-cockpit-backup-20260918-1200\`

---

## 2. Kiến Trúc Hệ Thống & Cổng Mạng (Ports)

```text
[Codex Desktop / Laptop Clients]
             │
             │ HTTP /v1 (Responses / OpenAI compatible)
             ▼
[Cockpit Tools / cockpit-cliproxy] (Port: 54005, scope: LAN 0.0.0.0 / ::)
             │
             │ Quản lý pool 12 tài khoản + Định tuyến Tunnel
             ▼
[Codex Web GPT Daemon] (Bun runtime - Port: 17841 /v1)
             │
             └── Embedded Chromium Browser Host ──▶ ChatGPT Web (chatgpt.com)
```

| Cổng (Port) | Tiến trình | Vai trò |
|---|---|---|
| **`17841`** | `bun.exe` (`codex-chatgpt-web`) | Daemon cầu nối Responses sang phiên ChatGPT Web cục bộ (upstream v5.0.8). |
| **`54005`** | `cockpit-cliproxy.exe` | Proxy của Cockpit Tools, lắng nghe toàn bộ mạng LAN (`::` / `0.0.0.0`), phân phối tải và quản lý trạng thái tài khoản. |
| **`19528`** | Cockpit WebSocket | Kênh điều khiển WebSocket của Cockpit. |
| **`55928`** | Cockpit Service | Dịch vụ nội bộ Cockpit. |

---

## 3. Các Module Tùy Biến Đã Giữ Lại (Retained Customizations)

Theo thỏa thuận tinh gọn khi lên `v5.0.8`, hệ thống đã loại bỏ các module bot/custom UI thừa và chỉ giữ lại 2 thành phần cốt lõi:

### 3.1. Cockpit-First Integration & Core Routing (`src/cockpit.ts`, `src/codex-integration.ts`, `src/cli.ts`)
* **Chức năng:**
  - Tự động nhận diện Cockpit Local Access port (`54005`) từ `~/.antigravity_cockpit/codex_local_access.json`.
  - Tự động đăng ký bridge `http://127.0.0.1:17841/v1` vào `~/.antigravity_cockpit/codex_model_providers.json`.
  - Giữ cờ `integrationOwner = "cockpit"`: Ngăn Codex Web GPT ghi đè `openai_base_url` trong `config.toml` (để Cockpit toàn quyền làm master router cổng `54005`).
  - Lệnh CLI kiểm tra và đồng bộ: `codex-chatgpt-web cockpit sync`.

### 3.2. Lọc Duy Nhất Model `chatgpt-web/high` (`src/cockpit.ts`)
* **Chức năng:** Tự động lọc bỏ các model `light` / `medium`, chỉ đăng ký duy nhất model `chatgpt-web/high` (hiển thị là "Codex Web GPT") vào Cockpit catalog.

### 3.3. Các Thành Phần Sử Dụng 100% Native Upstream v5.0.8
* **Stream DIL / PUIK Reader:** Dùng 100% parser và stopped-thinking detector mới của upstream v5.0.8.
* **System Proxy:** Dùng 100% `src/native-network.ts` của upstream v5.0.8.
* **MCP Telemetry:** Dùng 100% `mcp-observation.ts` của upstream v5.0.8.
* **Electron Launcher UI:** Dùng giao diện gốc sạch sẽ, hỗ trợ đa ngôn ngữ i18n mới của v5.0.8.
* **ASAR Packaging:** Script `scripts/update-app-asar.cjs` đóng gói các assets vào `app.asar` trên Windows.

---

## 4. Các Lỗi Quan Trọng Đã Fix (Bugfix History)

| STT | Triệu chứng / Lỗi | Nguyên nhân gốc | Giải pháp đã áp dụng |
|---|---|---|---|
| **1** | Project dropdown trên modal tạo key luôn dừng ở *"Select project..."* | Dropdown của OpenAI là `SPAN.fsluc[role="button"]`, code cũ tìm `button` / `combobox` nên selector trả về null (`noTrigger: true`). | Viết lại selector nhắm đúng `[aria-haspopup="dialog"][data-state]`, `.fsluc` và hỗ trợ tìm kiếm trên secondary picker dialog. |
| **2** | Lỗi `Unauthorized - Access token is missing` khi tạo Connector | Request tới `/backend-api/aip/connectors/mcp` chỉ gửi cookie mà thiếu header Bearer token. | Lấy `accessToken` từ `/api/auth/session` của `chatgpt.com` và gắn `Authorization: Bearer <token>` vào request. |
| **3** | Lỗi `runtimeSupervisor.restartService is not a function` | Trong `main.cjs` gọi hàm `restartService()`, nhưng class `RuntimeSupervisor` chỉ có hàm `restart()`. | Bổ sung hàm alias `restartService()` trong `runtime-supervisor.cjs` và bọc gọi an toàn `(restartService \|\| restart)`. |
| **4** | Lỗi `503 Service Unavailable: auth_unavailable: No available account` trong Codex | Khi model chạy lệnh bash/powershell trả về dữ liệu quá lớn (>600k ký tự DOM), ChatGPT Web bị treo hoặc unmount DOM response -> timeout -> Cockpit đưa tài khoản vào Cooldown tạm thời (`unavailable=2`). | Khuyến nghị New Chat để làm sạch tab Browser, hoặc bật `"disableCooling": true` trong `codex_local_access.json` nếu muốn tắt phạt cooldown. |

---

## 5. Quy Trình Build & Triển Khai (Build & Deploy Pipeline)

Khi chỉnh sửa mã nguồn trong `launcher/`, chạy lệnh PowerShell sau để build và đóng gói vào app thực tế:

```powershell
# 1. Build frontend Vite (Lưu ý: phải dùng npx.cmd đầy đủ trên Windows)
& "C:\Users\MIIKEY\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\npx.cmd" vite build

# 2. Tắt app đang chạy
Stop-Process -Name "Codex Web GPT" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 3. Đóng gói đè vào app.asar
node "d:\ANNAM\AI\codex-chatgpt-web-cockpit\scripts\update-app-asar.cjs"
Start-Sleep -Seconds 1

# 4. Khởi động lại ứng dụng
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"C:\Users\MIIKEY\AppData\Local\Programs\Codex Web GPT\Codex Web GPT.exe"' }
```

---

## 6. Thiết Lập Chia Sẻ Mạng Cho Client Ngoài (Laptop / LAN / Tailscale)

* **Địa chỉ IP máy chủ:** `192.168.1.27` (LAN Wi-Fi) hoặc `100.73.82.82` (Tailscale)
* **Cổng dịch vụ:** `54005`
* **API Key:** `agt_codex_them1Qi6cKnc4sVDZnL2ogWBMIXLX5TB`
* **Cấu hình trên Laptop (`~/.codex/config.toml`):**
  ```toml
  model_provider = "codex_local_access"
  model = "chatgpt-web/high"

  [model_providers.codex_local_access]
  name = "Codex API Service"
  base_url = "http://192.168.1.27:54005/v1"
  wire_api = "responses"
  requires_openai_auth = true
  experimental_bearer_token = "agt_codex_them1Qi6cKnc4sVDZnL2ogWBMIXLX5TB"
  supports_websockets = false
  http_headers = { x-openai-actor-authorization = "cockpit-tools", x-agtools-disable-image-generation = "chat", x-cockpit-instance-id = ".codex" }
  ```
* **Lưu ý xác thực client:** Chỉ cần copy file `auth.json` từ PC sang Laptop (`%USERPROFILE%\.codex\auth.json`) để client nhận diện đăng nhập mà không cần xác thực lại.
