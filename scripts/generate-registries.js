// generate-registries.js — sinh data/mcps.json (98), data/plugins.json (143), data/skills.json (42)
// Deterministic: cùng seed → cùng output. Chạy: node scripts/generate-registries.js
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SEED = 20240826;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const range = (n) => Array.from({ length: n }, (_, i) => i);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const stars = () => Math.floor(120 + rnd() * 13800);

// ---------- MCP: định nghĩa category ----------
const ADJ = ['Nova', 'Pulse', 'Atlas', 'Vertex', 'Quantum', 'Zenith', 'Nimbus', 'Flux', 'Orbit', 'Prism',
  'Echo', 'Titan', 'Aurora', 'Cobalt', 'Drift', 'Helix', 'Lumen', 'Onyx', 'Rapid', 'Sonic'];

const schema = (props, req = []) => ({ type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, typeof v === 'string' ? { type: v, description: k } : v])), required: req });

const CATS = [
  { cat: 'filesystem', count: 8, icon: '📁', nouns: ['Vaultkeeper', 'Filebridge', 'Dirscope', 'Inodex', 'Packrat', 'Treehugger', 'Symlink', 'Archiveus'],
    tools: [
      ['fs.list_dir', 'Liệt kê nội dung thư mục.', schema({ path: 'string' }, ['path'])],
      ['fs.read_file', 'Đọc nội dung file văn bản.', schema({ path: 'string', maxBytes: 'integer' }, ['path'])],
      ['fs.write_file', 'Ghi nội dung vào file.', schema({ path: 'string', content: 'string' }, ['path', 'content'])],
      ['fs.search_files', 'Tìm file theo glob/pattern.', schema({ root: 'string', pattern: 'string' }, ['pattern'])],
      ['fs.get_info', 'Metadata file/thư mục (size, mtime).', schema({ path: 'string' }, ['path'])],
      ['fs.tree', 'Cây thư mục giới hạn độ sâu.', schema({ root: 'string', depth: 'integer' }, ['root'])]] },
  { cat: 'git', count: 6, icon: '🌿', nouns: ['Gitforge', 'Commitly', 'Branchlord', 'Diffhound', 'Mergefox', 'Rebaseon'],
    tools: [
      ['git.status', 'Trạng thái working tree.', schema({ repo: 'string' }, ['repo'])],
      ['git.log', 'Nhật ký commit gần đây.', schema({ repo: 'string', limit: 'integer' }, ['repo'])],
      ['git.diff', 'Diff giữa 2 ref.', schema({ repo: 'string', base: 'string', head: 'string' }, ['repo'])],
      ['git.branch_list', 'Danh sách nhánh + tracking.', schema({ repo: 'string' }, ['repo'])],
      ['git.commit_create', 'Tạo commit từ staged changes.', schema({ repo: 'string', message: 'string' }, ['repo', 'message'])],
      ['git.pr_summary', 'Tóm tắt pull request từ diff.', schema({ repo: 'string', pr: 'integer' }, ['repo', 'pr'])]] },
  { cat: 'web-fetch', count: 6, icon: '🌐', nouns: ['Fetchwave', 'Crawlstorm', 'Httphero', 'Linkweaver', 'Pagelift', 'Urfloader'],
    tools: [
      ['web.fetch_url', 'GET một URL trả về text/markdown.', schema({ url: 'string', format: 'string' }, ['url'])],
      ['web.extract_links', 'Trích toàn bộ link trong trang.', schema({ url: 'string' }, ['url'])],
      ['web.download_file', 'Tải file về storage tạm.', schema({ url: 'string', dest: 'string' }, ['url'])],
      ['web.http_request', 'HTTP request tuỳ ý (method/headers/body).', schema({ url: 'string', method: 'string', headers: 'object', body: 'string' }, ['url'])],
      ['web.to_markdown', 'Chuyển HTML trang thành markdown sạch.', schema({ url: 'string' }, ['url'])],
      ['web.check_status', 'Kiểm tra uptime + mã trạng thái.', schema({ url: 'string' }, ['url'])]] },
  { cat: 'browser', count: 5, icon: '🧭', nouns: ['Tabrunner', 'Clickpilot', 'Domdrill', 'Shotglass', 'Formghost'],
    tools: [
      ['browser.open_page', 'Mở URL trong phiên trình duyệt.', schema({ url: 'string' }, ['url'])],
      ['browser.click', 'Click phần tử theo selector.', schema({ selector: 'string' }, ['selector'])],
      ['browser.extract_text', 'Lấy text theo selector.', schema({ selector: 'string' }, [])],
      ['browser.screenshot', 'Chụp ảnh màn hình trang hiện tại.', schema({ fullPage: 'boolean' }, [])],
      ['browser.fill_form', 'Điền form từ map trường→giá trị.', schema({ fields: 'object' }, ['fields'])]] },
  { cat: 'database', count: 8, icon: '🗄️', nouns: ['Sqlsmith', 'Rowboat', 'Indexia', 'Queryfinch', 'Tableforge', 'Datapool', 'Shardline', 'Cursoria'],
    tools: [
      ['db.query', 'Chạy truy vấn SELECT chỉ đọc.', schema({ sql: 'string', params: 'array' }, ['sql'])],
      ['db.list_tables', 'Liệt kê bảng trong schema.', schema({ database: 'string' }, [])],
      ['db.describe_table', 'Cột, kiểu, index của bảng.', schema({ table: 'string' }, ['table'])],
      ['db.insert_row', 'Chèn 1 dòng vào bảng.', schema({ table: 'string', row: 'object' }, ['table', 'row'])],
      ['db.explain_query', 'Phân tích kế hoạch thực thi.', schema({ sql: 'string' }, ['sql'])],
      ['db.backup', 'Backup logic sang storage an toàn.', schema({ database: 'string' }, ['database'])]] },
  { cat: 'search', count: 5, icon: '🔎', nouns: ['Seekwing', 'Deepfind', 'Trendlens', 'Newshawk', 'Vectorseek'],
    tools: [
      ['search.web', 'Tìm kiếm web tổng quát.', schema({ query: 'string', limit: 'integer' }, ['query'])],
      ['search.news', 'Tin tức mới nhất theo chủ đề.', schema({ topic: 'string' }, ['topic'])],
      ['search.images', 'Tìm ảnh theo mô tả.', schema({ query: 'string' }, ['query'])],
      ['search.semantic', 'Tìm kiếm ngữ nghĩa trên corpus.', schema({ query: 'string', corpus: 'string' }, ['query'])],
      ['search.trends', 'Xu hướng tìm kiếm theo vùng.', schema({ keyword: 'string', region: 'string' }, ['keyword'])]] },
  { cat: 'ai-ml', count: 8, icon: '🧠', nouns: ['Neuronforge', 'Promptic', 'Embeddly', 'Visionix', 'Linguaflow', 'Rankwise', 'Speechpad', 'Dreamcanvas'],
    tools: [
      ['ai.generate_text', 'Sinh văn bản theo prompt.', schema({ prompt: 'string', maxTokens: 'integer' }, ['prompt'])],
      ['ai.summarize', 'Tóm tắt văn bản dài.', schema({ text: 'string', ratio: 'number' }, ['text'])],
      ['ai.classify', 'Phân loại text vào nhãn cho trước.', schema({ text: 'string', labels: 'array' }, ['text', 'labels'])],
      ['ai.embed', 'Vector embedding cho văn bản.', schema({ text: 'string' }, ['text'])],
      ['ai.translate', 'Dịch giữa các ngôn ngữ.', schema({ text: 'string', targetLang: 'string' }, ['text', 'targetLang'])],
      ['ai.image_gen', 'Sinh ảnh từ mô tả.', schema({ prompt: 'string', size: 'string' }, ['prompt'])],
      ['ai.transcribe', 'Âm thanh → văn bản.', schema({ audioUrl: 'string', lang: 'string' }, ['audioUrl'])],
      ['ai.rerank', 'Xếp lại kết quả theo relevance.', schema({ query: 'string', candidates: 'array' }, ['query', 'candidates'])]] },
  { cat: 'cloud-devops', count: 8, icon: '☁️', nouns: ['Stackpilot', 'Kubehand', 'Dockmaster', 'Pipeliner', 'Cloudwren', 'Scalecraft', 'Logtailer', 'Costlens'],
    tools: [
      ['ops.deploy', 'Triển khai service lên cluster/cloud.', schema({ service: 'string', env: 'string', version: 'string' }, ['service'])],
      ['ops.kubectl_get', 'GET tài nguyên K8s (pods/deploy/svc).', schema({ resource: 'string', namespace: 'string' }, ['resource'])],
      ['ops.docker_ps', 'Container đang chạy trên host.', schema({ host: 'string' }, [])],
      ['ops.logs_tail', 'Xem N dòng log cuối của service.', schema({ service: 'string', lines: 'integer' }, ['service'])],
      ['ops.pipeline_run', 'Kích hoạt CI pipeline.', schema({ project: 'string', branch: 'string' }, ['project'])],
      ['ops.scale_service', 'Thay đổi số replica.', schema({ service: 'string', replicas: 'integer' }, ['service', 'replicas'])],
      ['ops.cost_report', 'Báo cáo chi phí cloud theo dịch vụ.', schema({ period: 'string' }, [])],
      ['ops.dns_lookup', 'Tra cứu DNS records.', schema({ domain: 'string', type: 'string' }, ['domain'])]] },
  { cat: 'communication', count: 6, icon: '💬', nouns: ['Slackbridge', 'Mailpigeon', 'Chatrelay', 'Invitekit', 'Broadcastly', 'Pingmate'],
    tools: [
      ['msg.send_channel', 'Gửi tin nhắn vào kênh nhóm.', schema({ channel: 'string', text: 'string' }, ['channel', 'text'])],
      ['msg.send_email', 'Gửi email đơn giản.', schema({ to: 'string', subject: 'string', body: 'string' }, ['to', 'subject'])],
      ['msg.fetch_inbox', 'Đọc thư chưa đọc gần đây.', schema({ limit: 'integer' }, [])],
      ['msg.create_invite', 'Tạo lời mời họp/nhóm.', schema({ title: 'string', when: 'string' }, ['title'])],
      ['msg.broadcast', 'Gửi thông báo tới nhiều kênh.', schema({ channels: 'array', text: 'string' }, ['channels', 'text'])],
      ['msg.send_dm', 'Gửi tin nhắn trực tiếp.', schema({ user: 'string', text: 'string' }, ['user', 'text'])]] },
  { cat: 'productivity', count: 6, icon: '✅', nouns: ['Taskhawk', 'Calendove', 'Docmint', 'Sheetglide', 'Noteflux', 'Boardly'],
    tools: [
      ['prod.create_task', 'Tạo việc mới trong board.', schema({ title: 'string', due: 'string', assignee: 'string' }, ['title'])],
      ['prod.list_tasks', 'Liệt kê việc theo trạng thái.', schema({ status: 'string' }, [])],
      ['prod.calendar_find_slot', 'Tìm slot trống trên lịch.', schema({ durationMin: 'integer', day: 'string' }, ['durationMin'])],
      ['prod.create_doc', 'Tạo tài liệu từ nội dung cho sẵn.', schema({ title: 'string', content: 'string' }, ['title'])],
      ['prod.update_sheet', 'Ghi dữ liệu vào sheet.', schema({ sheet: 'string', rows: 'array' }, ['sheet', 'rows'])],
      ['prod.summarize_thread', 'Tóm tắt chuỗi thảo luận.', schema({ threadId: 'string' }, ['threadId'])]] },
  { cat: 'media', count: 6, icon: '🎬', nouns: ['Framewright', 'Clipforge', 'Soundloom', 'Thumbly', 'Subtitlex', 'Streamkit'],
    tools: [
      ['media.transcode', 'Chuyển đổi định dạng media.', schema({ src: 'string', target: 'string' }, ['src', 'target'])],
      ['media.thumbnail', 'Sinh thumbnail từ video/ảnh.', schema({ src: 'string', at: 'string' }, ['src'])],
      ['media.metadata', 'Đọc metadata media (codec, thời lượng).', schema({ src: 'string' }, ['src'])],
      ['media.subtitle_extract', 'Trích/phụ đề từ video.', schema({ src: 'string', lang: 'string' }, ['src'])],
      ['media.playlist_curate', 'Tự tạo playlist theo vibe.', schema({ vibe: 'string', length: 'integer' }, ['vibe'])],
      ['media.normalize_audio', 'Chuẩn hoá âm lượng loạt file.', schema({ srcs: 'array' }, ['srcs'])]] },
  { cat: 'data-etl', count: 6, icon: '🔁', nouns: ['Pipeflow', 'Schemaguard', 'Columnpro', 'Datasette', 'Csvporter', 'Batchowl'],
    tools: [
      ['etl.run_pipeline', 'Chạy pipeline ETL định nghĩa.', schema({ pipeline: 'string', dryRun: 'boolean' }, ['pipeline'])],
      ['etl.validate_schema', 'Kiểm dataset chống schema.', schema({ dataset: 'string', schemaRef: 'string' }, ['dataset'])],
      ['etl.profile_column', 'Thống kê phân bố 1 cột.', schema({ dataset: 'string', column: 'string' }, ['dataset', 'column'])],
      ['etl.diff_datasets', 'So sánh 2 dataset theo khoá.', schema({ left: 'string', right: 'string', key: 'string' }, ['left', 'right'])],
      ['etl.export_csv', 'Export kết quả ra CSV.', schema({ query: 'string', dest: 'string' }, ['query'])],
      ['etl.schedule_job', 'Đặt lịch chạy job lặp.', schema({ job: 'string', cron: 'string' }, ['job', 'cron'])]] },
  { cat: 'blockchain', count: 4, icon: '⛓️', nouns: ['Chainwatch', 'Blockport', 'Tokenlens', 'Gasgauge'],
    tools: [
      ['chain.get_balance', 'Số dư ví trên mạng chỉ định.', schema({ address: 'string', network: 'string' }, ['address'])],
      ['chain.send_tx', 'Ký & gửi giao dịch (cần approved).', schema({ to: 'string', amount: 'string' }, ['to', 'amount'])],
      ['chain.nft_metadata', 'Metadata NFT theo contract+id.', schema({ contract: 'string', tokenId: 'string' }, ['contract'])],
      ['chain.gas_price', 'Giá gas hiện tại của mạng.', schema({ network: 'string' }, [])]] },
  { cat: 'finance', count: 4, icon: '📈', nouns: ['Tickertape', 'Ledgerly', 'Coinwatch', 'Expensefit'],
    tools: [
      ['fin.quote', 'Báo giá realtime cho mã.', schema({ symbol: 'string' }, ['symbol'])],
      ['fin.portfolio_summary', 'Tổng quan danh mục + P/L.', schema({ account: 'string' }, [])],
      ['fin.fx_rate', 'Tỷ giá 2 đồng tiền.', schema({ from: 'string', to: 'string' }, ['from', 'to'])],
      ['fin.expense_categorize', 'Phân loại chi tiêu tự động.', schema({ transactions: 'array' }, ['transactions'])]] },
  { cat: 'maps-geo', count: 4, icon: '🗺️', nouns: ['Pinpoint', 'Routewing', 'Geofence', 'Placefinder'],
    tools: [
      ['geo.geocode', 'Địa chỉ → toạ độ.', schema({ address: 'string' }, ['address'])],
      ['geo.route', 'Lộ trình 2 điểm + phương tiện.', schema({ from: 'string', to: 'string', mode: 'string' }, ['from', 'to'])],
      ['geo.distance_matrix', 'Ma trận khoảng cách nhiều điểm.', schema({ origins: 'array', destinations: 'array' }, ['origins'])],
      ['geo.poi_search', 'Tìm địa điểm quanh toạ độ.', schema({ lat: 'number', lng: 'number', kind: 'string' }, ['lat', 'lng'])]] },
  { cat: 'iot', count: 4, icon: '🏠', nouns: ['Homely', 'Switchbee', 'Sensorhive', 'Sceneforge'],
    tools: [
      ['iot.device_list', 'Liệt kê thiết bị trong nhà thông minh.', schema({ room: 'string' }, [])],
      ['iot.toggle_device', 'Bật/tắt thiết bị.', schema({ device: 'string', on: 'boolean' }, ['device', 'on'])],
      ['iot.sensor_read', 'Đọc cảm biến (nhiệt, chuyển động…).', schema({ device: 'string' }, ['device'])],
      ['iot.scene_activate', 'Kích hoạt kịch bản ánh sáng/điều hoà.', schema({ scene: 'string' }, ['scene'])]] },
  { cat: 'security', count: 4, icon: '🛡️', nouns: ['Portsentinel', 'Vulncan', 'Hashguard', 'Aclsentry'],
    tools: [
      ['sec.scan_ports', 'Quét cổng mở trên host (mạng được phép).', schema({ host: 'string', ports: 'array' }, ['host'])],
      ['sec.vuln_lookup', 'Tra CVE theo gói/phiên bản.', schema({ package: 'string', version: 'string' }, ['package'])],
      ['sec.hash_verify', 'So khớp hash checksum.', schema({ file: 'string', expect: 'string' }, ['file', 'expect'])],
      ['sec.acl_check', 'Kiểm tra quyền truy cập tài nguyên.', schema({ principal: 'string', resource: 'string' }, ['principal', 'resource'])]] },
];

const AUTHORS = ['upio labs', 'mcp-contrib', 'openstack-collective', 'hexbyte.io', 'nova-tools', 'community'];

export function buildMcps() {
  const items = []; const seen = new Set();
  for (const c of CATS) {
    for (const i of range(c.count)) {
      const noun = c.nouns[i % c.nouns.length];
      const adj = pick(ADJ);
      const base = i < c.nouns.length ? noun : `${noun} ${adj}`;
      let id = slug(`${c.cat}-${base}`); let k = 2;
      while (seen.has(id)) id = slug(`${c.cat}-${base}-${k++}`);
      seen.add(id);
      const tCount = 3 + Math.floor(rnd() * 4); // 3..6 tools
      const shuffled = [...c.tools].sort(() => rnd() - 0.5).slice(0, tCount);
      const tools = shuffled.map(([name, description, inputSchema]) => ({
        name, description, op: name.split('.')[0] === name ? name : name,
        inputSchema,
      }));
      items.push({
        id, name: base, category: c.cat, icon: c.icon,
        description: `${base} — MCP server ${c.cat} cung cấp ${tools.length} công cụ (${tools.map(t => t.name.split('.')[1]).join(', ')}).`,
        version: `${1 + Math.floor(rnd() * 3)}.${Math.floor(rnd() * 10)}.${Math.floor(rnd() * 10)}`,
        author: pick(AUTHORS),
        transport: 'builtin', // mặc định builtin để chạy offline; stdio/http khi người dùng cấu hình
        tags: [c.cat, 'mcp', 'upio'],
        stars: stars(),
        tools,
      });
    }
  }
  return items;
}

// ---------- Plugins ----------
const PCATS = [
  ['automation', 18, '⚡', ['auto-', 'flow-', 'zap-', 'trigger-'], ['preInvoke', 'onConnect'], ['net']],
  ['devtools', 18, '🛠️', ['dev-', 'lint-', 'trace-', 'build-'], ['preInvoke', 'postInvoke'], ['shell']],
  ['ai', 16, '🤖', ['ai-', 'llm-', 'prompt-', 'vector-'], ['preInvoke'], ['model']],
  ['web', 14, '🌍', ['web-', 'seo-', 'scraper-', 'cdn-'], ['postInvoke'], ['net']],
  ['media', 12, '🎨', ['img-', 'vid-', 'audio-', 'thumb-'], ['postInvoke'], []],
  ['system', 14, '🖥️', ['sys-', 'proc-', 'cron-', 'disk-'], ['onLog', 'preInvoke'], ['shell', 'fs.write']],
  ['data', 12, '📊', ['csv-', 'json-', 'sql-', 'chart-'], ['postInvoke'], ['fs.read']],
  ['security', 10, '🔐', ['guard-', 'redact-', 'acl-', 'audit-'], ['preInvoke', 'postInvoke'], ['secrets']],
  ['productivity', 12, '📋', ['task-', 'note-', 'mail-', 'cal-'], ['onSkillStep'], []],
  ['networking', 9, '🔌', ['proxy-', 'dns-', 'tls-', 'rate-'], ['preInvoke'], ['net']],
  ['text', 8, '📝', ['i18n-', 'regex-', 'diff-', 'md-'], ['postInvoke'], []],
];
const PSUFFIX = ['sentinel', 'booster', 'wizard', 'copilot', 'guardian', 'turbo', 'insight', 'sync', 'metrics', 'kit', 'plus', 'relay'];
const PDESC = {
  automation: 'Tự động hoá luồng gọi tool theo điều kiện/lịch.',
  devtools: 'Hỗ trợ dev: bám trace, đo thời gian, cảnh báo bất thường.',
  ai: 'Tăng cường bằng AI ngay trong pipeline executor.',
  web: 'Xử lý nội dung web trước/sau khi gọi tool.',
  media: 'Biến đổi và tối ưu media đầu ra.',
  system: 'Quan sát & quản lý hệ thống nơi executor chạy.',
  data: 'Chuyển đổi dữ liệu qua lại giữa các tool.',
  security: 'Che giấu dữ liệu nhạy cảm và kiểm soát quyền.',
  productivity: 'Kết nối tool call với công việc hằng ngày.',
  networking: 'Kiểm soát lưu lượng và giới hạn mạng.',
  text: 'Tiện ích xử lý văn bản mạnh tay.',
};
export function buildPlugins() {
  const items = []; const seen = new Set();
  for (const [cat, count, icon, prefixes, hooks, perms] of PCATS) {
    for (const i of range(count)) {
      const name = `${pick(prefixes)}${pick(PSUFFIX)}-${i + 1}`;
      let id = slug(name); let k = 2;
      while (seen.has(id)) id = slug(`${name}-${k++}`);
      seen.add(id);
      const hookSet = [...hooks]; if (rnd() > 0.55) hookSet.push('onLog');
      items.push({
        id, name: name.replace(/(^|-)([a-z])/g, (m, p, ch) => p + ch.toUpperCase()).replace(/-/g, ' '),
        category: cat, icon,
        version: `1.${Math.floor(rnd() * 9)}.${Math.floor(rnd() * 10)}`,
        description: PDESC[cat],
        permissions: perms.length ? [...perms, ...(rnd() > 0.6 ? ['net'] : [])] : [],
        hooks: hookSet.sort(),
        enabled: false,
        popularity: Math.floor(rnd() * 100),
      });
    }
  }
  return items;
}

// ---------- Skills ----------
const SKILLS = [
  ['code-review', '🔍', 'Review code theo checklist: đúng đắn, bảo mật, hiệu năng.', [['repo', 'URL/repo cần review', 'https://github.com/upio/mcp-executor']],
    [['note', 'Thu thập context repo'], ['tool', null, null, 'git.status', {}], ['tool', null, null, 'git.diff', { base: 'main', head: 'HEAD' }], ['model', 'Bạn là reviewer cao cấp. Dựa trên diff và quan sát dưới đây, liệt kê vấn đề theo mức nghiêm trọng (blocker/warn/nit) với gợi ý sửa cụ thể.\n\nTASK REVIEW: {input.repo}\n{observations}']]],
  ['repo-summarize', '📚', 'Tổng quan kiến trúc + cách chạy một repo lạ.', [['repo', 'Repo cần tóm tắt', '.']],
    [['tool', null, null, 'fs.tree', { depth: 3 }], ['tool', null, null, 'fs.search_files', { pattern: 'README*' }], ['model', 'Từ cây thư mục và README dưới đây, viết: (1) repo này làm gì, (2) kiến trúc chính, (3) cách chạy/dev/test, (4) rủi ro khi đóng góp.\n\n{observations}']]],
  ['api-smoke-test', '🚬', 'Kiểm khói API public: status, latency, schema phản hồi.', [['baseUrl', 'Base URL của API', 'https://api.example.com']],
    [['tool', null, null, 'web.check_status', {}], ['tool', null, null, 'web.http_request', { method: 'GET' }], ['model', 'Tổng hợp kết quả kiểm khói API {input.baseUrl}: bảng endpoint→status→latency, nhận xét anyomalies, đề xuất 3 test tự động hoá.\n\n{observations}']]],
  ['changelog-gen', '📜', 'Soạn changelog đẹp từ git log tuần.', [['repo', 'Repo', '.']],
    [['tool', null, null, 'git.log', { limit: 30 }], ['model', 'Nhóm commits thành Features/Fixes/Breaking/Docs theo Keep a Changelog, giọng văn hướng tới user cuối.\n\n{observations}']]],
  ['bug-triage', '🐛', 'Phân loại lỗi vừa đến: mức ưu tiên + người phụ trách.', [['title', 'Tên lỗi', 'Crash khi upload ảnh lớn']],
    [['model', 'Phân loại bug "{input.title}": severity, area khả dĩ, câu hỏi cần hỏi reporter, repro tối thiểu.'], ['tool', null, null, 'prod.create_task', {}], ['note', 'Đã tạo task theo dõi']]],
  ['incident-brief', '🚨', 'Brief sự cố cho on-call trong 60 giây.', [['service', 'Service gặp sự cố', 'checkout-api']],
    [['tool', null, null, 'ops.logs_tail', { lines: 50 }], ['tool', null, null, 'ops.kubectl_get', { resource: 'pods' }], ['model', 'Viết incident brief: timeline, triệu chứng, giả thuyết gốc rễ (xếp hạng), hành động tiếp theo.\n\n{observations}']]],
  ['doc-writer', '✍️', 'Viết tài liệu README/API từ source hiện có.', [['topic', 'Chủ đề tài liệu', 'Getting started']],
    [['tool', null, null, 'fs.read_file', { path: 'README.md' }], ['model', 'Viết tài liệu dạng markdown cho "{input.topic}" dựa trên ngữ liệu; có mục TL;DR, ví dụ copy-chạy-ngay, FAQ.\n\n{observations}']]],
  ['sql-explain', '🧮', 'Phân tích & tối ưu câu SQL chậm.', [['sql', 'Câu SQL', 'SELECT * FROM orders WHERE created_at > now() - interval \'7 days\'']],
    [['tool', null, null, 'db.explain_query', {}], ['model', 'Giải thích kế hoạch thực thi, chỉ ra full-scan/index thiếu, viết lại SQL tối ưu + đề xuất index DDL.\n\n{observations}']]],
  ['log-analyzer', '🧾', 'Rà log tìm pattern lỗi và đề xuất fix.', [['lines', 'Số dòng log quét', '200']],
    [['tool', null, null, 'ops.logs_tail', {}], ['model', 'Nhóm lỗi theo signature, ước lượng tần suất, đánh dấu anomaly, đề xuất action mỗi nhóm.\n\n{observations}']]],
  ['release-notes', '🏷️', 'Release notes thân thiện người dùng từ diff.', [['version', 'Phiên bản phát hành', 'v1.2.0']],
    [['tool', null, null, 'git.log', { limit: 40 }], ['model', 'Soạn release notes {input.version}: highlights 3 bullet, chi tiết theo nhóm, credit contributors.\n\n{observations}']]],
  ['test-gap-analysis', '🕳️', 'Tìm khoảng trống test từ cấu trúc repo.', [['path', 'Thư mục source', 'src/']],
    [['tool', null, null, 'fs.tree', { depth: 2 }], ['model', 'Liệt kê module rủi ro nhất chưa có test, đề xuất test case ưu tiên (given/when/then).\n\n{observations}']]],
  ['dep-audit', '🔐', 'Audit phụ thuộc: CVE + license.', [['manifest', 'File manifest', 'package.json']],
    [['tool', null, null, 'fs.read_file', { path: 'package.json' }], ['tool', null, null, 'sec.vuln_lookup', {}], ['model', 'Bảng dependency→risk→fix version, tổng kết license rủi ro.\n\n{observations}']]],
  ['perf-profile-plan', '⏱️', 'Kế hoạch profile hiệu năng một service.', [['service', 'Service', 'web-api']],
    [['model', 'Lập kế hoạch profile {input.service}: metric cần thu, tool (flame/cgroup/db), kịch bản load, tiêu chí cải thiện.'], ['tool', null, null, 'ops.logs_tail', { lines: 20 }]]],
  ['seo-content-brief', '📝', 'Brief bài SEO chuẩn E-E-A-T.', [['keyword', 'Từ khóa chính', 'mcp executor mobile']],
    [['tool', null, null, 'search.web', { limit: 5 }], ['model', 'Từ SERP giả lập, viết brief: H2/H3, intent, entity cần nhắc, internal link gợi ý.\n\n{observations}']]],
  ['data-quality-check', '🧪', 'Kiểm chất lượng dataset trước khi train/báo cáo.', [['dataset', 'Tên dataset', 'orders_2024']],
    [['tool', null, null, 'etl.validate_schema', {}], ['tool', null, null, 'etl.profile_column', { column: 'amount' }], ['model', 'Báo cáo chất lượng: missing/outlier/leakage, verdict dùng được hay không.\n\n{observations}']]],
  ['etl-rehearsal', '🎭', 'Diễn tập pipeline ETL dry-run.', [['pipeline', 'Pipeline', 'nightly-sync']],
    [['tool', null, null, 'etl.run_pipeline', { dryRun: true }], ['model', 'Đánh giá dry-run: khối lượng, rủi ro idempotency, điểm cắt nếu fail giữa chừng.\n\n{observations}']]],
  ['alert-triage', '🔔', 'Xử lý đống alert: gộp, im lặng, leo thang.', [['window', 'Cửa sổ thời gian', 'last 1h']],
    [['tool', null, null, 'ops.logs_tail', { lines: 80 }], ['model', 'Gộp alert theo nguyên nhân, đề xuất silence nào hợp lệ, cái nào phải escalate ngay.\n\n{observations}']]],
  ['ux-copy-review', '💬', 'Rà soát UX copy sản phẩm.', [['screen', 'Màn hình', 'onboarding']],
    [['model', 'Review copy màn hình {input.screen}: rõ ràng, đúng voice&tone, đề xuất 3 biến thể A/B.'], ['tool', null, null, 'prod.create_task', {}]]],
  ['meeting-notes-to-tasks', '📌', 'Biên bản họp → danh sách task có owner.', [['notes', 'Biên bản thô', '...dán biên bản vào đây...']],
    [['model', 'Trích quyết định + action item (owner, deadline) từ biên bản.'], ['tool', null, null, 'prod.create_task', {}], ['note', 'Task đã đồng bộ lên board']]],
  ['inbox-zero-plan', '📬', 'Kế hoạch dọn hộp thư đến 15 phút.', [['limit', 'Số mail quét', '20']],
    [['tool', null, null, 'msg.fetch_inbox', {}], ['model', 'Phân loại: trả ngay/hoãn/hủy đăng ký; soạn reply mẫu cho nhóm trả ngay.\n\n{observations}']]],
  ['social-calendar', '🗓️', 'Lịch nội dung mạng xã hội 2 tuần.', [['brand', 'Thương hiệu', 'upio']],
    [['model', 'Tạo lịch 14 ngày cho {input.brand}: theme, caption, hashtag, giờ đăng tối ưu.'], ['tool', null, null, 'msg.broadcast', {}]]],
  ['market-pulse', '📡', 'Nhận tín hiệu thị trường theo từ khóa.', [['keyword', 'Lĩnh vực', 'AI agents']],
    [['tool', null, null, 'search.news', {}], ['tool', null, null, 'search.trends', {}], ['model', 'Tổng hợp pulse: 5 tín hiệu đáng chú ý, cơ hội/rủi ro, khuyến nghị theo dõi.\n\n{observations}']]],
  ['portfolio-report', '💼', 'Báo cáo danh mục đầu tư định kỳ.', [['account', 'Tài khoản', 'main']],
    [['tool', null, null, 'fin.portfolio_summary', {}], ['tool', null, null, 'fin.quote', { symbol: 'BTC-USD' }], ['model', 'Viết báo cáo: allocation, P/L, drift so với mục tiêu, 3 hành động.\n\n{observations}']]],
  ['expense-categorize', '🧾', 'Phân loại chi tiêu & tìm mục lạ.', [['txs', 'Số giao dịch', '30']],
    [['tool', null, null, 'fin.expense_categorize', {}], ['model', 'Nhóm chi tiêu, phát hiện giao dịch bất thường, ngân sách đề xuất tháng sau.\n\n{observations}']]],
  ['geo-route-plan', '🚗', 'Lập lộ trình đa điểm tiết kiệm nhất.', [['stops', 'Các điểm dừng', 'Nhà, Văn phòng, Siêu thị']],
    [['tool', null, null, 'geo.route', { mode: 'driving' }], ['model', 'Trình tự tối ưu, ETA từng chặng, phương án dự phòng trời mưa.\n\n{observations}']]],
  ['smart-home-scene', '🌙', 'Thiết kế kịch bản nhà thông minh buổi tối.', [['scene', 'Tên kịch bản', 'movie-night']],
    [['tool', null, null, 'iot.device_list', {}], ['tool', null, null, 'iot.scene_activate', {}], ['model', 'Mô tả trạng thái từng thiết bị trong kịch bản và điều kiện kích hoạt.\n\n{observations}']]],
  ['media-transcode-plan', '🎞️', 'Kế hoạch chuyển mã loạt video cho mobile.', [['folder', 'Thư mục nguồn', '/media/raw']],
    [['tool', null, null, 'media.metadata', {}], ['model', 'Bảng file→preset phù hợp mobile (codec/bitrate/resolution), ước lượng dung lượng sau chuyển.\n\n{observations}']]],
  ['backup-drill', '💾', 'Diễn tập khôi phục backup an toàn.', [['database', 'Database', 'prod-core']],
    [['tool', null, null, 'db.backup', {}], ['model', 'Checklist drill restore: RTO/RPO mục tiêu, bước verify integrity, rollback.\n\n{observations}']]],
  ['secret-rotation-checkup', '🔄', 'Kiểm tra lịch xoay secrets.', [['scope', 'Phạm vi', 'all services']],
    [['tool', null, null, 'sec.acl_check', {}], ['model', 'Bảng secret→tuổi→việc cần xoay, thứ tự xoay an toàn không downtime.\n\n{observations}']]],
  ['threat-model-lite', '🎯', 'Threat modeling nhanh cho feature mới.', [['feature', 'Feature', 'mobile login']],
    [['model', 'STRIPPED-down STRIDE: asset, mối đe dọa top-5, control đề xuất, mức ưu tiên.'], ['tool', null, null, 'sec.vuln_lookup', {}]]],
  ['compliance-checklist', '📋', 'Checklist tuân thủ GDPR/ISO cho dự án nhỏ.', [['project', 'Dự án', 'upio harness']],
    [['model', 'Checklist theo nhóm: dữ liệu cá nhân, retention, DPIA cần hay không, bằng chứng cần lưu.'], ['note', 'Có thể export PDF từ kết quả']]],
  ['prompt-lab', '🧪', 'Thí nghiệm biến thể prompt cho một nhiệm vụ.', [['goal', 'Nhiệm vụ', 'tóm tắt cuộc họp']],
    [['model', 'Sinh 5 biến thể prompt cho goal "{input.goal}", mỗi biến thể kèm trade-off và rubric chấm.'], ['tool', null, null, 'ai.generate_text', {}]]],
  ['model-eval-harness', '📐', 'Thiết kế bộ đánh giá model nội bộ.', [['usecase', 'Use case', 'support bot']],
    [['model', 'Thiết kế eval: tập ca thử, metric (accuracy/latency/cost), quy trình chấm, ngưỡng hồi quy.'], ['tool', null, null, 'ai.classify', {}]]],
  ['agent-debrief', '🧑‍✈️', 'Rút kinh nghiệm sau mỗi lần agent chạy dài.', [['agentRun', 'Run cần debrief', 'ag-last']],
    [['model', 'Debrief: quyết định nào tốn token vô ích, tool nên thêm, policy cần siết.'], ['note', 'Áp dụng cho lần chạy sau']]],
  ['knowledge-distill', '💧', 'Nén tài liệu dài thành flashcard học nhanh.', [['topic', 'Chủ đề', 'MCP protocol']],
    [['tool', null, null, 'ai.summarize', {}], ['model', 'Tạo 10 flashcard Q/A + 1 sơ đồ chữ về {input.topic}.\n\n{observations}']]],
  ['weekly-digest', '📰', 'Digest cá nhân cuối tuần.', [['interests', 'Sở thích', 'devtools, AI, mobile']],
    [['tool', null, null, 'search.news', {}], ['model', 'Chọn 7 món đáng đọc cho người thích {input.interests}, 1 câu vì sao đáng đọc mỗi món.\n\n{observations}']]],
  ['idea-backlog-triage', '🗂️', 'Sàng lọc backlog ý tưởng theo impact/effort.', [['count', 'Số idea', '12']],
    [['model', 'Chấm impact/effort thang 1-5 cho {input.count} idea mẫu, xuất ma trận prioritize.'], ['tool', null, null, 'prod.update_sheet', {}]]],
  ['sprint-planner', '🏃', 'Lập kế hoạch sprint từ backlog.', [['capacity', 'Điểm capacity', '24']],
    [['tool', null, null, 'prod.list_tasks', {}], ['model', 'Chọn scope sprint theo capacity {input.capacity}, nêu rủi ro cam kết và thứ tự ưu tiên.\n\n{observations}']]],
  ['retro-analyzer', '🔄', 'Phân tích retrospective đội nhóm.', [['notes', 'Notes retro', '...']],
    [['model', 'Nhóm nhận xét theo theme, phát hiện pattern 3 kỳ liên tiếp, 1 thí nghiệm cải thiện cho sprint tới.'], ['tool', null, null, 'prod.create_task', {}]]],
  ['interview-prep', '🎤', 'Chuẩn bị phỏng vấn kỹ thuật theo JD.', [['role', 'Vị trí', 'Senior Backend (Node.js)']],
    [['model', 'Sinh 12 câu hỏi theo độ sâu cho "{input.role}" + gợi ý trả lời STAR và code talk-through.'], ['tool', null, null, 'ai.generate_text', {}]]],
  ['env-doctor', '🩺', 'Khám môi trường máy & tư vấn sửa.', [],
    [['note', 'Quét hệ thống qua EnvBuilder'], ['model', 'Bạn là SRE: đọc scan report dưới đây, xếp ưu tiên việc sửa môi trường, lệnh cụ thể từng bước.\n\n{observations}']]],
];

export function buildSkills() {
  return SKILLS.map(([id, icon, description, inputs, steps]) => ({
    id, name: id.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join(' '),
    description, icon,
    tags: [steps.some(s => s[0] === 'model') ? 'ai' : 'ops', steps.some(s => s[0] === 'tool') ? 'tools' : 'prompt'],
    inputs: inputs.map(([key, label, placeholder]) => ({ key, label, placeholder })),
    steps: steps.map(([type, prompt, server, tool, argsTemplate]) => type === 'model'
      ? { type, prompt }
      : type === 'tool' ? { type, tool, argsTemplate: argsTemplate ?? {} }
      : { type }),
  }));
}

// ---------- main ----------
const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL:', msg); process.exit(1); } };

const mcps = buildMcps();
const plugins = buildPlugins();
const skills = buildSkills();

assert(mcps.length === 98, `mcps = ${mcps.length}, cần 98`);
assert(plugins.length === 143, `plugins = ${plugins.length}, cần 143`);
assert(new Set(mcps.map(x => x.id)).size === 98, 'trùng id mcps');
assert(new Set(plugins.map(x => x.id)).size === 143, 'trùng id plugins');
assert(new Set(skills.map(x => x.id)).size === skills.length, 'trùng id skills');

await mkdir(DATA, { recursive: true });
const stamp = new Date().toISOString();
await Promise.all([
  writeFile(path.join(DATA, 'mcps.json'), JSON.stringify({ generatedAt: stamp, version: 1, total: mcps.length, items: mcps }, null, 1)),
  writeFile(path.join(DATA, 'plugins.json'), JSON.stringify({ generatedAt: stamp, version: 1, total: plugins.length, items: plugins }, null, 1)),
  writeFile(path.join(DATA, 'skills.json'), JSON.stringify({ generatedAt: stamp, version: 1, total: skills.length, items: skills }, null, 1)),
]);
console.log(`✔ mcps=${mcps.length} plugins=${plugins.length} skills=${skills.length} → data/*.json`);
console.log('  sample:', mcps[0].id, '|', mcps[49].id, '|', mcps[97].id);
