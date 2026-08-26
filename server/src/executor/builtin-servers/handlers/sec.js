// builtin-servers/handlers/sec.js — họ op `sec.*`: scan_ports/vuln/acl/hash (bảo mật mô phỏng).
import { int, float, pick, picks, chance, hex, agoMs, clamp, str, word, semver, titleCase } from '../util.js';

const PORT_BANK = [
  [22, 'ssh'], [80, 'http'], [443, 'https'], [3306, 'mysql'], [5432, 'postgresql'],
  [6379, 'redis'], [8080, 'http-proxy'], [9200, 'elasticsearch'], [27017, 'mongodb'], [3389, 'rdp'],
];

function severityOf(cvss) {
  if (cvss >= 9) return 'critical';
  if (cvss >= 7) return 'high';
  if (cvss >= 4) return 'medium';
  return 'low';
}

export default {
  async scan_ports(args, r) {
    const host = str(args.host ?? args.target, 'localhost');
    const requested = Array.isArray(args.ports)
      ? args.ports.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65_536)
      : [];
    const scannedPorts = requested.length ? requested : PORT_BANK.map(([p]) => p);
    const openCount = clamp(int(r, 1, 4), 1, scannedPorts.length);
    const open = picks(r, PORT_BANK.filter(([p]) => scannedPorts.includes(p)), openCount)
      .map(([port, service]) => ({ port, service, state: 'open' }));
    return {
      host,
      scannedPorts,
      open,
      closed: scannedPorts.length - open.length,
      durationMs: int(r, 700, 4200),
      scannedAtMs: agoMs(r, 0.05),
    };
  },

  async vuln_lookup(args, r) {
    const pkg = str(args.package ?? args.cve ?? args.query, 'openssl');
    const version = str(args.version, null);
    const cves = Array.from({ length: int(r, 1, 3) }, () => {
      const cvss = float(r, 3.1, 9.8, 1);
      return {
        id: `CVE-202${int(r, 1, 5)}-${int(r, 1000, 49_999)}`,
        component: pkg.split('/')[0],
        cvss,
        severity: severityOf(cvss),
        summary: `Lỗi ${pick(r, ['tràn bộ đệm', 'xác thực bỏ qua', 'SSRF', 'tiêm lệnh'])} trong module ${word(r)} của ${pkg}.`,
        fixedIn: `v${semver(r)}`,
      };
    });
    const maxCvss = cves.reduce((m, c) => Math.max(m, c.cvss), 0);
    return { package: pkg, version, cves, total: cves.length, severityMax: severityOf(maxCvss) };
  },

  async acl_check(args, r) {
    const principal = str(args.principal, 'user:anonymous');
    const resource = str(args.resource, 'vault/prod/secrets');
    const action = str(args.action ?? args.permission, 'read');
    const allowed = chance(r, 0.68);
    return {
      principal,
      resource,
      action,
      allowed,
      matchedRule: allowed ? `rule-${int(r, 3, 97)}` : null,
      reason: allowed
        ? `Vai trò của "${principal}" được cấp quyền ${action} trên "${resource}".`
        : `Không có policy nào cấp quyền ${action} trên "${resource}" cho "${principal}".`,
      evaluatedPolicies: int(r, 3, 40),
    };
  },

  async hash_verify(args, r) {
    const file = str(args.file ?? args.data, '/etc/nginx/nginx.conf');
    const algorithm = str(args.algorithm ?? args.algo, 'sha256');
    const computed = hex(r, algorithm === 'sha512' ? 128 : 64);
    const expect = str(args.expect ?? args.expected, '');
    const match = expect ? computed === expect.toLowerCase().trim() : chance(r, 0.5);
    return {
      file,
      algorithm,
      lengthHex: computed.length,
      digestPrefix: computed.slice(0, 16) + '…',
      match,
      expectedProvided: Boolean(expect),
    };
  },
};
