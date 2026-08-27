# ⚡ Harness Executor

<a href="https://github.com/article-hub-studio"><img src="https://github.com/article-hub-studio.png?size=56" width="40" height="40" alt="author avatar" style="border-radius:50%"></a> **by article-hub-studio** (upio labs) · [Releases](https://github.com/article-hub-studio/harness-executor/releases) · APK Android ký sẵn

Self-hosted **MCP control plane** chạy 1 lệnh trên Linux / VPS / macOS / Termux — không cần máy tính từ xa riêng:

```bash
curl -fsSL https://raw.githubusercontent.com/article-hub-studio/harness-executor/main/install.sh | bash
```

WebUI mobile-first (PWA + APK) theo phong cách **OpenCode WebUI** · backend Node.js **zero-dependency**.
Registry **chuyên Luau + LSP**, 100% MCP THẬT: **10 MCP servers** (không có server mô phỏng nào),
**10 plugins** (mỗi plugin một behavior chạy thật trong pipeline), **13 skills** — cộng environment
auto-builder, custom model hub (OpenAI-compatible) và điều phối đa-agent.

```
┌──────────────────────────────────────────────────────────┐
│  📱 PWA (web/) — vanilla JS, dark-first, offline-ready    │
│   Home · Hub(MCP/Plugins/Skills) · Agents · Chat · Settings│
└───────────────▲──────────────────────────────────────────┘
                │ REST + SSE (/api/events) · OpenAI-compatible /v1
┌───────────────┴──────────────────────────────────────────┐
│  🖥 server/index.js — Node ≥20, KHÔNG npm dependency      │
│   ├ executor/   MCP Executor core: connect·invoke·audit   │
│   ├ mcp/luau-mcp/  MCP server BUNDLED bọc binary luau-lsp │
│   ├ registry/   mcps(10 thật)·plugins(10)·skills(13)      │
│   ├ envbuilder/ quét + tự sửa môi trường, stream log      │
│   ├ modelhub/   provider tuỳ chỉnh + ox-local-mock        │
│   └ subagents/  orchestrator plan→tool→observe→final      │
└──────────────────────────────────────────────────────────┘
```

## 🚀 Khởi động nhanh

```bash
node server/index.js          # hoặc: ./start.sh  hoặc: npm start
# ➜ http://localhost:8787     (đổi cổng: PORT=3000 node server/index.js)
```

**Tự động khi mở app**: server chạy Environment Builder (tạo thư mục, ghi `.env`, dọn tmp) → **tự bật các MCP executor có `autoStart`** (`luau-lsp`, `lsp-universal`, `mcp-filesystem`) ở chế độ nền, không chặn boot → vào thẳng Home. Theo dõi qua `GET /api/boot` (trường `autoStart: {total, ok, failed, ms}`) và SSE event `boot`.

Mở trên điện thoại cùng mạng Wi‑Fi: `http://<IP-máy-tính>:8787`.
Kiểm thử toàn bộ hệ thống:

```bash
npm run smoke                 # cần server đang chạy
npm run generate              # sinh lại data/*.json (10 MCP thật / 10 plugin / 13 skill)
npm run icons                 # sinh lại icon PNG cho PWA (trắng–đen)
npm run build-icons           # tái sinh web/js/icons.js (cần: npm i --no-save @iconify-json/solar @iconify-json/heroicons)
```

## 📲 Cài PWA lên điện thoại

- **iOS (Safari)**: nút Share → *Add to Home Screen*.
- **Android (Chrome)**: menu ⋮ → *Install app* / *Add to Home screen*.
- Service worker cache static → mở lại được cả khi offline; API vẫn cần server.

## 🤖 Terminal tự động — permission 3 mức + Shizuku

Tab **Term** (kiểu agent tự động như OpenClaw/anyclaw):

- **Terminal riêng** — mỗi session một console độc lập
- **Folder riêng** — mỗi session có workspace riêng `workspace/terminals/<id>` (lệnh chạy trong đó, `HOME` trỏ vào folder)
- **Permission 3 mức**:
  - 🟢 *An toàn* (`ls`, `cat`, `git status`, `node -v`…) → chạy ngay
  - 🟡 *Nguy hiểm* (`npm install`, `curl`, `chmod`, `rm`, `sudo`, `git push`…) → hiện thẻ phải bấm **Duyệt** trong 60s (hoặc Từ chối), qua SSE realtime
  - 🔴 *Luôn cấm* (`rm -rf /`, `mkfs`, `dd if=`, fork bomb, shutdown…) → chặn trước khi chạy
- **Shizuku** (Android/Termux): bật trong Settings hoặc checkbox trong Term → lệnh chạy qua `rish` với quyền shell cao không cần root. Hướng dẫn cài ngay trong Settings → Shizuku.

## 🔐 APK ký CỐ ĐỊNH — update là xong, không cần gỡ app
Từ **v1.2.0**, mọi APK release được ký bằng **cùng một keystore bền vững** (PKCS12, RSA 4096, hạn 30 năm) lưu trong repo secrets. Nghĩa là:
- Tải APK mới → cài đè lên bản cũ → **giữ nguyên dữ liệu, không cần uninstall**
- Chữ ký SHA-256: `6E:45:41:EE:3E:1E:3C:E6:61:40:6D:05:54:49:08:1E:0E:88:BC:40:EF:44:2E:6C:6C:91:6E:3B:23:F4:54:B0`

> Các bản ≤ v1.1.8 dùng key ephemeral (mỗi lần build một key khác) nên **lần cuối cùng** bạn cần gỡ app cũ rồi cài v1.2.0. Từ v1.2.0 trở đi update trực tiếp.

## 🌐 Song ngữ VI / EN
Mở **Settings → Ngôn ngữ / Language** → chọn 🇬🇧 EN để chuyển toàn bộ giao diện sang tiếng Anh (VI là mặc định). APK launcher tự dò ngôn ngữ máy.

## 📱 Mở app là TỰ ĐỘNG (APK)
1. Mở app → **tự dò** server đã lưu · `127.0.0.1:8787` (Termux cùng máy) → thấy là **tự kết nối**, khỏi gõ gì
2. Chưa có server? Card **"Cài tự động qua Termux"** hiện sẵn → bấm 1 nút: app gửi lệnh cài vào Termux qua RUN_COMMAND (cấp quyền lần đầu) → **tự tạo environment + tự chạy lệnh + auto-boot + tự connect** (~90s lần đầu)
3. Lần sau mở app: server chạy nền sẵn → vào thẳng giao diện điều khiển

## 🖥 Self-host 1 lệnh — không cần máy tính riêng

Chạy thẳng trên **Linux / VPS / macOS / Termux (chính điện thoại Android)**:

```bash
curl -fsSL https://raw.githubusercontent.com/article-hub-studio/harness-executor/main/install.sh | bash
```

Script tự làm mọi thứ: kiểm tra/cài Node.js ≥20 (apt · dnf · pacman · brew · Termux pkg · binary tĩnh),
clone repo về `~/harness-executor`, sinh registry, mở server. **Không npm install** — backend zero-dependency.

Tuỳ chọn:

```bash
... | bash -s -- --port 8787        # đổi cổng
... | bash -s -- --dir ~/he         # đổi thư mục cài
... | bash -s -- --daemon           # chạy nền (nohup, log tại harness.log)
... | bash -s -- --service          # systemd user service (tự khởi động lại)
```

### Cập nhật bản mới

Chạy lại **đúng lệnh cài ở trên** — script sẽ `git pull`, giữ nguyên dữ liệu (`data/state.json`,
`data/models.json`, `workspace/`), rồi so phiên bản trên đĩa với phiên bản mà tiến trình đang chạy:

- Khác nhau → **tự dừng bản cũ và khởi động lại bản mới** (systemd thì `systemctl --user restart`).
- Giống nhau → báo "ĐANG CHẠY SẴN" và không spawn trùng.

Chỉ tiến trình vừa giữ đúng cổng `--port` vừa thuộc đúng thư mục `--dir` mới bị dừng, nên
nhiều instance ở các cổng khác nhau vẫn an toàn. Muốn dừng tay:

```bash
kill $(cat ~/harness-executor/harness.pid)      # bản --daemon
systemctl --user stop harness                   # bản --service
```

## 📲 App Android (APK) — build & ký tự động

Repo có sẵn workflow GitHub Actions (`.github/workflows/release.yml`):

```bash
# Release bản mới — chỉ cần đẩy tag:
git tag v1.0.1 && git push origin v1.0.1   # hỗ trợ tới v9.9.9
# hoặc chạy tay: Actions → Release Android APK → Run workflow → nhập version
```

CI sẽ: sync Capacitor → build APK release trên runner → **ký tự động** (dùng repo secrets
`ANDROID_KEYSTORE_B64`/`ANDROID_STORE_PASSWORD`/`ANDROID_KEY_ALIAS`/`ANDROID_KEY_PASSWORD`
nếu có, không có thì tự sinh keystore ephemeral — APK vẫn cài được, chỉ cần gỡ bản cũ khi lên version mới)
→ tạo **GitHub Release** kèm file `harness-executor-vX.Y.Z.apk`.

App mở ra là màn launcher đen–trắng: nhập địa chỉ harness server (vd `http://192.168.1.10:8787`) →
Kết nối → load UI mới nhất trực tiếp từ server (cập nhật tính năng không cần cài lại APK).

Dự án native nằm ở `mobile/android` (Capacitor 6, appId `com.upio.executor`,
`usesCleartextTraffic=true` cho HTTP LAN).

## 🧩 Tính năng

| Khu vực | Mô tả |
|---|---|
| **Hub** | 10 MCP thật + 10 plugins + 13 skills (category `luau`/`lsp`/`workspace`/`security`): tìm kiếm, lọc, bottom-sheet chi tiết, connect/disconnect, gọi tool với form sinh tự từ JSON Schema, toggle plugin, chạy skill xem tiến độ từng bước realtime |
| **Agents** | Spawn subagent runtime: chọn task, số bước, tools từ server đã connect, model — xem timeline thought/action/observation, cancel bất cứ lúc nào |
| **Chat** | Dòng thời gian kiểu OpenCode: mỗi lượt là một *part* phẳng có rail bên trái (user / assistant / tool), stream typewriter qua `/v1/chat/completions` chuẩn OpenAI, tool-call thật hiện thành khối riêng có header + output mono |
| **Settings** | Environment doctor (scan/build/repair kèm log console trực tiếp), quản lý model provider (baseUrl/key/model, Test latency), About |

### Registry Luau + LSP — 100% MCP THẬT (v1.3)
Không còn server mô phỏng nào. Mọi entry đều là tiến trình MCP thật qua stdio JSON-RPC 2.0:

| Server | Category | Nguồn | Ghi chú |
|---|---|---|---|
| **luau-lsp** (bundled, autoStart) | luau | `server/mcp/luau-mcp/` — bọc binary [`luau-lsp`](https://github.com/JohnnyMorganz/luau-lsp) | 8 tool: `luau_analyze`, `luau_check_source`, `luau_require_graph`, `luau_document_symbols`, `luau_hover`, `luau_definition`, `luau_lint_rules`, `luau_version`. Cần `luau-lsp` trong PATH (`npm i -g luau-lsp`), thiếu thì tự dùng `npx` |
| **lsp-universal** (autoStart) | lsp | `npx -y @theupsider/lsp-mcp` | 13 tool LSP cho 14 ngôn ngữ: definition, references, diagnostics, rename, code action, formatting |
| **lsp-bridge** | lsp | `npx -y lsp-mcp-server` | 29 tool, bridge LSP chi tiết hơn |
| **roblox-executor** | luau | [GitLab upio](https://gitlab.com/upio/roblox-executor-mcp) | Cài 1 nút trong Hub (git clone + build); cần Roblox client |
| **roblox-studio** · **roblox-studio-weppy** | luau | `npx -y roblox-mcp-pro` · `npx -y @weppy/roblox-mcp` | Soi DataModel, script, instance trong Studio |
| **mcp-filesystem** (autoStart) · **mcp-git** · **mcp-memory** · **mcp-sequential-thinking** | workspace | `@modelcontextprotocol/*` chính chủ | Mở/tìm file Luau, xem diff, ghi nhớ, chia bước suy luận |

Tool ghi/thực thi trên server thật luôn yêu cầu cờ **approved**; tool chỉ-đọc (`luau_*`, `lsp_definition`, `read_file`, `git_status`…) chạy ngay.

### Plugins — 10/10 có hành vi thật
Mỗi plugin gắn một behavior chạy thật trong pipeline invoke: `validate-required`, `trim-strings`,
`defaults-fill`, `clip-output`, `flatten-error`, `annotate-meta`, `rate-limit`, `snapshot-args`,
`redact-input`, `redact-output`. Ví dụ `luau-arg-guard` chặn `luau_check_source` khi thiếu `source`.

### Skills — 13 pipeline Luau/LSP
`luau-type-audit`, `luau-snippet-review`, `luau-symbol-map`, `luau-hover-explain`, `lsp-workspace-health`,
`lsp-symbol-hunt`, `lsp-refactor-plan`, `lsp-api-surface`, `roblox-script-audit`, `roblox-studio-inspect`,
`luau-lint-config`, `workspace-luau-scan`, `env-doctor`. Mỗi step `tool` đều trỏ tới tool có thật trên
một server trong registry (script `generate-registries.js` assert điều này khi sinh).

### Agent AI Workspace
Tab Agents → segment **Workspace**: trò chuyện nhiều lượt với agent — gửi task, xem timeline thought/action/observation trực tiếp, rồi **nhắn tiếp** ("chi tiết hơn nhé") để agent chạy bổ sung với đầy đủ ngữ cảnh. Câu trả lời render **markdown** đầy đủ (code block có nút Copy).


### Executor core
- Mọi tool call đi qua **plugin pipeline** (`preInvoke`/`postInvoke`), ghi **audit** vào `data/audit.jsonl`, timeout 15s.
- Transport: `stdio` (spawn tiến trình MCP thật, JSON-RPC 2.0) và `http` (POST JSON-RPC). Transport `builtin` mô phỏng đã bị **xoá hoàn toàn**.
- Tool ghi/thực thi yêu cầu `approved:true`; tool chỉ-đọc theo whitelist chạy ngay.

### Model Hub
- Provider mặc định **ox-local-mock**: trả lời có cấu trúc tiếng Việt/Anh, chạy hoàn toàn offline, hỗ trợ streaming.
- Thêm provider **OpenAI-compatible** bất kỳ (OpenAI, DeepSeek, Ollama, vLLM…) trong Settings → Test → đặt mặc định.

### Environment auto-builder
- Scan: node/npm/python3/git/curl/disk/RAM/port/data dirs/.env/registries.
- Build: tạo thư mục, ghi `.env`, dọn tmp, state.json — stream log qua SSE event `env`.

## 🔌 API chính

| Endpoint | Ý nghĩa |
|---|---|
| `GET /api/status` | sức khoẻ hệ thống + counts |
| `GET /api/mcps` · `/api/mcps/:id` | danh sách/chi tiết server (+`?q=&category=`) |
| `POST /api/mcps/:id/connect|disconnect` | kết nối transport |
| `POST /api/invoke` `{server,tool,args}` | gọi tool qua pipeline |
| `GET /api/plugins` · `POST /api/plugins/:id/toggle` | plugin registry |
| `GET /api/skills` · `POST /api/skills/:id/run` | skills + chạy streaming |
| `GET /api/env` · `POST /api/env/build` | environment scan/build |
| `GET /api/models` · `PUT /api/models/config` · `POST /api/models/test` | model hub |
| `POST /v1/chat/completions` | **OpenAI-compatible** (stream SSE OK) |
| `GET/POST /api/agents` · `GET /api/agents/:id` · `POST .../cancel` | orchestrator |
| `GET /api/audit?tail=N` | N tool-call gần nhất từ `data/audit.jsonl` |
| `GET /api/events` | SSE: `log`,`skill-run`,`env`,`agent-step`,`mcp`,`plugin`,`boot`,`term`,`perm` |

Đặc tả đầy đủ: [`docs/SPEC.md`](docs/SPEC.md).

## 📁 Cấu trúc

```
server/index.js            HTTP + wiring (PORT=8787)
server/src/…               executor · registry · envbuilder · modelhub · subagents · router · sse
web/                       PWA: index.html · css/app.css · js/{app,api}.js · js/views/* · sw.js
server/mcp/luau-mcp/       MCP server bundled bọc binary luau-lsp (zero-dep)
data/                      mcps.json(10) · plugins.json(10) · skills.json(13) · state.json · audit.jsonl
scripts/                   generate-registries.js · gen-icons.js · smoke-test.js
docs/SPEC.md               hợp đồng kỹ thuật đầy đủ
```

## 🔒 Lưu ý bảo mật

Server dành cho môi trường local/LAN tin cậy: **chưa có auth**, không exposing ra internet công cộng.
Tool "nguy hiểm" luôn cần cờ `approved` — UI hiển thị checkbox tương ứng.

---
Made with ⚡ by upio labs · zero-dependency philosophy: chỉ cần Node ≥ 20.
