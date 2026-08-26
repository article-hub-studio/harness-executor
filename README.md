# ⚡ Harness Executor

<a href="https://github.com/article-hub-studio"><img src="https://github.com/article-hub-studio.png?size=56" width="40" height="40" alt="author avatar" style="border-radius:50%"></a> **by article-hub-studio** (upio labs) · [Releases](https://github.com/article-hub-studio/upio-mcp-executor-harness/releases) · APK Android ký sẵn

Self-hosted **MCP control plane** chạy 1 lệnh trên Linux / VPS / macOS / Termux — không cần máy tính từ xa riêng:

```bash
curl -fsSL https://raw.githubusercontent.com/article-hub-studio/upio-mcp-executor-harness/main/install.sh | bash
```

WebUI mobile-first (PWA + APK) · backend Node.js **zero-dependency**:
quản lý **98 MCP servers**, **143 plugins**, **41 skills**, environment auto-builder,
custom model hub (OpenAI-compatible) và điều phối đa-agent — tất cả tối ưu cho **mobile executor**.

```
┌──────────────────────────────────────────────────────────┐
│  📱 PWA (web/) — vanilla JS, dark-first, offline-ready    │
│   Home · Hub(MCP/Plugins/Skills) · Agents · Chat · Settings│
└───────────────▲──────────────────────────────────────────┘
                │ REST + SSE (/api/events) · OpenAI-compatible /v1
┌───────────────┴──────────────────────────────────────────┐
│  🖥 server/index.js — Node ≥20, KHÔNG npm dependency      │
│   ├ executor/   MCP Executor core: connect·invoke·audit   │
│   │  └ builtin-servers/  98 server mô phỏng chạy offline  │
│   ├ registry/   plugins(143)·mcps(98)·skills(41)          │
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

**Tự động khi mở app**: server tự chạy Environment Builder (tạo thư mục, ghi `.env`, dọn tmp) → **tự connect toàn bộ 98 MCP builtin (~0,3s)** → frontend hiện boot overlay tiến độ rồi vào thẳng Home. Theo dõi qua `GET /api/boot` và SSE event `boot`.

Mở trên điện thoại cùng mạng Wi‑Fi: `http://<IP-máy-tính>:8787`.
Kiểm thử toàn bộ hệ thống:

```bash
npm run smoke                 # cần server đang chạy
npm run generate              # sinh lại data/*.json (98/143/41 — deterministic)
npm run icons                 # sinh lại icon PNG cho PWA (trắng–đen)
npm run build-icons           # tái sinh web/js/icons.js (cần: npm i --no-save @iconify-json/solar @iconify-json/heroicons)
```

## 📲 Cài PWA lên điện thoại

- **iOS (Safari)**: nút Share → *Add to Home Screen*.
- **Android (Chrome)**: menu ⋮ → *Install app* / *Add to Home screen*.
- Service worker cache static → mở lại được cả khi offline; API vẫn cần server.

## 🖥 Self-host 1 lệnh — không cần máy tính riêng

Chạy thẳng trên **Linux / VPS / macOS / Termux (chính điện thoại Android)**:

```bash
curl -fsSL https://raw.githubusercontent.com/article-hub-studio/upio-mcp-executor-harness/main/install.sh | bash
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

Cập nhật bản mới? Chạy lại đúng lệnh trên — script `git pull` + giữ nguyên dữ liệu.

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
| **Hub** | 98 MCP servers + 143 plugins + 41 skills: tìm kiếm, lọc theo category, bottom-sheet chi tiết, connect/disconnect, gọi tool với form sinh tự từ JSON Schema, toggle plugin, chạy skill xem tiến độ từng bước realtime |
| **Agents** | Spawn subagent runtime: chọn task, số bước, tools từ server đã connect, model — xem timeline thought/action/observation, cancel bất cứ lúc nào |
| **Chat** | Giao diện chat stream typewriter qua `/v1/chat/completions` chuẩn OpenAI |
| **Settings** | Environment doctor (scan/build/repair kèm log console trực tiếp), quản lý model provider (baseUrl/key/model, Test latency), About |

### MCP thật (v1.1)
Ngoài 98 server mô phỏng, harness tích hợp **8 MCP THẬT** qua stdio JSON-RPC chuẩn:

| Server | Nguồn | Cần |
|---|---|---|
| 🎮 **Roblox Executor MCP** (upio) | [GitLab](https://gitlab.com/upio/roblox-executor-mcp) — execute Lua, script inspection, remote spy, GUI, screenshot | Cài 1 nút trong Hub (git clone + build), Roblox client để chạy code |
| Memory · Sequential Thinking · Filesystem · Everything | `@modelcontextprotocol/*` chính chủ | Chỉ cần mạng lần đầu (npx) |
| GitHub · Brave Search · Slack | `@modelcontextprotocol/*` chính chủ | Nhập API key trong chi tiết MCP |

Tool nguy hiểm trên server thật (execute, post message…) luôn yêu cầu tick **approved**.

### Plugins có hành vi thật
131/143 plugin khi bật sẽ làm việc thật trong pipeline: validate-required, defaults-fill, trim-strings, rate-limit, snapshot-args, redact-input/output, clip-output, flatten-error, annotate-meta.

### Agent AI Workspace
Tab Agents → segment **Workspace**: trò chuyện nhiều lượt với agent — gửi task, xem timeline thought/action/observation trực tiếp, rồi **nhắn tiếp** ("chi tiết hơn nhé") để agent chạy bổ sung với đầy đủ ngữ cảnh. Câu trả lời render **markdown** đầy đủ (code block có nút Copy).


### Executor core
- Mọi tool call đi qua **plugin pipeline** (`preInvoke`/`postInvoke`), ghi **audit** vào `data/audit.jsonl`, timeout 15s.
- Transport: `builtin` (mô phỏng offline, deterministic), `stdio` (spawn tiến trình MCP thật, JSON-RPC 2.0), `http` (POST JSON-RPC).
- Tool nguy hiểm (`fs.write_file`, `ops.deploy`, `chain.send_tx`…) yêu cầu `approved:true`.

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
| `GET /api/events` | SSE: `log`,`skill-run`,`env`,`agent-step`,`mcp`,`plugin` |

Đặc tả đầy đủ: [`docs/SPEC.md`](docs/SPEC.md).

## 📁 Cấu trúc

```
server/index.js            HTTP + wiring (PORT=8787)
server/src/…               executor · registry · envbuilder · modelhub · subagents · router · sse
web/                       PWA: index.html · css/app.css · js/{app,api}.js · js/views/* · sw.js
data/                      mcps.json(98) · plugins.json(143) · skills.json(41) · state.json · audit.jsonl
scripts/                   generate-registries.js · gen-icons.js · smoke-test.js
docs/SPEC.md               hợp đồng kỹ thuật đầy đủ
```

## 🔒 Lưu ý bảo mật

Server dành cho môi trường local/LAN tin cậy: **chưa có auth**, không exposing ra internet công cộng.
Tool "nguy hiểm" luôn cần cờ `approved` — UI hiển thị checkbox tương ứng.

---
Made with ⚡ by upio labs · zero-dependency philosophy: chỉ cần Node ≥ 20.
