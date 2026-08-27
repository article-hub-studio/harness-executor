// generate-registries.js — sinh data/mcps.json, data/plugins.json, data/skills.json
// PHIÊN BẢN LUAU/LSP: KHÔNG còn MCP mô phỏng. Mọi MCP đều là server THẬT (stdio),
// mọi plugin đều có behavior THẬT, mọi skill gọi tool THẬT của các server đó.
// Chạy: node scripts/generate-registries.js
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

/* ==========================================================================
   1. MCP SERVERS — tất cả THẬT, tất cả xoay quanh Luau + LSP
   Mỗi server đã được probe handshake thật (initialize → tools/list) trước khi
   đưa vào đây; `toolPreview` là tên tool có thật do server báo về.
   ========================================================================== */
const MCPS = [
  {
    id: 'luau-lsp', name: 'Luau Language Server', category: 'luau', icon: 'solar/cpu',
    description: 'MCP server Luau chính của harness: bọc binary luau-lsp thật để type-check, lint, hover, jump-to-definition, document symbols và require-graph. Không mô phỏng — mọi chẩn đoán do trình biên dịch Luau trả về.',
    version: '1.0.0', author: 'harness (bundled)', transport: 'stdio', real: true,
    featured: true, autoStart: true,
    install: { method: 'bundled', dir: 'server/mcp/luau-mcp', entry: 'index.js', note: 'đi kèm harness; cần binary luau-lsp (tự dùng npx nếu thiếu)' },
    command: 'node', args: ['server/mcp/luau-mcp/index.js'],
    tags: ['luau', 'lsp', 'type-check', 'lint', 'bundled', 'real'], stars: 0,
    tools: [], dynamicTools: true,
    toolPreview: ['luau_analyze', 'luau_check_source', 'luau_require_graph', 'luau_document_symbols',
      'luau_hover', 'luau_definition', 'luau_lint_rules', 'luau_version'],
    docs: 'https://github.com/JohnnyMorganz/luau-lsp',
  },
  {
    id: 'lsp-universal', name: 'LSP Universal (multi-language)', category: 'lsp', icon: 'solar/search',
    description: 'Bridge MCP ↔ Language Server Protocol cho 14 ngôn ngữ (TypeScript, Python, Rust, Go, C/C++, Java, Kotlin, Swift…): definition, references, diagnostics, rename, code action, formatting qua LSP thật.',
    version: '1.3.2', author: '@theupsider', transport: 'stdio', real: true, autoStart: true,
    install: { method: 'npx', package: '@theupsider/lsp-mcp' },
    command: 'npx', args: ['-y', '@theupsider/lsp-mcp'],
    tags: ['lsp', 'multi-language', 'diagnostics', 'refactor', 'real'], stars: 0,
    tools: [], dynamicTools: true,
    toolPreview: ['lsp_init', 'lsp_definition', 'lsp_references', 'lsp_document_symbols',
      'lsp_workspace_symbols', 'lsp_diagnostics', 'lsp_type_definition', 'lsp_implementation',
      'lsp_health', 'lsp_rename', 'lsp_code_action', 'lsp_formatting', 'lsp_range_formatting'],
    docs: 'https://www.npmjs.com/package/@theupsider/lsp-mcp',
  },
  {
    id: 'lsp-bridge', name: 'LSP Bridge (29 tools)', category: 'lsp', icon: 'blade/adjust',
    description: 'Bridge LSP đầy đủ nhất: thêm hover, signature help, completions, file exports/imports, related files, workspace diagnostics — dùng khi cần đọc hiểu codebase sâu.',
    version: '1.1.20', author: 'ProfessioneIT', transport: 'stdio', real: true,
    install: { method: 'npx', package: 'lsp-mcp-server' },
    command: 'npx', args: ['-y', 'lsp-mcp-server'],
    tags: ['lsp', 'hover', 'completions', 'navigation', 'real'], stars: 0,
    tools: [], dynamicTools: true,
    toolPreview: ['lsp_goto_definition', 'lsp_goto_type_definition', 'lsp_find_references',
      'lsp_find_implementations', 'lsp_hover', 'lsp_signature_help', 'lsp_document_symbols',
      'lsp_workspace_symbols', 'lsp_file_exports', 'lsp_file_imports', 'lsp_related_files',
      'lsp_diagnostics', 'lsp_workspace_diagnostics', 'lsp_completions', 'lsp_rename', 'lsp_code_actions'],
    docs: 'https://github.com/ProfessioneIT/lsp-mcp-server',
  },
  {
    id: 'roblox-executor', name: 'Roblox Executor MCP (upio)', category: 'luau', icon: 'blade/bolt',
    description: 'MCP server của upio: execute Luau trong Roblox client thật, đọc script content, script-grep, search instances, remote spy, GUI automation, screenshot.',
    version: '1.0.0', author: 'upio', transport: 'stdio', real: true, featured: true,
    install: { method: 'git-clone', repo: 'https://gitlab.com/upio/roblox-executor-mcp.git', dir: 'mcp-servers/roblox-executor-mcp', entry: 'dist/index.js', build: 'npm install --ignore-scripts && npm run build' },
    command: 'node', args: ['mcp-servers/roblox-executor-mcp/dist/index.js'],
    tags: ['luau', 'roblox', 'executor', 'upio', 'real'], stars: 0,
    tools: [], dynamicTools: true,
    toolPreview: ['execute', 'execute-file', 'get-script-content', 'script-grep', 'search-instances',
      'remote-spy', 'type-text-box', 'click-button', 'screenshot-window', 'list-clients'],
    docs: 'https://gitlab.com/upio/roblox-executor-mcp',
  },
  {
    id: 'roblox-studio', name: 'Roblox Studio MCP', category: 'luau', icon: 'solar/house',
    description: 'Điều khiển Roblox Studio: execute_luau trong session thật, query/mutate DataModel, scene overview, describe instance, sync script ra file — cần plugin Studio đang mở.',
    version: '1.0.51', author: 'PeerapolSelanon', transport: 'stdio', real: true,
    install: { method: 'npx', package: 'roblox-mcp-pro' },
    command: 'npx', args: ['-y', 'roblox-mcp-pro'],
    tags: ['luau', 'roblox', 'studio', 'datamodel', 'real'], stars: 0,
    tools: [], dynamicTools: true,
    toolPreview: ['system_info', 'execute_luau', 'query_instances', 'mutate_instances',
      'scene_overview', 'find_instances', 'describe_instance', 'manage_sync', 'capture_studio'],
    docs: 'https://github.com/PeerapolSelanon/roblox-mcp-pro',
  },
  {
    id: 'roblox-studio-weppy', name: 'Roblox Studio MCP (Weppy)', category: 'luau', icon: 'solar/puzzle',
    description: 'Bộ điều khiển Studio thay thế: manage_scripts (đọc/ghi/validate Luau), manage_ui, lighting, selection, camera, tween, physics, terrain — 25 tool nhóm theo action.',
    version: '2.14.6', author: 'hope1026', transport: 'stdio', real: true,
    install: { method: 'npx', package: '@weppy/roblox-mcp' },
    command: 'npx', args: ['-y', '@weppy/roblox-mcp'],
    tags: ['luau', 'roblox', 'studio', 'scripts', 'real'], stars: 0,
    tools: [], dynamicTools: true,
    toolPreview: ['query_instances', 'mutate_instances', 'manage_properties', 'manage_scripts',
      'manage_ui', 'manage_selection', 'manage_camera', 'manage_lighting'],
    docs: 'https://github.com/hope1026/weppy-roblox-mcp',
  },
  {
    id: 'mcp-filesystem', name: 'Filesystem (official)', category: 'workspace', icon: 'solar/folder',
    description: 'Reference server chính chủ Anthropic: đọc/ghi/tìm file thật trong workspace — nền tảng cho mọi skill Luau/LSP cần mở file trước khi phân tích.',
    version: '2026.7.10', author: 'Anthropic (official)', transport: 'stdio', real: true, autoStart: true,
    install: { method: 'npx', package: '@modelcontextprotocol/server-filesystem' },
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{workspace}'],
    tags: ['workspace', 'files', 'official', 'real'], stars: 0,
    tools: [], dynamicTools: true,
    toolPreview: ['read_file', 'write_file', 'list_directory', 'search_files', 'get_file_info', 'directory_tree'],
    docs: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'mcp-git', name: 'Git (official)', category: 'workspace', icon: 'solar/branch',
    description: 'Reference server chính chủ: status, diff, log, blame trên repo Luau thật — để review thay đổi trước khi chạy phân tích LSP.',
    version: '2026.7.4', author: 'Anthropic (official)', transport: 'stdio', real: true,
    install: { method: 'npx', package: '@modelcontextprotocol/server-git' },
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-git', '--repository', '{workspace}'],
    tags: ['workspace', 'git', 'official', 'real'], stars: 0,
    tools: [], dynamicTools: true,
    toolPreview: ['git_status', 'git_diff_unstaged', 'git_diff_staged', 'git_log', 'git_show'],
    docs: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'mcp-memory', name: 'Memory (official)', category: 'workspace', icon: 'solar/database',
    description: 'Knowledge graph memory chính chủ: lưu ký hiệu/kiểu/quyết định kiến trúc Luau đã tra được để agent không phải phân tích lại.',
    version: '2026.7.4', author: 'Anthropic (official)', transport: 'stdio', real: true,
    install: { method: 'npx', package: '@modelcontextprotocol/server-memory' },
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
    tags: ['workspace', 'memory', 'official', 'real'], stars: 0,
    tools: [], dynamicTools: true,
    toolPreview: ['create_entities', 'create_relations', 'add_observations', 'search_nodes', 'read_graph'],
    docs: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    id: 'mcp-sequential-thinking', name: 'Sequential Thinking (official)', category: 'workspace', icon: 'solar/link',
    description: 'Suy luận nhiều bước có nhánh/sửa đổi — dùng khi lần theo lỗi kiểu Luau qua nhiều module.',
    version: '2026.7.4', author: 'Anthropic (official)', transport: 'stdio', real: true,
    install: { method: 'npx', package: '@modelcontextprotocol/server-sequential-thinking' },
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    tags: ['workspace', 'reasoning', 'official', 'real'], stars: 0,
    tools: [], dynamicTools: true, toolPreview: ['sequentialthinking'],
    docs: 'https://github.com/modelcontextprotocol/servers',
  },
];

/* ==========================================================================
   2. PLUGINS — mọi plugin có behavior THẬT (chạy trong pipeline invoke)
   behavior phải nằm trong BEHAVIORS của server/src/executor/plugin-behaviors.js
   ========================================================================== */
const BEHAVIOR_LABELS = {
  'validate-required': 'Kiểm tra tham số bắt buộc',
  'defaults-fill': 'Điền giá trị mặc định',
  'trim-strings': 'Chuẩn hoá chuỗi',
  'rate-limit': 'Giới hạn tần suất',
  'snapshot-args': 'Chụp ảnh args',
  'redact-input': 'Che dữ liệu nhạy cảm (input)',
  'redact-output': 'Che dữ liệu nhạy cảm (output)',
  'clip-output': 'Cắt ngắn kết quả lớn',
  'flatten-error': 'Chuẩn hoá lỗi',
  'annotate-meta': 'Ghi chú meta',
};
const BEHAVIOR_HOOK = {
  'validate-required': 'preInvoke', 'defaults-fill': 'preInvoke', 'trim-strings': 'preInvoke',
  'rate-limit': 'preInvoke', 'snapshot-args': 'preInvoke', 'redact-input': 'preInvoke',
  'redact-output': 'postInvoke', 'clip-output': 'postInvoke', 'flatten-error': 'postInvoke',
  'annotate-meta': 'postInvoke',
};

const PLUGINS = [
  ['luau-arg-guard', 'Luau Arg Guard', 'luau', 'solar/shield', 'validate-required',
    'Chặn gọi tool Luau/LSP khi thiếu tham số bắt buộc (file, line, character) — báo lỗi ngay thay vì để language server trả lỗi mơ hồ.', []],
  ['luau-path-normalizer', 'Luau Path Normalizer', 'luau', 'solar/wrench', 'trim-strings',
    'Cắt khoảng trắng thừa quanh đường dẫn và tên symbol trước khi gửi sang LSP — tránh "file not found" do copy-paste.', []],
  ['lsp-defaults', 'LSP Defaults', 'lsp', 'blade/adjust', 'defaults-fill',
    'Điền mặc định hợp lý cho tool LSP (platform=standard, depth, mode) để gọi tool nhanh mà vẫn đúng.', []],
  ['lsp-diag-clipper', 'LSP Diagnostics Clipper', 'lsp', 'blade/filter', 'clip-output',
    'Cắt ngắn output chẩn đoán khổng lồ (workspace diagnostics cả repo) xuống mức đọc được trên mobile.', []],
  ['lsp-error-normalizer', 'LSP Error Normalizer', 'lsp', 'blade/warn', 'flatten-error',
    'Chuẩn hoá lỗi từ nhiều language server khác nhau về một dạng thống nhất, dễ đọc.', []],
  ['lsp-trace-meta', 'LSP Trace Meta', 'lsp', 'blade/list', 'annotate-meta',
    'Ghi chú thời gian, server, tool vào meta mỗi lần gọi — để đo language server nào chậm.', ['fs.read']],
  ['luau-call-throttle', 'Luau Call Throttle', 'luau', 'solar/clock', 'rate-limit',
    'Giới hạn tần suất gọi mỗi tool — chống spam luau-lsp khi agent lặp vòng.', ['net']],
  ['luau-args-recorder', 'Luau Args Recorder', 'workspace', 'blade/copy', 'snapshot-args',
    'Lưu ảnh chụp tham số mỗi lần gọi tool để tái hiện lại chính xác lỗi khi debug agent.', ['fs.write']],
  ['roblox-secret-guard', 'Roblox Secret Guard', 'security', 'solar/lock', 'redact-input',
    'Che cookie .ROBLOSECURITY, API key và token trong tham số TRƯỚC khi rời máy — bảo vệ tài khoản Roblox.', ['secrets']],
  ['roblox-output-redactor', 'Roblox Output Redactor', 'security', 'blade/eyeoff', 'redact-output',
    'Che chuỗi nhạy cảm trong kết quả trả về (log Studio, script content có token) trước khi hiện lên UI.', ['secrets']],
];

/* ==========================================================================
   3. SKILLS — pipeline thật, mỗi step 'tool' trỏ tới tool có thật ở trên
   ========================================================================== */
const SKILLS = [
  ['luau-type-audit', 'solar/search', 'Type-check toàn bộ project Luau rồi xếp lỗi theo mức nghiêm trọng.',
    [['path', 'File hoặc thư mục Luau', 'workspace']],
    [['tool', null, 'luau-lsp', 'luau_analyze', { path: '{input.path}' }],
      ['model', 'Bạn là chuyên gia Luau. Từ output luau-lsp analyze dưới đây, nhóm chẩn đoán theo mức (blocker/warning/nit), giải thích nguyên nhân từng nhóm và viết cách sửa cụ thể kèm ví dụ code.\n\nĐƯỜNG DẪN: {input.path}\n{observations}']]],

  ['luau-snippet-review', 'blade/adjust', 'Dán một đoạn Luau → kiểm tra kiểu thật + review chất lượng.',
    [['source', 'Đoạn code Luau', '--!strict\nlocal function add(a: number, b: number): number\n\treturn a + b\nend\n\nprint(add("x", 2))']],
    [['tool', null, 'luau-lsp', 'luau_check_source', { source: '{input.source}', filename: 'review.luau' }],
      ['model', 'Dựa trên chẩn đoán THẬT của luau-lsp dưới đây, viết review: (1) lỗi kiểu và cách sửa, (2) rủi ro runtime, (3) bản viết lại sạch hơn có type annotation đầy đủ.\n\n{observations}']]],

  ['luau-symbol-map', 'solar/pin', 'Lập bản đồ symbol + require-graph của project Luau.',
    [['path', 'Thư mục project', 'workspace'], ['file', 'File chính', 'workspace/init.luau']],
    [['tool', null, 'luau-lsp', 'luau_require_graph', { path: '{input.path}' }],
      ['tool', null, 'luau-lsp', 'luau_document_symbols', { file: '{input.file}', root: '{input.path}' }],
      ['model', 'Từ require-graph và danh sách symbol thật dưới đây, mô tả kiến trúc module: ai phụ thuộc ai, module nào là hub, chỗ nào có nguy cơ circular require, đề xuất tách module.\n\n{observations}']]],

  ['luau-hover-explain', 'blade/sparkles', 'Giải thích kiểu tại một vị trí con trỏ bằng hover thật.',
    [['file', 'File Luau', 'workspace/init.luau'], ['line', 'Dòng', '1'], ['character', 'Cột', '1']],
    [['tool', null, 'luau-lsp', 'luau_hover', { file: '{input.file}', line: '{input.line}', character: '{input.character}' }],
      ['tool', null, 'luau-lsp', 'luau_definition', { file: '{input.file}', line: '{input.line}', character: '{input.character}' }],
      ['model', 'Giải thích cho người mới: kiểu này nghĩa là gì, nó đến từ đâu (theo definition thật), dùng sai kiểu nào hay gặp.\n\n{observations}']]],

  ['lsp-workspace-health', 'solar/activity', 'Khám sức khoẻ codebase qua LSP: diagnostics toàn workspace.',
    [['root', 'Thư mục gốc project', 'workspace']],
    [['tool', null, 'lsp-universal', 'lsp_init', { root: '{input.root}' }],
      ['tool', null, 'lsp-universal', 'lsp_health', {}],
      ['tool', null, 'lsp-universal', 'lsp_diagnostics', {}],
      ['model', 'Từ trạng thái language server và diagnostics THẬT dưới đây, viết báo cáo sức khoẻ: số lỗi/cảnh báo theo file, 5 việc cần sửa trước, ngôn ngữ nào chưa có LSP nên cài thêm.\n\n{observations}']]],

  ['lsp-symbol-hunt', 'blade/filter', 'Truy tìm một symbol khắp codebase: định nghĩa + mọi nơi dùng.',
    [['root', 'Thư mục gốc', 'workspace'], ['query', 'Tên symbol cần tìm', 'main']],
    [['tool', null, 'lsp-universal', 'lsp_init', { root: '{input.root}' }],
      ['tool', null, 'lsp-universal', 'lsp_workspace_symbols', { query: '{input.query}' }],
      ['model', 'Tổng hợp: symbol "{input.query}" được định nghĩa ở đâu, các biến thể trùng tên, gợi ý đổi tên an toàn nếu cần.\n\n{observations}']]],

  ['lsp-refactor-plan', 'solar/wrench', 'Lập kế hoạch refactor an toàn dựa trên references thật.',
    [['file', 'File cần refactor', 'workspace/init.luau'], ['line', 'Dòng symbol', '1'], ['character', 'Cột symbol', '1'], ['root', 'Thư mục gốc', 'workspace']],
    [['tool', null, 'lsp-universal', 'lsp_init', { root: '{input.root}' }],
      ['tool', null, 'lsp-universal', 'lsp_references', { file: '{input.file}', line: '{input.line}', character: '{input.character}' }],
      ['tool', null, 'lsp-universal', 'lsp_code_action', { file: '{input.file}', line: '{input.line}', character: '{input.character}' }],
      ['model', 'Dựa trên danh sách references THẬT và code action khả dụng, lập kế hoạch refactor từng bước, nêu rủi ro breaking và thứ tự sửa file an toàn.\n\n{observations}']]],

  ['lsp-api-surface', 'blade/send', 'Trích bề mặt API công khai của một file (exports/imports thật).',
    [['file', 'File cần soi', 'workspace/init.luau']],
    [['tool', null, 'lsp-bridge', 'lsp_file_exports', { file_path: '{input.file}' }],
      ['tool', null, 'lsp-bridge', 'lsp_file_imports', { file_path: '{input.file}' }],
      ['model', 'Viết tài liệu API cho file này: mỗi export gồm chữ ký, mục đích, ví dụ dùng; liệt kê dependency và cảnh báo coupling.\n\n{observations}']]],

  ['roblox-script-audit', 'blade/bolt', 'Rà toàn bộ script trong Roblox client rồi đánh giá rủi ro.',
    [['pattern', 'Từ khoá script-grep', 'HttpService']],
    [['tool', null, 'roblox-executor', 'list-clients', {}],
      ['tool', null, 'roblox-executor', 'script-grep', { pattern: '{input.pattern}' }],
      ['model', 'Từ danh sách client và kết quả grep THẬT, đánh giá: script nào rủi ro (remote không kiểm tra, HttpService lộ key), thứ tự cần sửa, snippet Luau vá lỗi.\n\n{observations}']]],

  ['roblox-studio-inspect', 'solar/house', 'Chụp toàn cảnh DataModel Studio và soi cấu trúc game.',
    [['instance', 'Đường dẫn instance', 'game.Workspace']],
    [['tool', null, 'roblox-studio', 'system_info', {}],
      ['tool', null, 'roblox-studio', 'scene_overview', {}],
      ['model', 'Dựa vào scene overview THẬT: mô tả cấu trúc game, chỉ ra thứ đặt sai chỗ (script trong ReplicatedStorage vs ServerScriptService), đề xuất dọn dẹp.\n\n{observations}']]],

  ['luau-lint-config', 'solar/settings', 'Đọc FFlag/rule Luau đang bật rồi đề xuất cấu hình lint.',
    [['filter', 'Lọc theo tên flag (rỗng = tất cả)', 'Luau']],
    [['tool', null, 'luau-lsp', 'luau_lint_rules', { filter: '{input.filter}' }],
      ['tool', null, 'luau-lsp', 'luau_version', {}],
      ['model', 'Từ danh sách flag THẬT, đề xuất file .luaurc + luau-lsp settings cho project production: rule nào bật, rule nào tắt, vì sao.\n\n{observations}']]],

  ['workspace-luau-scan', 'solar/folder', 'Quét workspace tìm file Luau rồi type-check hàng loạt.',
    [['dir', 'Thư mục cần quét', 'workspace']],
    [['tool', null, 'mcp-filesystem', 'search_files', { path: '{input.dir}', pattern: '*.luau' }],
      ['tool', null, 'luau-lsp', 'luau_analyze', { path: '{input.dir}' }],
      ['model', 'Kết hợp danh sách file thật và chẩn đoán thật: bảng file → số lỗi → mức ưu tiên sửa, kèm nhận định về chất lượng tổng thể project.\n\n{observations}']]],

  ['env-doctor', 'solar/activity', 'Khám môi trường máy (Node, luau-lsp, LSP đã cài) và tư vấn sửa.',
    [],
    [['tool', null, 'luau-lsp', 'luau_version', {}],
      ['model', 'Bạn là SRE. Từ thông tin môi trường THẬT dưới đây, liệt kê việc cần làm để môi trường Luau/LSP hoàn chỉnh: binary còn thiếu, lệnh cài cụ thể cho Termux/Linux, thứ tự ưu tiên.\n\n{observations}']]],
];

/* ==========================================================================
   builders
   ========================================================================== */
export function buildMcps() {
  return MCPS.map((m) => ({ ...m }));
}

export function buildPlugins() {
  return PLUGINS.map(([id, name, category, icon, behavior, description, permissions]) => {
    const hook = BEHAVIOR_HOOK[behavior];
    if (!hook) throw new Error(`behavior không hợp lệ: ${behavior}`);
    return {
      id, name, category, icon,
      version: '1.0.0',
      description,
      permissions: permissions ?? [],
      hooks: [hook],
      enabled: false,
      popularity: 0,
      behavior,
      behaviorLabel: BEHAVIOR_LABELS[behavior],
    };
  });
}

export function buildSkills() {
  return SKILLS.map(([id, icon, description, inputs, steps]) => ({
    id,
    name: id.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join(' '),
    description, icon,
    tags: [
      steps.some((s) => s[0] === 'model') ? 'ai' : 'ops',
      steps.some((s) => s[0] === 'tool') ? 'tools' : 'prompt',
      id.startsWith('luau') ? 'luau' : id.startsWith('lsp') ? 'lsp' : id.startsWith('roblox') ? 'roblox' : 'workspace',
    ],
    inputs: inputs.map(([key, label, placeholder]) => ({ key, label, placeholder })),
    steps: steps.map(([type, prompt, server, tool, argsTemplate]) => type === 'model'
      ? { type, prompt }
      : type === 'tool' ? { type, server, tool, argsTemplate: argsTemplate ?? {} }
        : { type }),
  }));
}

/* ==========================================================================
   main + assert tính toàn vẹn
   ========================================================================== */
const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL:', msg); process.exit(1); } };

const mcps = buildMcps();
const plugins = buildPlugins();
const skills = buildSkills();

assert(mcps.length === MCPS.length, 'số mcps sai');
assert(mcps.every((m) => m.real === true), 'CÓ MCP KHÔNG PHẢI THẬT — phiên bản này chỉ nhận server thật');
assert(mcps.every((m) => m.transport === 'stdio'), 'mọi MCP phải là stdio');
assert(new Set(mcps.map((x) => x.id)).size === mcps.length, 'trùng id mcps');
assert(plugins.every((p) => p.behavior), 'CÓ PLUGIN KHÔNG CÓ BEHAVIOR THẬT');
assert(new Set(plugins.map((x) => x.id)).size === plugins.length, 'trùng id plugins');
assert(new Set(skills.map((x) => x.id)).size === skills.length, 'trùng id skills');

// mọi step 'tool' của skill phải trỏ tới server có thật + tool nằm trong toolPreview
const byId = new Map(mcps.map((m) => [m.id, m]));
for (const s of skills) {
  for (const st of s.steps) {
    if (st.type !== 'tool') continue;
    assert(st.server && byId.has(st.server), `skill ${s.id}: server '${st.server}' không tồn tại`);
    const prev = byId.get(st.server).toolPreview ?? [];
    assert(prev.includes(st.tool), `skill ${s.id}: tool '${st.tool}' không có trong toolPreview của ${st.server}`);
  }
}

await mkdir(DATA, { recursive: true });
const stamp = new Date().toISOString();
await Promise.all([
  writeFile(path.join(DATA, 'mcps.json'), JSON.stringify({ generatedAt: stamp, version: 2, total: mcps.length, items: mcps }, null, 1)),
  writeFile(path.join(DATA, 'plugins.json'), JSON.stringify({ generatedAt: stamp, version: 2, total: plugins.length, items: plugins }, null, 1)),
  writeFile(path.join(DATA, 'skills.json'), JSON.stringify({ generatedAt: stamp, version: 2, total: skills.length, items: skills }, null, 1)),
]);
console.log(`✔ mcps=${mcps.length} (100% thật) plugins=${plugins.length} (100% có behavior) skills=${skills.length} → data/*.json`);
console.log('  autoStart:', mcps.filter((m) => m.autoStart).map((m) => m.id).join(', '));
