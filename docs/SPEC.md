# upio Mobile MCP Executor Harness — SPEC (bản hợp đồng kỹ thuật)

> Mọi module PHẢI tuân thủ chính xác hợp đồng dưới đây. Không thêm dependency npm
> nào (zero-dependency, chỉ dùng node: core modules). Node >= 20, ESM ("type":"module").

## 1. Tổng quan

WebUI mobile-first (PWA) + backend Node.js cho **upio MCP Executor**:

- **10 MCP servers THẬT** trong registry (`data/mcps.json`) — chuyên **Luau + LSP**, mọi entry `real:true` và
  `transport:'stdio'`; tools lấy từ `tools/list` thật khi kết nối. KHÔNG còn server mô phỏng.
- **10 plugins** (`data/plugins.json`) — middleware pipeline quanh mọi tool call, mỗi plugin có `behavior` thật.
- Ba server có `autoStart:true` (`luau-lsp`, `lsp-universal`, `mcp-filesystem`) được **bật tự động khi boot**.
- **Skills** (`data/skills.json`) — quy trình nhiều bước (model / tool) chạy streaming.
- **Environment auto-builder** — quét & sửa môi trường, stream log.
- **Model Hub** — provider tùy chỉnh chuẩn OpenAI-compatible + mock model nội bộ.
- **Agent Orchestrator** — spawn subagent runtime, vòng lặp plan→tool→observe→final.

## 2. Cấu trúc thư mục & chủ sở hữu

| Đường dẫn | Chủ sở hữu |
|---|---|
| `server/index.js`, `server/src/router.js`, `server/src/sse.js` | MAIN (không đụng) |
| `server/src/executor/executor.js`, `mcp-client.js`, `server/src/registry/registry.js` | SA-core |
| `server/mcp/luau-mcp/**` | MCP server bundled bọc binary `luau-lsp` (zero-dep) |
| `server/src/envbuilder/**` | SA-env |
| `server/src/modelhub/**` | SA-model |
| `server/src/subagents/**` | SA-agents |
| `web/**` | SA-web |
| `scripts/**`, `data/**`, `docs/**`, `README.md`, `start.sh` | MAIN |

## 3. Kiểu dữ liệu chung (JSDoc)

```js
/** @typedef {{name:string, description:string, inputSchema:object}} McpTool */
/** @typedef {{id:string, name:string, category:string, description:string, version:string,
 *             author:string, icon:string, transport:'stdio'|'http',
 *             command?:string, args?:string[], url?:string, tags:string[], stars:number,
 *             real:boolean, autoStart?:boolean, toolPreview?:string[],
 *             install?:{method:'bundled'|'git-clone'|'npx',dir?:string,entry?:string,repo?:string},
 *             tools:McpTool[]}} McpDescriptor */
/** @typedef {{id:string, name:string, category:string, version:string, description:string,
 *             icon:string, permissions:string[], hooks:string[], enabled:boolean,
 *             popularity:number, behavior:string}} Plugin */
/** @typedef {{type:'model'|'tool'|'note', prompt?:string, server?:string, tool?:string,
 *             argsTemplate?:object}} SkillStep */
/** @typedef {{id:string, name:string, description:string, icon:string, tags:string[],
 *             inputs:{key:string,label:string,placeholder?:string}[], steps:SkillStep[]}} Skill */
/** @typedef {{ok:boolean, result?:any, error?:string,
 *             meta:{server:string, tool:string, durationMs:number, mocked:boolean}}} ToolResult */
```

## 4. REST API (tất cả JSON; lỗi → `{error}` + status 4xx/5xx)

- `GET  /api/status` → `{ok:true, name, version, uptimeSec, counts:{plugins,mcps,skills}, env:{node,platform}, connectedMcps:number}`
- `GET  /api/plugins?q=&category=` → `{total, items:Plugin[]}`
- `GET  /api/plugins/:id` → `Plugin`
- `POST /api/plugins/:id/toggle` body `{enabled:boolean}` → `Plugin`
- `GET  /api/mcps?q=&category=&status=` → `{total, items:(McpDescriptor&{state})[]}` (state: `connected|disconnected`)
- `GET  /api/mcps/:id` → chi tiết đầy đủ kèm `tools`; server thật có thêm `installed:boolean`
- `POST /api/mcps/:id/install` → cài server thật (git clone + build), log stream qua SSE `log` (`payload.install===true`) → `{ok,logs}`
- `PUT  /api/mcps/:id/env` body `{env:{KEY:value}}` → lưu env cho server thật (GitHub/Brave/Slack…) → `{ok}`
- `POST /api/mcps/:id/connect` → `{id, state:'connected', tools:McpTool[]}` — LUÔN thử `tools/list` thật, lỗi → 502 `{error}` (không có fallback mô phỏng)
- `POST /api/mcps/:id/disconnect` → `{id, state:'disconnected'}`
- `POST /api/invoke` body `{server, tool, args, approved?}` → `ToolResult` (đi qua plugin pipeline + audit)
- `GET  /api/skills` → `{total, items:Skill[]}`; `GET /api/skills/:id`
- `POST /api/skills/:id/run` body `{input:object}` → `{runId}` ; tiến độ qua SSE event `skill-run`
- `GET  /api/env` → `{checks:[{id,label,status,detail,version?}], summary:{pass,warn,fail}}`
- `POST /api/env/build` body `{repair?:boolean}` → `{buildId}` ; log qua SSE event `env`
- `GET  /api/models` → `{models:[{id,provider,label,available}], config}` 
- `PUT  /api/models/config` body full config → `{ok}`
- `POST /api/models/test` body `{provider}` → `{ok, latencyMs, detail}`
- `POST /v1/chat/completions` — **OpenAI-compatible** (hỗ trợ `stream:true` trả SSE định dạng OpenAI). Model mặc định khi thiếu: `ox-local-mock`.
- `GET  /api/agents` → `{items:[{id,name,task,status,stepsDone,model,createdAt}]}`; `POST /api/agents` body `{task, name?, model?, maxSteps?, tools?:[{server,tool}]}` → `{id}`
- `GET  /api/agents/:id` → `{id,...,steps:[...],session:[{role,text,at}],followUps,answer?}`
- `POST /api/agents/:id/say` body `{message}` → agent chạy TIẾP multi-turn (Agent AI Workspace) → `{ok,id}`; lỗi trạng thái → 409
- `POST /api/agents/:id/cancel` → `{ok}`
- `GET  /api/audit?tail=N` → `{total, items:[{ts,server,tool,args,ok,error?,durationMs,source,pluginsApplied}]}` (N ≤ 500, mặc định 50)
- `GET  /api/events` — **SSE**, event types: `log`, `skill-run`, `env`, `agent-step`, `mcp`, `plugin`, `boot`, `term`, `perm`. Payload luôn JSON string. Gửi `retry: 3000`.
  - event `mcp` có 2 dạng: đổi trạng thái `{id, state, tools?}` và **tool-call** `{id, tool, ok, durationMs, args, detail}` (web Chat dựng part `tool` từ dạng thứ hai).
- `GET  /api/boot` → `{phase:'booting'|'ready'|'error', startedAt, finishedAt?, steps:[{name,status,ms?,detail?}], autoStart:{total,ok,failed:string[],done,ms}, error?}` — server tự chạy `EnvBuilder.build(repair)` rồi bật **các MCP có `autoStart`** ở chế độ NỀN (không chặn `phase:'ready'`); tiến độ phát qua SSE `boot` và `log`.

## 5. Hợp đồng từng module

### 5.1 `registry.js` — export `loadRegistries(dataDir)` và class `Registry`
- `new Registry(dataDir)`: đọc 3 file JSON trên; `await init()`.
- API: `plugins(filter)`, `plugin(id)`, `setPluginEnabled(id,bool)`, `mcps(filter)`, `mcp(id)`, `skills(filter)`, `skill(id)`, `counts()`.
- Filter `{q, category, status}`: q khớp name/description (không phân biệt hoa thường).
- Trạng thái enabled/override lưu `data/state.json` (ghi bất đồng bộ an toàn).

### 5.2 `mcp-client.js` — export các factory
- `createStdioTransport({command,args})` → spawn process, JSON-RPC 2.0 line-delimited (MCP stdio), handshake `initialize`, timeout 10s mỗi call; `{kind:'stdio',...}`.
- `createHttpTransport({url, headers})` → JSON-RPC qua HTTP POST (MCP streamable-http tối giản); `{kind:'http',...}`.
- Mọi transport: `call()` → `ToolResult`.

### 5.3 `executor.js` — export `class Executor extends EventEmitter`
- `constructor({dataDir})`; `init()` nạp Registry.
- MCP: `connect(id)`, `disconnect(id)`, `isConnected(id)`, `connectedCount()`, `getTools(id)`.
- `invoke(server, tool, args, ctx={source:'web'})`:
  1. server phải đã connect (trừ ctx.force);
  2. chạy hook `preInvoke` của plugin enabled (có thể sửa args);
  3. gọi transport → ToolResult;
  4. hook `postInvoke`; emit `'log'` + ghi append `data/audit.jsonl`;
  5. timeout 15s → `{ok:false,error:'timeout'}`.
- Plugins: `plugins(filter)`, `togglePlugin(id,enabled)`; filter hỗ trợ `{id}` khớp chính xác 1 kết quả.
- **Passthrough bắt buộc**: `mcps(filter)`, `mcp(id)`, `skills(filter)`, `skill(id)` — delegate thẳng Registry (kết quả mcp có thêm `state` theo isConnected).
- Skills: `runSkill(id, input, emit)` → runId; từng step emit `emit('skill-run',{runId,i,total,type,status,detail})`. Step `model` → `ctx.modelHub.chat(...)`, step `tool` → `this.invoke(...)`; lỗi step không dừng run (status:'error').
- `stats()` → counts, connectedMcps, invocations, lastAudit(20).

### 5.4 `server/mcp/luau-mcp/index.js` — MCP server bundled (zero-dep)
- MCP stdio JSON-RPC 2.0 chuẩn: `initialize` (`protocolVersion:'2024-11-05'`) → `notifications/initialized` → `tools/list` / `tools/call`.
- 8 tool THẬT bọc binary `luau-lsp`: `luau_analyze`, `luau_check_source`, `luau_require_graph`,
  `luau_document_symbols`, `luau_hover`, `luau_definition`, `luau_lint_rules`, `luau_version`.
- `resolveLuau()`: ưu tiên `LUAU_LSP_BIN` → `luau-lsp` trong PATH → `npx -y luau-lsp` (chậm, chỉ khi thiếu).
- Hover/definition/documentSymbol đi qua `LspSession` (LSP framing `Content-Length: N\r\n\r\n`); tool nhận
  dòng/cột **1-based** rồi tự trừ 1 khi gửi LSP (LSP dùng 0-based).
- `denoise()` lọc bỏ dòng nhiễu (`WARNING: --platform`, `[WARN] No definitions file`, `[INFO] sourcemap is disabled`);
  `platformArgs()` mặc định `--platform=standard`.

### 5.5 `envbuilder.js` — export `class EnvBuilder`
- `scan()` → report như API (kiểm tra: node, npm, python3, pip, git, curl, RAM, disk, PORT trống, data dirs, .env).
- `async build({repair}, emit)` → tạo thư mục data/*, ghi `.env` từ mẫu nếu thiếu, check/cấp quyền, dọn tmp, state.json; `emit('env',{level,line})` từng dòng log; trả `{ok, applied:string[], logs:string[]}`.

### 5.6 `modelhub.js` — export `class ModelHub`
- Config persist `data/models.json`: `{default:'ox-local-mock', providers:[{id,label,baseUrl,apiKey,model}]}`.
- `listModels()` → gộp mock + providers; `chat({messages, model, temperature, stream}, onChunk)` → `{content, usage:{prompt_tokens,completion_tokens}}` (stream thì vẫn trả tổng sau khi bơm chunk `{delta}` qua onChunk).
- Provider `ox-local-mock`: KHÔNG cần network — sinh câu trả lời có cấu trúc, hữu ích, phản ánh tin nhắn cuối (dùng được offline, deterministic).
- Provider ngoài: POST `{baseUrl}/chat/completions` chuẩn OpenAI, parse cả stream SSE lẫn JSON.
- `handleChatCompletion(body)` → `{status, headers, body|string}` sẵn cho router (stream → SSE text).
- `testProvider(id)` → ping thật 1 prompt nhỏ, đo latencyMs.

### 5.7 `orchestrator.js` — export `class AgentOrchestrator extends EventEmitter`
- `spawn({task,name,model,maxSteps=6,tools=[]})` → `{id}` (ag-xxxx); tự chạy nền.
- Vòng đời mỗi bước: dựng prompt hệ thống (task + danh sách tools + lịch sử quan sát) → `modelHub.chat` yêu cầu JSON `{thought, action:{type:'tool'|'final', server?, tool?, args?, answer?}}` → parse (tolerant: tách JSON khỏi text) → nếu 'tool': `executor.invoke` rồi emit `'agent-step'` {id, i, thought, action, observation}; nếu 'final' hoặc hết maxSteps → set `answer`, status 'done'.
- Mock-model fallback planner: chọn tool khớp từ khóa từ `tools`, sinh args mẫu từ inputSchema, sau ≥2 lần gọi tool hoặc không còn tool phù hợp → final tóm tắt observations.
- `cancel(id)` (status 'cancelled'), `get(id)`, `list()`.

### 5.8 Frontend `web/` (SA-web)
Vanilla ES modules, KHÔNG framework, KHÔNG build. Trang shell `index.html` + `css/app.css` + `js/app.js` (+ view modules). Mobile-first:

- Tab bar dưới **6 mục**: Home · Hub · Agents · Term · Chat · Settings (safe-area, ≥44px, `display:flex` + chỉ báo trượt — KHÔNG dùng `repeat(N,1fr)` cứng để thêm/bớt tab không lệch).
- **BẮT BUỘC**: mọi key trong `ROUTES` của `app.js` phải có `<section id="view-<key>">` trong `index.html` VÀ một `data-route="<key>"` trong tab bar. View KHÔNG được tự bọc thêm `class="view"` (thẻ lồng không có `.active` → `display:none` → tab trắng trơn).
- **Home**: wordmark mono + status line (autoStart, số MCP đã bật, uptime, node), panel **MCP executor** liệt kê từng server (mốc on/off, tag AUTO, số tool thật), panel registry dạng key/value mono, quick actions, activity stream mono realtime (SSE `log`).
- **Hub**: segmented control [MCPs | Plugins | Skills] + ô tìm kiếm + chip lọc category; danh sách card (icon, tên, mô tả, badge); bottom-sheet chi tiết: MCP → connect/disconnect + list tools + form invoke (JSON args) hiện kết quả; Plugin → toggle switch + permissions; Skill → form inputs + Run (xem tiến độ từng bước trực tiếp).
- **Agents**: form tạo agent (task textarea, số bước, chọn tools từ MCP đã connect, model), danh sách agent với progress, xem chi tiết từng step thought/action/observation, cancel.
- **Chat**: dòng thời gian kiểu **OpenCode WebUI** — mỗi lượt là một `.part[data-role=user|assistant|tool]` gồm rail bên trái (`.part-mark` + `.part-bar`) và nội dung phải; văn bản là khối phẳng `.part-text` (viền 1px, bo 4px) chứ KHÔNG phải bubble; tool-call thật (SSE `mcp` có `tool`) render thành `.tool-block` (header `.tool-head` + output mono `.tool-body`). Stream typewriter qua `/v1/chat/completions`, chọn model từ `/api/models`.
- **Settings**: Environment (nút Scan/Build + checklist pass/warn/fail), Models (thêm/sửa provider OpenAI-compatible, Test), About.
- PWA: `manifest.webmanifest`, `sw.js` (cache-first cho static, network cho /api), CSS custom properties, skeleton loading, toast.
- **Design tokens theo OpenCode WebUI** (`sst/opencode` → `packages/web/src/styles/custom.css`), warm-neutral hsl chứ không phải #fff/#000:
  light `--bg: hsl(0,20%,99%)` · `--surface-2: hsl(0,8%,97%)` · `--text: hsl(0,5%,12%)` · `--text-dim: hsl(0,1%,39%)` · `--border-strong: hsl(30,2%,81%)`;
  dark `--bg: hsl(0,9%,7%)` · `--surface: hsl(0,6%,10%)` · `--text: hsl(0,15%,94%)` · `--border-strong: hsl(0,3%,28%)`;
  accent `--hi: hsl(62,84%,88%)` (light) / `hsl(62,100%,90%)` (dark) — vàng chanh, dùng cho chip/segment active và vạch featured.
  Bán kính `--r-md: 4px` (0.25rem), `--shadow-1: none`. Mọi meta/nhãn phụ dùng `var(--mono)` cỡ 11–12px.
- **KHÔNG emoji trong chrome UI**: mọi `icon` trong `data/*.json` phải là key có thật trong `web/js/icons.js` (99 icon Solar + Heroicons-Blade, sinh bởi `scripts/build-icons.js`); smoke test assert điều này.
- Boot overlay: khi mở app, nếu `/api/boot.phase !== 'ready'` hiện màn hình setup với log trực tiếp, fade out khi ready. Watchdog trong `index.html` CHỈ reload khi `window.__UPIO_BOOTED` còn false (nếu không sẽ thành vòng lặp reload vô hạn).
- `api.js` trung tâm gọi REST + SSE reconnect. Xử lý offline (banner "Offline").

## 6. Server chính (MAIN viết sẵn — subagent KHỐNG can thiệp)
`server/index.js`: http server, static `web/`, mount routes trên, SSE hub broadcast toàn cục, PORT env mặc định **8787**.

## 8. MCP thật & plugin behavior thật (v1.3 — registry Luau/LSP, 100% thật)

- **10/10 MCP servers là THẬT** (`real:true`, `transport:'stdio'`), registry chuyên Luau + LSP:
  `luau-lsp` (bundled, autoStart, featured) · `lsp-universal` (autoStart) · `lsp-bridge` ·
  `roblox-executor` (git-clone GitLab + build) · `roblox-studio` · `roblox-studio-weppy` ·
  `mcp-filesystem` (autoStart) · `mcp-git` · `mcp-memory` · `mcp-sequential-thinking`.
  Placeholder `{workspace}` trong args → thư mục `workspace/` tuyệt đối. `install.method` nhận `bundled` | `git-clone` | `npx`.
- Gate tool: chỉ tool **chỉ-đọc** trong `SAFE_TOOL_RX` chạy ngay (mọi `luau_*`, `lsp_definition|references|hover|diagnostics|health|init`, `read_file|list_directory|directory_tree|get_file_info|search_files`, `git_status|log|show|diff*`, `read_graph|search_nodes|open_nodes`, `system_info|scene_overview|describe_instance|find_instances|query_instances`); tool ghi/thực thi yêu cầu `approved:true`.
- Skill step `type:'tool'` không còn đòi `transport==='builtin'`: executor tìm server theo `tools`/`toolPreview` chứa tên tool rồi tự connect nếu chưa bật.
- **10/10 plugins có behavior thật** (field `behavior` + `behaviorLabel`): preInvoke — validate-required, defaults-fill, trim-strings, rate-limit, snapshot-args, redact-input; postInvoke — redact-output, clip-output, flatten-error, annotate-meta. Behavior ném lỗi ở pre-invoke → short-circuit không gọi transport.
- Chat & Workspace render **markdown** an toàn (web/js/md.js: escape-first, code block có Copy, link chỉ http(s)).

## 8b. Terminal tự động (v1.2)

- `GET/POST /api/terminal/sessions` · `GET/DELETE /api/terminal/:sid` · `POST /api/terminal/:sid/exec {command,via}` · `POST /api/terminal/perm/:pid/approve|deny` · `GET/PUT /api/shizuku`
- Mỗi session folder riêng `workspace/terminals/<id>` (HOME trỏ vào đó, cwd = folder); log giữ 800 dòng cuối; timeout lệnh 120s; perm hết hạn 60s.
- Phân loại lệnh: SAFE tự chạy · ASK (npm install/curl/chmod/rm/sudo/git push…) cần duyệt · BLOCK (rm -rf /, mkfs, dd, fork bomb) chặn. SSE events: `term`, `perm`.
- Shizuku: dò binary `rish` (env SHIZUKU_RISH, $PREFIX/bin, ~/.termux/shizuku/, /data/local/tmp) bằng `rish -c id`; bật thì exec via='shizuku' đi qua rish.

## 9. Chất lượng & kiểm thử
- Mỗi module tự chạy được: `node --check file` sạch; có hàm `if (import.meta.url === \`file://\${process.argv[1]}\`)` demo nhỏ khi hợp lý.
- `scripts/smoke-test.js` (MAIN): gọi toàn bộ endpoint, chạy skill, spawn agent mock, chat completion (mock + stream), verify SSE nhận ít nhất 3 loại event. Exit != 0 nếu fail.
